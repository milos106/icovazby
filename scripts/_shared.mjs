// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Sdílené helpery pro drip_harvest + refresh_existing + backfill_ownership.
 *
 * Od R1 (SQLite migrace): scripts píší přímo do SQLite přes better-sqlite3.
 * Žádný race s běžícím serverem — SQLite má WAL mode, multiple readers +
 * one writer současně. Server čte při dotazu, scripts příležitostně píší.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

const DATA_DIR = process.env.ARES_WEB_DATA_DIR?.trim() || "./data";
export const DB_FILE = resolve(DATA_DIR, "persons-index.sqlite");
export const ARES_BASE = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest";

let dbInstance = null;

export function getDb() {
  if (dbInstance) return dbInstance;
  const dir = dirname(DB_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  dbInstance = new Database(DB_FILE);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("synchronous = NORMAL");
  dbInstance.pragma("foreign_keys = ON");
  // Schema je vytvořeno serverem nebo migration scriptem. Pokud DB neexistuje,
  // ujišťujeme se jen že tabulky existují (no-op pokud už jsou).
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      ico TEXT PRIMARY KEY,
      obchodni_jmeno TEXT,
      seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS persons (
      person_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      jmeno TEXT NOT NULL,
      prijmeni TEXT NOT NULL,
      titul_pred TEXT,
      datum_narozeni TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_key TEXT NOT NULL,
      ico TEXT NOT NULL,
      obchodni_jmeno TEXT,
      funkce TEXT NOT NULL DEFAULT '',
      organ TEXT,
      datum_zapisu TEXT NOT NULL DEFAULT '',
      datum_vymazu TEXT,
      source TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      UNIQUE(person_key, ico, funkce, source, datum_zapisu)
    );
    CREATE TABLE IF NOT EXISTS ownership (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_ico TEXT NOT NULL,
      child_ico TEXT NOT NULL,
      valid_from TEXT NOT NULL DEFAULT '',
      valid_to TEXT,
      source TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      UNIQUE(parent_ico, child_ico, valid_from)
    );
    CREATE TABLE IF NOT EXISTS persons_tentative (
      tentative_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      jmeno TEXT NOT NULL,
      prijmeni TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memberships_tentative (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tentative_key TEXT NOT NULL,
      ico TEXT NOT NULL,
      obchodni_jmeno TEXT,
      funkce TEXT NOT NULL DEFAULT '',
      organ TEXT,
      datum_zapisu TEXT NOT NULL DEFAULT '',
      datum_vymazu TEXT,
      source TEXT NOT NULL,
      seen_at INTEGER NOT NULL,
      UNIQUE(tentative_key, ico, funkce, source, datum_zapisu)
    );
    CREATE TABLE IF NOT EXISTS upv_trademarks (
      application_number TEXT PRIMARY KEY,
      application_date TEXT,
      status_code TEXT,
      mark_category TEXT,
      mark_feature TEXT,
      mark_text TEXT,
      applicant_type TEXT NOT NULL,
      applicant_name TEXT,
      applicant_name_normalized TEXT,
      applicant_city TEXT,
      nice_classes TEXT,
      image_file TEXT,
      source_file TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_upv_applicant_norm ON upv_trademarks(applicant_name_normalized);
    CREATE INDEX IF NOT EXISTS idx_upv_status ON upv_trademarks(status_code);
    CREATE INDEX IF NOT EXISTS idx_upv_city ON upv_trademarks(applicant_city);
  `);
  return dbInstance;
}

function normalize(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function makePersonKey(jmeno, prijmeni, datumNarozeni) {
  return `${normalize(jmeno)}|${normalize(prijmeni)}|${datumNarozeni.slice(0, 10)}`;
}

function makeTentativeKey(jmeno, prijmeni) {
  return `${normalize(jmeno)}|${normalize(prijmeni)}`;
}

export { makePersonKey, makeTentativeKey };

// ─── ARES wrappers ────────────────────────────────────────────────────────────

export async function fetchAresSubject(ico) {
  const res = await fetch(`${ARES_BASE}/ekonomicke-subjekty/${ico}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ARES subj ${ico} → ${res.status}`);
  return await res.json();
}

export async function fetchAresVr(ico) {
  const res = await fetch(`${ARES_BASE}/ekonomicke-subjekty-vr/${ico}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ARES VR ${ico} → ${res.status}`);
  return await res.json();
}

export async function searchAresByName(query, max = 100, extraFilter = {}) {
  const body = { obchodniJmeno: query, pocet: max, start: 0, ...extraFilter };
  const res = await fetch(`${ARES_BASE}/ekonomicke-subjekty/vyhledat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 400) {
    const json = await res.json().catch(() => ({}));
    if (json.subKod === "VYSTUP_PRILIS_MNOHO_VYSLEDKU") {
      return { tooMany: true, results: [] };
    }
    throw new Error(`ARES search "${query}" → 400: ${json.popis ?? "neznámá chyba"}`);
  }
  if (!res.ok) throw new Error(`ARES search "${query}" → ${res.status}`);
  const json = await res.json();
  return { tooMany: false, results: json.ekonomickeSubjekty ?? [] };
}

// ─── VR extraction (statutáři + akcionáři + společníci) ──────────────────────

export function extractFromVr(vr, ico, obchodniJmeno) {
  const memberships = [];
  const tentativeMemberships = [];
  const ownership = [];
  if (!vr?.zaznamy) return { memberships, tentativeMemberships, ownership };

  for (const zaznam of vr.zaznamy) {
    for (const organ of zaznam.statutarniOrgany ?? []) {
      for (const clen of organ.clenoveOrganu ?? []) {
        const fo = clen.fyzickaOsoba;
        if (!fo?.jmeno || !fo?.prijmeni) continue;
        const base = {
          jmeno: fo.jmeno,
          prijmeni: fo.prijmeni,
          titulPred: fo.titulPredJmenem ?? null,
          ico,
          obchodniJmeno: obchodniJmeno ?? null,
          funkce: clen.clenstvi?.funkce?.nazev ?? null,
          organ: organ.nazevOrganu ?? null,
          datumZapisu: clen.datumZapisu ?? null,
          datumVymazu: clen.datumVymazu ?? null,
        };
        if (fo.datumNarozeni) {
          memberships.push({ ...base, datumNarozeni: fo.datumNarozeni });
        } else {
          tentativeMemberships.push(base);
        }
      }
    }
    for (const blok of zaznam.akcionari ?? []) {
      for (const clen of blok.clenoveOrganu ?? []) {
        const parentIco = clen.pravnickaOsoba?.ico;
        if (!parentIco || !/^\d{7,8}$/.test(parentIco)) continue;
        ownership.push({
          parentIco: parentIco.padStart(8, "0"),
          childIco: ico,
          validFrom: clen.datumZapisu ?? blok.datumZapisu ?? null,
          validTo: clen.datumVymazu ?? blok.datumVymazu ?? null,
          source: "ARES_VR_akcionari",
        });
      }
    }
    for (const clen of zaznam.spolecnici ?? []) {
      const parentIco = clen.pravnickaOsoba?.ico;
      if (!parentIco || !/^\d{7,8}$/.test(parentIco)) continue;
      ownership.push({
        parentIco: parentIco.padStart(8, "0"),
        childIco: ico,
        validFrom: clen.datumZapisu ?? null,
        validTo: clen.datumVymazu ?? null,
        source: "ARES_VR_akcionari",
      });
    }
  }
  return { memberships, tentativeMemberships, ownership };
}

export function currentObchodniJmeno(vr) {
  if (!vr?.zaznamy) return null;
  const primary = vr.zaznamy.find((z) => z.primarniZaznam) ?? vr.zaznamy[0];
  if (!primary?.obchodniJmeno) return null;
  for (const oj of primary.obchodniJmeno) {
    if (!oj.datumVymazu) return oj.hodnota ?? null;
  }
  return primary.obchodniJmeno[0]?.hodnota ?? null;
}

// ─── SQLite writers (batch-friendly) ──────────────────────────────────────────

export function upsertSubject(ico, obchodniJmeno) {
  const db = getDb();
  const key = String(ico).replace(/\D/g, "").padStart(8, "0");
  if (!/^\d{8}$/.test(key)) return;
  db.prepare(`
    INSERT INTO subjects (ico, obchodni_jmeno, seen_at) VALUES (?, ?, ?)
    ON CONFLICT(ico) DO UPDATE SET
      obchodni_jmeno = COALESCE(excluded.obchodni_jmeno, obchodni_jmeno),
      seen_at = excluded.seen_at
  `).run(key, obchodniJmeno ?? null, Date.now());
}

export function upsertMembership(m) {
  if (!m.datumNarozeni || !/^\d{4}-\d{2}-\d{2}/.test(m.datumNarozeni)) return;
  const personKey = makePersonKey(m.jmeno, m.prijmeni, m.datumNarozeni);
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO persons (person_key, display_name, jmeno, prijmeni, titul_pred, datum_narozeni)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(person_key) DO NOTHING
  `).run(
    personKey,
    `${m.jmeno} ${m.prijmeni}`,
    m.jmeno,
    m.prijmeni,
    m.titulPred ?? null,
    m.datumNarozeni.slice(0, 10),
  );
  db.prepare(`
    INSERT INTO memberships (person_key, ico, obchodni_jmeno, funkce, organ, datum_zapisu, datum_vymazu, source, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      seen_at = excluded.seen_at,
      datum_vymazu = COALESCE(excluded.datum_vymazu, datum_vymazu),
      obchodni_jmeno = COALESCE(excluded.obchodni_jmeno, obchodni_jmeno)
  `).run(
    personKey,
    m.ico,
    m.obchodniJmeno ?? null,
    m.funkce ?? "",
    m.organ ?? null,
    m.datumZapisu ?? "",
    m.datumVymazu ?? null,
    "ARES_VR",
    now,
  );
}

export function upsertTentativeMembership(m) {
  if (!m.jmeno || !m.prijmeni) return;
  const tkey = makeTentativeKey(m.jmeno, m.prijmeni);
  const db = getDb();
  const now = Date.now();
  db.prepare(`
    INSERT INTO persons_tentative (tentative_key, display_name, jmeno, prijmeni)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tentative_key) DO NOTHING
  `).run(tkey, `${m.jmeno} ${m.prijmeni}`, m.jmeno, m.prijmeni);
  db.prepare(`
    INSERT INTO memberships_tentative (tentative_key, ico, obchodni_jmeno, funkce, organ, datum_zapisu, datum_vymazu, source, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      seen_at = excluded.seen_at,
      datum_vymazu = COALESCE(excluded.datum_vymazu, datum_vymazu),
      obchodni_jmeno = COALESCE(excluded.obchodni_jmeno, obchodni_jmeno)
  `).run(
    tkey,
    m.ico,
    m.obchodniJmeno ?? null,
    m.funkce ?? "",
    m.organ ?? null,
    m.datumZapisu ?? "",
    m.datumVymazu ?? null,
    "ARES_VR",
    now,
  );
}

export function upsertOwnership(e) {
  const db = getDb();
  const child = String(e.childIco).replace(/\D/g, "").padStart(8, "0");
  const parent = String(e.parentIco).replace(/\D/g, "").padStart(8, "0");
  if (!/^\d{8}$/.test(child) || !/^\d{8}$/.test(parent) || child === parent) return;
  db.prepare(`
    INSERT INTO ownership (parent_ico, child_ico, valid_from, valid_to, source, seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      seen_at = excluded.seen_at,
      valid_to = COALESCE(excluded.valid_to, valid_to)
  `).run(parent, child, e.validFrom ?? "", e.validTo ?? null, e.source ?? "ARES_VR_akcionari", Date.now());
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

export function listAllSubjectIcos() {
  return getDb().prepare(`SELECT ico FROM subjects`).all().map((r) => r.ico);
}

export function listOrphanParents(limit = 50) {
  // Parenty v ownership.byParent kteří NEJSOU v subjects.
  return getDb().prepare(`
    SELECT DISTINCT o.parent_ico AS ico
    FROM ownership o
    LEFT JOIN subjects s ON s.ico = o.parent_ico
    WHERE s.ico IS NULL
    LIMIT ?
  `).all(limit).map((r) => r.ico);
}

export function listOldestSubjects(limit) {
  return getDb().prepare(`
    SELECT ico, obchodni_jmeno AS obchodniJmeno, seen_at AS seenAt
    FROM subjects
    ORDER BY seen_at ASC
    LIMIT ?
  `).all(limit);
}

export function stats() {
  const db = getDb();
  const num = (sql) => db.prepare(sql).get().c;
  return {
    subjectsCount: num(`SELECT COUNT(*) AS c FROM subjects`),
    personsCount: num(`SELECT COUNT(*) AS c FROM persons`),
    membershipsCount: num(`SELECT COUNT(*) AS c FROM memberships`),
    ownershipEdgesCount: num(`SELECT COUNT(*) AS c FROM ownership`),
    tentativeCount: num(`SELECT COUNT(*) AS c FROM persons_tentative`),
  };
}
