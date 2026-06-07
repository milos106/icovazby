/**
 * Lokální index osob → firmy, plněný inkrementálně.
 *
 * Pozadí: ARES, OR ani HS neumějí veřejně vyhledat „ve kterých firmách
 * osoba X seděla". Pro VIP/politiky to HS umí přes /osoby/{nameId}, ale
 * pro běžné jednatele (Petr Dubický apod.) chybí jakákoliv cesta.
 *
 * Tento modul řeší to inkrementálně: kdykoli ares-web zpracuje DD report
 * jakékoli firmy, vytáhneme všechny statutáře (ARES VR), členy
 * dozorčí rady, akcionáře (OR VR) a UBO (Hlídač státu) a uložíme je
 * do lokálního indexu osoba→firma. Postupně tak vzniká vlastní
 * vyhledávání napříč firmami, které uživatel kdy prošel.
 *
 * Persistence: jednoduchý JSON soubor v ARES_WEB_DATA_DIR (default
 * `./data/persons-index.json`). Žádné nativní deps, žádná DB.
 * Velikost: ~150 bajtů per membership, ~2 MB pro 10 000 záznamů.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface IndexedMembership {
  ico: string;
  obchodniJmeno: string | null;
  funkce: string | null;
  organ: string | null;
  datumZapisu: string | null;
  datumVymazu: string | null;
  source: "ARES_VR" | "OR_VR" | "OR_DR" | "OR_AKC" | "UBO";
  seenAt: number;
}

export interface IndexedPerson {
  displayName: string;
  jmeno: string;
  prijmeni: string;
  titulPred: string | null;
  datumNarozeni: string;
  memberships: IndexedMembership[];
}

interface IndexFile {
  version: number;
  lastUpdated: string;
  persons: Record<string, IndexedPerson>;
}

const VERSION = 1;
const DEFAULT_DATA_DIR = "./data";
const FILE_NAME = "persons-index.json";

// Debounce: writeback se odložen o 500 ms; po dvanácti rychlých
// updatech zapíšeme okamžitě. Chrání před přepisem souboru pro každý
// jednotlivý request.
const DEBOUNCE_MS = 500;
const MAX_UNFLUSHED = 12;

let memory: IndexFile = {
  version: VERSION,
  lastUpdated: new Date().toISOString(),
  persons: {},
};
let unflushed = 0;
let flushTimer: NodeJS.Timeout | null = null;
let loaded = false;

function dataPath(): string {
  const dir = process.env.ARES_WEB_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
  return resolve(dir, FILE_NAME);
}

/**
 * Normalizace klíče: lowercase + diacritics + collapse whitespace.
 * "Petr Dubický" + "1962-11-08" → "petr|dubicky|1962-11-08"
 * Klíč musí být deterministický a stabilní napříč variantami zápisu.
 */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function makeKey(jmeno: string, prijmeni: string, datumNarozeni: string): string {
  return `${normalize(jmeno)}|${normalize(prijmeni)}|${datumNarozeni}`;
}

function load(): void {
  if (loaded) return;
  try {
    const path = dataPath();
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as IndexFile;
      if (parsed?.version === VERSION && parsed.persons) {
        memory = parsed;
      }
    }
  } catch {
    // Corrupted file → start fresh; memory už má prázdný default.
  }
  loaded = true;
}

function scheduleFlush(): void {
  unflushed++;
  if (unflushed >= MAX_UNFLUSHED) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flush();
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, DEBOUNCE_MS);
}

function flush(): void {
  try {
    const path = dataPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    memory.lastUpdated = new Date().toISOString();
    writeFileSync(path, JSON.stringify(memory, null, 2), "utf-8");
    unflushed = 0;
  } catch {
    // Disk full / read-only? Lokální index je best-effort. Nevyhazujeme.
  }
}

export interface UpsertInput {
  jmeno: string;
  prijmeni: string;
  titulPred?: string | null;
  displayName?: string;
  datumNarozeni: string;
  ico: string;
  obchodniJmeno?: string | null;
  funkce?: string | null;
  organ?: string | null;
  datumZapisu?: string | null;
  datumVymazu?: string | null;
  source: IndexedMembership["source"];
}

/**
 * Vloží/aktualizuje membership záznam. Idempotentní — dva totožné
 * záznamy (stejné ico+funkce+source+datumZapisu) se merguji.
 */
export function upsertMembership(input: UpsertInput): void {
  load();
  const dob = input.datumNarozeni?.slice(0, 10);
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return;
  if (!input.jmeno && !input.prijmeni) return;
  const key = makeKey(input.jmeno, input.prijmeni, dob);
  const now = Date.now();

  let person = memory.persons[key];
  if (!person) {
    person = {
      displayName: input.displayName || `${input.titulPred ? input.titulPred + " " : ""}${input.jmeno} ${input.prijmeni}`.trim(),
      jmeno: input.jmeno,
      prijmeni: input.prijmeni,
      titulPred: input.titulPred ?? null,
      datumNarozeni: dob,
      memberships: [],
    };
    memory.persons[key] = person;
  }

  const newM: IndexedMembership = {
    ico: input.ico,
    obchodniJmeno: input.obchodniJmeno ?? null,
    funkce: input.funkce ?? null,
    organ: input.organ ?? null,
    datumZapisu: input.datumZapisu ?? null,
    datumVymazu: input.datumVymazu ?? null,
    source: input.source,
    seenAt: now,
  };
  const existing = person.memberships.find(
    (m) =>
      m.ico === newM.ico &&
      m.funkce === newM.funkce &&
      m.source === newM.source &&
      m.datumZapisu === newM.datumZapisu,
  );
  if (existing) {
    existing.seenAt = now;
    if (newM.datumVymazu && !existing.datumVymazu) existing.datumVymazu = newM.datumVymazu;
    if (newM.obchodniJmeno && !existing.obchodniJmeno) existing.obchodniJmeno = newM.obchodniJmeno;
  } else {
    person.memberships.push(newM);
  }
  scheduleFlush();
}

/** Najdi všechny memberships osoby. */
export function findMemberships(
  jmeno: string,
  prijmeni: string,
  datumNarozeni: string,
): IndexedPerson | null {
  load();
  const dob = datumNarozeni.slice(0, 10);
  const key = makeKey(jmeno, prijmeni, dob);
  return memory.persons[key] ?? null;
}

export function indexStats(): {
  personsCount: number;
  membershipsCount: number;
  lastUpdated: string;
  path: string;
} {
  load();
  let count = 0;
  for (const p of Object.values(memory.persons)) count += p.memberships.length;
  return {
    personsCount: Object.keys(memory.persons).length,
    membershipsCount: count,
    lastUpdated: memory.lastUpdated,
    path: dataPath(),
  };
}

export function forceFlush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}
