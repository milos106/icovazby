// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Sdílené helpery pro drip_harvest + refresh_existing + backfill_ownership.
 *
 * Hlavní problém: tyto skripty běží jako samostatný node process, ale
 * server icovazby zapisuje do stejného persons-index.json. Race se
 * minimalizuje takto:
 *   1. Skript načte stav, něco vypočte, fetchne ARES.
 *   2. Těsně před zápisem se znovu načte aktuální stav ze souboru
 *      (server mohl mezitím zapsat) a merge se s novými daty skriptu.
 *   3. Atomic write (temp + rename) — soubor není nikdy částečně přepsaný.
 *
 * Konflikt by mohl ztratit jen několik vteřin user clickových upsertů.
 * Při SQLite migraci se to vyřeší definitivně.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DATA_DIR = process.env.ARES_WEB_DATA_DIR?.trim() || "./data";
export const INDEX_FILE = resolve(DATA_DIR, "persons-index.json");
export const ARES_BASE = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest";

export function loadIndex() {
  if (!existsSync(INDEX_FILE)) {
    return {
      version: 3,
      lastUpdated: new Date().toISOString(),
      persons: {},
      subjects: {},
      ownership: { byParent: {} },
    };
  }
  const raw = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
  raw.subjects ??= {};
  raw.persons ??= {};
  raw.ownership ??= { byParent: {} };
  return raw;
}

export function atomicWrite(data) {
  data.lastUpdated = new Date().toISOString();
  const dir = resolve(INDEX_FILE, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${INDEX_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, INDEX_FILE);
}

/**
 * Re-read fresh state ze souboru, merge new* záznamy ze skriptu do něj
 * a atomic-write. Skript volá vždy po dokončení batchu.
 */
export function mergeAndWrite(scriptState, additions) {
  const fresh = loadIndex();

  // Merge subjects: skript je autoritativní u entry kterou právě zapsal
  for (const [ico, sub] of Object.entries(additions.subjects ?? {})) {
    fresh.subjects[ico] = sub;
  }

  // Merge persons: appendovat nové memberships do existujících klíčů
  for (const [key, person] of Object.entries(additions.persons ?? {})) {
    if (!fresh.persons[key]) {
      fresh.persons[key] = person;
    } else {
      const existing = fresh.persons[key];
      const seen = new Set(
        existing.memberships.map(
          (m) => `${m.ico}|${m.funkce}|${m.source}|${m.datumZapisu ?? ""}`,
        ),
      );
      for (const m of person.memberships) {
        const sig = `${m.ico}|${m.funkce}|${m.source}|${m.datumZapisu ?? ""}`;
        if (!seen.has(sig)) existing.memberships.push(m);
      }
    }
  }

  // Merge ownership.byParent: append idempotentně podle (childIco, validFrom)
  for (const [parent, edges] of Object.entries(additions.ownership ?? {})) {
    const list = (fresh.ownership.byParent[parent] ??= []);
    for (const e of edges) {
      const exists = list.find(
        (x) => x.childIco === e.childIco && (x.validFrom ?? null) === (e.validFrom ?? null),
      );
      if (exists) {
        exists.seenAt = Date.now();
        if (e.validTo && !exists.validTo) exists.validTo = e.validTo;
      } else {
        list.push(e);
      }
    }
  }

  atomicWrite(fresh);
  return fresh;
}

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

/**
 * ARES search po `obchodniJmeno`. Když query vrací >1000 hits, ARES
 * odpoví 400 s `VYSTUP_PRILIS_MNOHO_VYSLEDKU` — vrátíme prázdné pole
 * a caller přejde na další keyword.
 *
 * Volitelně lze přidat `extraFilter` (pravniForma, czNace, sidloKodObce)
 * pro zúžení widow-keywords. Drip harvest rotuje pravniForma=112 (s.r.o.)
 * pro nejhrubší keywords.
 */
export async function searchAresByName(query, max = 100, extraFilter = {}) {
  const body = { obchodniJmeno: query, pocet: max, start: 0, ...extraFilter };
  const res = await fetch(`${ARES_BASE}/ekonomicke-subjekty/vyhledat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 400) {
    // Pravděpodobně "too many results" — neberme to jako fatal
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

/** Normalize CZ name → person index key (NFD strip + lowercase + collapse). */
export function makePersonKey(jmeno, prijmeni, datumNarozeni) {
  const norm = (s) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");
  return `${norm(jmeno)}|${norm(prijmeni)}|${datumNarozeni.slice(0, 10)}`;
}

/**
 * Extrahuj statutáry + akcionáře/společníky-PO z VR záznamu.
 * Vrátí { memberships: [...], ownership: [...] }.
 */
export function extractFromVr(vr, ico, obchodniJmeno) {
  const memberships = [];
  const ownership = [];
  if (!vr?.zaznamy) return { memberships, ownership };

  for (const zaznam of vr.zaznamy) {
    // Statutáři (fyzické osoby = jednatelé/členové DR)
    for (const organ of zaznam.statutarniOrgany ?? []) {
      for (const clen of organ.clenoveOrganu ?? []) {
        const fo = clen.fyzickaOsoba;
        if (!fo?.jmeno || !fo?.prijmeni || !fo?.datumNarozeni) continue;
        memberships.push({
          jmeno: fo.jmeno,
          prijmeni: fo.prijmeni,
          titulPred: fo.titulPredJmenem ?? null,
          datumNarozeni: fo.datumNarozeni,
          ico,
          obchodniJmeno: obchodniJmeno ?? null,
          funkce: clen.clenstvi?.funkce?.nazev ?? null,
          organ: organ.nazevOrganu ?? null,
          datumZapisu: clen.datumZapisu ?? null,
          datumVymazu: clen.datumVymazu ?? null,
        });
      }
    }
    // Akcionáři (a.s.) — vnořené bloky
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
          seenAt: Date.now(),
        });
      }
    }
    // Společníci (s.r.o.) — flat list
    for (const clen of zaznam.spolecnici ?? []) {
      const parentIco = clen.pravnickaOsoba?.ico;
      if (!parentIco || !/^\d{7,8}$/.test(parentIco)) continue;
      ownership.push({
        parentIco: parentIco.padStart(8, "0"),
        childIco: ico,
        validFrom: clen.datumZapisu ?? null,
        validTo: clen.datumVymazu ?? null,
        source: "ARES_VR_akcionari",
        seenAt: Date.now(),
      });
    }
  }
  return { memberships, ownership };
}

/** Vrátí aktuální obchodní jméno z primárního VR záznamu. */
export function currentObchodniJmeno(vr) {
  if (!vr?.zaznamy) return null;
  const primary = vr.zaznamy.find((z) => z.primarniZaznam) ?? vr.zaznamy[0];
  if (!primary?.obchodniJmeno) return null;
  for (const oj of primary.obchodniJmeno) {
    if (!oj.datumVymazu) return oj.hodnota ?? null;
  }
  return primary.obchodniJmeno[0]?.hodnota ?? null;
}

export function nowMs() {
  return Date.now();
}
