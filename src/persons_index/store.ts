// SPDX-License-Identifier: AGPL-3.0-or-later
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

/**
 * Subject = firma kterou uživatel kdykoli viděl (DD report nebo OR detail).
 * Slouží jako „inventář" pro reverse holding discovery: když rozkrýváme
 * holding parent X, projdeme všechny known subjekts a u každého
 * zkontrolujeme zda X je v jeho akcionářích/statutárech.
 */
export interface IndexedSubject {
  ico: string;
  obchodniJmeno: string | null;
  seenAt: number;
}

/**
 * Verze 3: ownership cache — denormalizovaný index vlastnických vztahů
 * "rodič → seznam dceřinek". Plněno při DD lookup firmy z jejího
 * `akcionari[]` v ARES VR. Nahrazuje pomalé reverse scan, které volalo
 * ARES pro 800 firem živě a často timeoutovalo přes Cloudflare.
 *
 * Lookup `getChildrenByParent(parentIco)` je O(1) — žádné ARES calls
 * v reálném čase, žádný cap, žádný timeout.
 */
export interface OwnershipEntry {
  /** IČO dceřinky (firma vlastněná). */
  childIco: string;
  /** IČO matky (akcionář). */
  parentIco: string;
  /** datumZapisu z VR akcionari záznamu (null pokud neznámé). */
  validFrom: string | null;
  /** datumVymazu z VR (null = aktivní akcionářský vztah). */
  validTo: string | null;
  /** Zdroj vztahu. Zatím jen ARES VR akcionari, později UBO atd. */
  source: "ARES_VR_akcionari";
  /** Kdy jsme tento vztah naposledy viděli (touch při re-fetchu). */
  seenAt: number;
}

interface IndexFile {
  version: number;
  lastUpdated: string;
  persons: Record<string, IndexedPerson>;
  /** Verze 2: subjects index. Pro zpětnou kompatibilitu volitelný. */
  subjects?: Record<string, IndexedSubject>;
  /** Verze 3: ownership.byParent[parentIco] = [{childIco, ...}, ...]. */
  ownership?: { byParent: Record<string, OwnershipEntry[]> };
}

const VERSION = 3;
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
  subjects: {},
  ownership: { byParent: {} },
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
      if (parsed?.persons) {
        // V1 → V2 → V3 migrace: subjects + ownership default na prázdné.
        memory = {
          version: VERSION,
          lastUpdated: parsed.lastUpdated ?? new Date().toISOString(),
          persons: parsed.persons,
          subjects: parsed.subjects ?? {},
          ownership: parsed.ownership ?? { byParent: {} },
        };
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

/** Zaznamenej, že uživatel viděl firmu s tímto IČO. Slouží pro reverse
 *  holding discovery — projít všechny known subjekts a u každého
 *  zkontrolovat zda parent IČO je akcionář/statutář. */
export function upsertSubject(ico: string, obchodniJmeno?: string | null): void {
  load();
  const key = ico.replace(/\D/g, "").padStart(8, "0");
  if (!/^\d{8}$/.test(key)) return;
  memory.subjects ??= {};
  const existing = memory.subjects[key];
  memory.subjects[key] = {
    ico: key,
    obchodniJmeno: obchodniJmeno ?? existing?.obchodniJmeno ?? null,
    seenAt: Date.now(),
  };
  scheduleFlush();
}

/** Seznam všech known subjekts (firmy z DD historie). */
export function listSubjects(): IndexedSubject[] {
  load();
  return Object.values(memory.subjects ?? {});
}

/** Upsert ownership relace parent → child z VR akcionari záznamu.
 *  Idempotentní podle (childIco, parentIco, validFrom). */
export function upsertOwnership(input: {
  childIco: string;
  parentIco: string;
  validFrom: string | null;
  validTo: string | null;
  source?: OwnershipEntry["source"];
}): void {
  load();
  const child = input.childIco.replace(/\D/g, "").padStart(8, "0");
  const parent = input.parentIco.replace(/\D/g, "").padStart(8, "0");
  if (!/^\d{8}$/.test(child) || !/^\d{8}$/.test(parent)) return;
  if (child === parent) return;
  memory.ownership ??= { byParent: {} };
  const entries = (memory.ownership.byParent[parent] ??= []);
  const now = Date.now();
  const existing = entries.find(
    (e) => e.childIco === child && (e.validFrom ?? null) === (input.validFrom ?? null),
  );
  if (existing) {
    existing.seenAt = now;
    if (input.validTo && !existing.validTo) existing.validTo = input.validTo;
  } else {
    entries.push({
      childIco: child,
      parentIco: parent,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      source: input.source ?? "ARES_VR_akcionari",
      seenAt: now,
    });
  }
  scheduleFlush();
}

/** O(1) lookup: vrať seznam dceřinek pro daný parent IČO.
 *  `includeHistorical=false` filtruje pryč záznamy s validTo (vymazané). */
export function getChildrenByParent(
  parentIco: string,
  includeHistorical = false,
): string[] {
  load();
  const parent = parentIco.replace(/\D/g, "").padStart(8, "0");
  const entries = memory.ownership?.byParent[parent] ?? [];
  const filtered = includeHistorical ? entries : entries.filter((e) => !e.validTo);
  return [...new Set(filtered.map((e) => e.childIco))];
}

/** Vrať raw OwnershipEntry[] pro debug / UI tooltip (datum od/do, source). */
export function getOwnershipDetails(
  parentIco: string,
  includeHistorical = false,
): OwnershipEntry[] {
  load();
  const parent = parentIco.replace(/\D/g, "").padStart(8, "0");
  const entries = memory.ownership?.byParent[parent] ?? [];
  return includeHistorical ? entries : entries.filter((e) => !e.validTo);
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
  subjectsCount: number;
  ownershipParentsCount: number;
  ownershipEdgesCount: number;
  lastUpdated: string;
  path: string;
} {
  load();
  let count = 0;
  for (const p of Object.values(memory.persons)) count += p.memberships.length;
  let edges = 0;
  for (const list of Object.values(memory.ownership?.byParent ?? {})) edges += list.length;
  return {
    personsCount: Object.keys(memory.persons).length,
    membershipsCount: count,
    subjectsCount: Object.keys(memory.subjects ?? {}).length,
    ownershipParentsCount: Object.keys(memory.ownership?.byParent ?? {}).length,
    ownershipEdgesCount: edges,
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
