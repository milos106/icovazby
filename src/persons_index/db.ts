// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SQLite backend pro persons_index. Nahrazuje předchozí JSON file.
 *
 * Důvody migrace:
 *   • 15 MB JSON začínalo bolet (cold start parse ~150ms, plný rewrite
 *     při každém flushi)
 *   • Reverse holding scan vyžadoval O(n) procházení v RAM
 *   • Bez SQL nešlo multi-instance, multi-tenant ani concurrent writes
 *
 * Schema je 1:1 mapping z předchozí JSON struktury, ne hluboký redesign.
 * Cílem je drop-in nahrazení existujícího store.ts API.
 *
 * better-sqlite3 = synchronní, in-process. ACID, WAL. Single file v
 * ARES_WEB_DATA_DIR/persons-index.sqlite.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database, { type Database as DbType } from "better-sqlite3";

const DEFAULT_DATA_DIR = "./data";
const FILE_NAME = "persons-index.sqlite";

let db: DbType | null = null;

function dbPath(): string {
  const dir = process.env.ARES_WEB_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
  return resolve(dir, FILE_NAME);
}

export function getDb(): DbType {
  if (db) return db;
  const path = dbPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return db;
}

function initSchema(d: DbType): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      ico TEXT PRIMARY KEY,
      obchodni_jmeno TEXT,
      seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subjects_seen_at ON subjects(seen_at DESC);

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
    CREATE INDEX IF NOT EXISTS idx_memberships_person ON memberships(person_key);
    CREATE INDEX IF NOT EXISTS idx_memberships_ico ON memberships(ico);

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
    CREATE INDEX IF NOT EXISTS idx_ownership_parent ON ownership(parent_ico);
    CREATE INDEX IF NOT EXISTS idx_ownership_child ON ownership(child_ico);

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
    CREATE INDEX IF NOT EXISTS idx_memberships_tentative_key ON memberships_tentative(tentative_key);

    -- R16 Audit log: záznam každého data-relevantního dotazu pro AML compliance
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      ip TEXT,
      action TEXT NOT NULL,
      target_ico TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_ico ON audit_log(target_ico);

    -- ÚPV ochranné známky (otevřená data ST.96)
    -- ÚPV neposkytuje IČO ani street adresu → fuzzy match podle
    -- applicant_name_normalized + applicant_city. Datasource: ~300k záznamů,
    -- 89% PO (s OrganizationStandardName), 11% jen FO (anonymizováno).
    CREATE TABLE IF NOT EXISTS upv_trademarks (
      application_number TEXT PRIMARY KEY,
      application_date TEXT,
      status_code TEXT,                    -- ST.96 MarkCurrentStatusCode
      mark_category TEXT,                  -- "Individual mark" / "Collective" / "Certification"
      mark_feature TEXT,                   -- "Word" / "Figurative" / "Combined" / "3D" / "Sound"
      mark_text TEXT,                      -- MarkSignificantVerbalElementText (cs)
      applicant_type TEXT NOT NULL,        -- 'PO' (legal entity) or 'FO' (natural person, anonymized)
      applicant_name TEXT,                 -- OrganizationStandardName nebo NULL pro FO
      applicant_name_normalized TEXT,      -- lower-case, stripped punctuation — pro fuzzy match
      applicant_city TEXT,                 -- jen CityName (street/PSČ ÚPV neposkytuje)
      nice_classes TEXT,                   -- CSV: "5,9,42"
      image_file TEXT,                     -- relativní cesta k logu (.gif/.jpg), NULL pro Word marky
      source_file TEXT,                    -- který ZIP balíček (pro debug)
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_upv_applicant_norm ON upv_trademarks(applicant_name_normalized);
    CREATE INDEX IF NOT EXISTS idx_upv_status ON upv_trademarks(status_code);
    CREATE INDEX IF NOT EXISTS idx_upv_city ON upv_trademarks(applicant_city);

    -- AI auto-summary cache (Claude Haiku 4.5).
    -- TTL 7 dní per IČO — firma se v jednotkách dní rapidly nemění.
    -- Sloupec payload obsahuje JSON s celým AiSummary (incl. risks, strengths).
    CREATE TABLE IF NOT EXISTS ai_summaries (
      ico TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      model TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_summaries_generated ON ai_summaries(generated_at DESC);

    -- Datová schránka — cache lookup ID z mojedatovaschranka.cz
    -- TTL 30 dní (DS ID se mění zřídka).
    -- Pro IČO bez DS (FO/OSVČ vymazané, neexistující) ukládáme NULL s
    -- "not_found_at" abychom nehledali znovu příliš často.
    CREATE TABLE IF NOT EXISTS ds_cache (
      ico TEXT PRIMARY KEY,
      ds_id TEXT,
      jmeno TEXT,
      typ TEXT,
      adresa TEXT,
      found INTEGER NOT NULL,  -- 1 = nalezeno, 0 = not found
      checked_at INTEGER NOT NULL
    );

    -- Fáze D: uložená vyšetřovací plátna (sdílení read-only odkazem /v/<id>).
    -- state = JSON serializovaného stavu grafu (icos, egoPersons, primaryKey,
    -- graphLayer, intersectMode, includeHistorical). Malé bloby, bez TTL zatím.
    CREATE TABLE IF NOT EXISTS investigations (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_investigations_created ON investigations(created_at DESC);

    -- Persistentní L2 cache odpovědí (přežije restart) — hlavně HS endpointy
    -- (UBO, dotace, zakázky, ISIR) + DD/VR/timeline. fetched_at = timestamp pro TTL.
    -- Šetří čerpání sdíleného HS tokenu po deployi/restartu.
    CREATE TABLE IF NOT EXISTS response_cache (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_response_cache_fetched ON response_cache(fetched_at);
  `);
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export function dbAudit(input: {
  ip: string | null;
  action: string;
  targetIco: string | null;
  userAgent: string | null;
}): void {
  getDb().prepare(`
    INSERT INTO audit_log (ts, ip, action, target_ico, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(Date.now(), input.ip, input.action, input.targetIco, input.userAgent);
}

export function dbAuditQuery(opts: { since?: number; limit?: number } = {}): Array<{
  id: number;
  ts: number;
  ip: string | null;
  action: string;
  target_ico: string | null;
  user_agent: string | null;
}> {
  const since = opts.since ?? 0;
  const limit = Math.min(opts.limit ?? 1000, 10000);
  return getDb().prepare(`
    SELECT id, ts, ip, action, target_ico, user_agent
    FROM audit_log
    WHERE ts >= ?
    ORDER BY ts DESC
    LIMIT ?
  `).all(since, limit) as Array<{
    id: number;
    ts: number;
    ip: string | null;
    action: string;
    target_ico: string | null;
    user_agent: string | null;
  }>;
}

// ─── Subjects ─────────────────────────────────────────────────────────────────

export function dbUpsertSubject(ico: string, obchodniJmeno: string | null): void {
  const d = getDb();
  const key = ico.replace(/\D/g, "").padStart(8, "0");
  if (!/^\d{8}$/.test(key)) return;
  d.prepare(`
    INSERT INTO subjects (ico, obchodni_jmeno, seen_at) VALUES (?, ?, ?)
    ON CONFLICT(ico) DO UPDATE SET
      obchodni_jmeno = COALESCE(excluded.obchodni_jmeno, obchodni_jmeno),
      seen_at = excluded.seen_at
  `).run(key, obchodniJmeno, Date.now());
}

export function dbListSubjects(): Array<{ ico: string; obchodniJmeno: string | null; seenAt: number }> {
  const d = getDb();
  const rows = d.prepare(`SELECT ico, obchodni_jmeno, seen_at FROM subjects ORDER BY seen_at DESC`).all() as Array<{
    ico: string;
    obchodni_jmeno: string | null;
    seen_at: number;
  }>;
  return rows.map((r) => ({ ico: r.ico, obchodniJmeno: r.obchodni_jmeno, seenAt: r.seen_at }));
}

// ─── Investigations (Fáze D — uložená vyšetřovací plátna) ──────────────────────

export function dbSaveInvestigation(id: string, state: unknown): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO investigations (id, state, created_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET state = excluded.state, created_at = excluded.created_at
  `).run(id, JSON.stringify(state), Date.now());
}

// ─── Persistentní response cache (L2, přežije restart) ─────────────────────────

export function dbGetResponseCache(key: string, maxAgeMs: number): unknown | undefined {
  const d = getDb();
  const row = d.prepare(`SELECT payload, fetched_at FROM response_cache WHERE key = ?`).get(key) as
    | { payload: string; fetched_at: number }
    | undefined;
  if (!row) return undefined;
  if (Date.now() - row.fetched_at > maxAgeMs) return undefined; // expirováno → re-fetch
  try {
    return JSON.parse(row.payload);
  } catch {
    return undefined;
  }
}

export function dbSetResponseCache(key: string, payload: unknown): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO response_cache (key, payload, fetched_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at
  `).run(key, JSON.stringify(payload), Date.now());
}

export function dbLoadInvestigation(id: string): { state: unknown; createdAt: number } | null {
  const d = getDb();
  const row = d.prepare(`SELECT state, created_at FROM investigations WHERE id = ?`).get(id) as
    | { state: string; created_at: number }
    | undefined;
  if (!row) return null;
  try {
    return { state: JSON.parse(row.state), createdAt: row.created_at };
  } catch {
    return null;
  }
}

// ─── Persons (s DOB) ──────────────────────────────────────────────────────────

export interface DbMembership {
  ico: string;
  obchodniJmeno: string | null;
  funkce: string | null;
  organ: string | null;
  datumZapisu: string | null;
  datumVymazu: string | null;
  source: string;
  seenAt: number;
}

export interface DbPerson {
  displayName: string;
  jmeno: string;
  prijmeni: string;
  titulPred: string | null;
  datumNarozeni: string;
  memberships: DbMembership[];
}

export function dbUpsertMembership(input: {
  personKey: string;
  displayName: string;
  jmeno: string;
  prijmeni: string;
  titulPred: string | null;
  datumNarozeni: string;
  ico: string;
  obchodniJmeno: string | null;
  funkce: string | null;
  organ: string | null;
  datumZapisu: string | null;
  datumVymazu: string | null;
  source: string;
}): void {
  const d = getDb();
  const now = Date.now();
  d.prepare(`
    INSERT INTO persons (person_key, display_name, jmeno, prijmeni, titul_pred, datum_narozeni)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(person_key) DO NOTHING
  `).run(
    input.personKey,
    input.displayName,
    input.jmeno,
    input.prijmeni,
    input.titulPred,
    input.datumNarozeni,
  );
  d.prepare(`
    INSERT INTO memberships (person_key, ico, obchodni_jmeno, funkce, organ, datum_zapisu, datum_vymazu, source, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      seen_at = excluded.seen_at,
      datum_vymazu = COALESCE(excluded.datum_vymazu, datum_vymazu),
      obchodni_jmeno = COALESCE(excluded.obchodni_jmeno, obchodni_jmeno)
  `).run(
    input.personKey,
    input.ico,
    input.obchodniJmeno,
    input.funkce ?? "",
    input.organ,
    input.datumZapisu ?? "",
    input.datumVymazu,
    input.source,
    now,
  );
}

export function dbFindPerson(personKey: string): DbPerson | null {
  const d = getDb();
  const p = d.prepare(`SELECT * FROM persons WHERE person_key = ?`).get(personKey) as
    | { display_name: string; jmeno: string; prijmeni: string; titul_pred: string | null; datum_narozeni: string }
    | undefined;
  if (!p) return null;
  const memRows = d.prepare(`
    SELECT ico, obchodni_jmeno, funkce, organ, datum_zapisu, datum_vymazu, source, seen_at
    FROM memberships WHERE person_key = ?
  `).all(personKey) as Array<{
    ico: string;
    obchodni_jmeno: string | null;
    funkce: string | null;
    organ: string | null;
    datum_zapisu: string | null;
    datum_vymazu: string | null;
    source: string;
    seen_at: number;
  }>;
  return {
    displayName: p.display_name,
    jmeno: p.jmeno,
    prijmeni: p.prijmeni,
    titulPred: p.titul_pred,
    datumNarozeni: p.datum_narozeni,
    memberships: memRows.map((r) => ({
      ico: r.ico,
      obchodniJmeno: r.obchodni_jmeno,
      funkce: r.funkce,
      organ: r.organ,
      datumZapisu: r.datum_zapisu,
      datumVymazu: r.datum_vymazu,
      source: r.source,
      seenAt: r.seen_at,
    })),
  };
}

// ─── Ownership ────────────────────────────────────────────────────────────────

export function dbUpsertOwnership(input: {
  childIco: string;
  parentIco: string;
  validFrom: string | null;
  validTo: string | null;
  source: string;
}): void {
  const d = getDb();
  const child = input.childIco.replace(/\D/g, "").padStart(8, "0");
  const parent = input.parentIco.replace(/\D/g, "").padStart(8, "0");
  if (!/^\d{8}$/.test(child) || !/^\d{8}$/.test(parent) || child === parent) return;
  d.prepare(`
    INSERT INTO ownership (parent_ico, child_ico, valid_from, valid_to, source, seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      seen_at = excluded.seen_at,
      valid_to = COALESCE(excluded.valid_to, valid_to)
  `).run(parent, child, input.validFrom ?? "", input.validTo, input.source, Date.now());
}

export function dbGetChildrenByParent(parentIco: string, includeHistorical: boolean): string[] {
  const d = getDb();
  const parent = parentIco.replace(/\D/g, "").padStart(8, "0");
  const sql = includeHistorical
    ? `SELECT DISTINCT child_ico FROM ownership WHERE parent_ico = ?`
    : `SELECT DISTINCT child_ico FROM ownership WHERE parent_ico = ? AND valid_to IS NULL`;
  const rows = d.prepare(sql).all(parent) as Array<{ child_ico: string }>;
  return rows.map((r) => r.child_ico);
}

export function dbGetOwnershipDetails(parentIco: string, includeHistorical: boolean): Array<{
  childIco: string;
  parentIco: string;
  validFrom: string | null;
  validTo: string | null;
  source: string;
  seenAt: number;
}> {
  const d = getDb();
  const parent = parentIco.replace(/\D/g, "").padStart(8, "0");
  const sql = includeHistorical
    ? `SELECT * FROM ownership WHERE parent_ico = ?`
    : `SELECT * FROM ownership WHERE parent_ico = ? AND valid_to IS NULL`;
  const rows = d.prepare(sql).all(parent) as Array<{
    parent_ico: string;
    child_ico: string;
    valid_from: string | null;
    valid_to: string | null;
    source: string;
    seen_at: number;
  }>;
  return rows.map((r) => ({
    parentIco: r.parent_ico,
    childIco: r.child_ico,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    source: r.source,
    seenAt: r.seen_at,
  }));
}

// ─── Tentative (bez DOB) ──────────────────────────────────────────────────────

export interface DbTentativePerson {
  displayName: string;
  jmeno: string;
  prijmeni: string;
  memberships: DbMembership[];
}

export function dbUpsertTentativeMembership(input: {
  tentativeKey: string;
  displayName: string;
  jmeno: string;
  prijmeni: string;
  ico: string;
  obchodniJmeno: string | null;
  funkce: string | null;
  organ: string | null;
  datumZapisu: string | null;
  datumVymazu: string | null;
  source: string;
}): void {
  const d = getDb();
  const now = Date.now();
  d.prepare(`
    INSERT INTO persons_tentative (tentative_key, display_name, jmeno, prijmeni)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tentative_key) DO NOTHING
  `).run(input.tentativeKey, input.displayName, input.jmeno, input.prijmeni);
  d.prepare(`
    INSERT INTO memberships_tentative (tentative_key, ico, obchodni_jmeno, funkce, organ, datum_zapisu, datum_vymazu, source, seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      seen_at = excluded.seen_at,
      datum_vymazu = COALESCE(excluded.datum_vymazu, datum_vymazu),
      obchodni_jmeno = COALESCE(excluded.obchodni_jmeno, obchodni_jmeno)
  `).run(
    input.tentativeKey,
    input.ico,
    input.obchodniJmeno,
    input.funkce ?? "",
    input.organ,
    input.datumZapisu ?? "",
    input.datumVymazu,
    input.source,
    now,
  );
}

export function dbFindTentative(tentativeKey: string): DbTentativePerson | null {
  const d = getDb();
  const p = d.prepare(`SELECT * FROM persons_tentative WHERE tentative_key = ?`).get(tentativeKey) as
    | { display_name: string; jmeno: string; prijmeni: string }
    | undefined;
  if (!p) return null;
  const memRows = d.prepare(`
    SELECT ico, obchodni_jmeno, funkce, organ, datum_zapisu, datum_vymazu, source, seen_at
    FROM memberships_tentative WHERE tentative_key = ?
  `).all(tentativeKey) as Array<{
    ico: string;
    obchodni_jmeno: string | null;
    funkce: string | null;
    organ: string | null;
    datum_zapisu: string | null;
    datum_vymazu: string | null;
    source: string;
    seen_at: number;
  }>;
  return {
    displayName: p.display_name,
    jmeno: p.jmeno,
    prijmeni: p.prijmeni,
    memberships: memRows.map((r) => ({
      ico: r.ico,
      obchodniJmeno: r.obchodni_jmeno,
      funkce: r.funkce,
      organ: r.organ,
      datumZapisu: r.datum_zapisu,
      datumVymazu: r.datum_vymazu,
      source: r.source,
      seenAt: r.seen_at,
    })),
  };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export function dbStats(): {
  personsCount: number;
  membershipsCount: number;
  subjectsCount: number;
  ownershipParentsCount: number;
  ownershipEdgesCount: number;
  tentativeCount: number;
  tentativeMembershipsCount: number;
  path: string;
} {
  const d = getDb();
  const num = (sql: string) => (d.prepare(sql).get() as { c: number }).c;
  return {
    personsCount: num(`SELECT COUNT(*) AS c FROM persons`),
    membershipsCount: num(`SELECT COUNT(*) AS c FROM memberships`),
    subjectsCount: num(`SELECT COUNT(*) AS c FROM subjects`),
    ownershipParentsCount: num(`SELECT COUNT(DISTINCT parent_ico) AS c FROM ownership`),
    ownershipEdgesCount: num(`SELECT COUNT(*) AS c FROM ownership`),
    tentativeCount: num(`SELECT COUNT(*) AS c FROM persons_tentative`),
    tentativeMembershipsCount: num(`SELECT COUNT(*) AS c FROM memberships_tentative`),
    path: dbPath(),
  };
}
