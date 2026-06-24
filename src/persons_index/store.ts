// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Thin wrapper nad SQLite db.ts. Zachovává původní exporty pro backward
 * compatibility s consumer files (services.ts, holding/discover.ts atd.).
 *
 * Předchozí verze: in-memory + JSON soubor s debounce flush. Při růstu
 * persons-index nad 15 MB se cold-start parse a každý write stávaly
 * pomalými. SQLite (via better-sqlite3) řeší to definitivně — ACID,
 * indexovaný read O(log n), transakční write.
 *
 * Pro migraci JSON → SQLite spusť: `node scripts/migrate_to_sqlite.mjs`
 */

import {
  dbFindPerson,
  dbFindTentative,
  dbGetChildrenByParent,
  dbGetOwnershipDetails,
  dbGetSubjectName,
  dbListSubjects,
  dbStats,
  dbUpsertMembership,
  dbUpsertOwnership,
  dbUpsertSubject,
  dbUpsertTentativeMembership,
} from "./db.js";

// ─── Public types (původní z JSON éry) ───────────────────────────────────────

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

export interface IndexedSubject {
  ico: string;
  obchodniJmeno: string | null;
  seenAt: number;
}

export interface OwnershipEntry {
  childIco: string;
  parentIco: string;
  validFrom: string | null;
  validTo: string | null;
  source: "ARES_VR_akcionari";
  seenAt: number;
}

export interface IndexedTentativeMembership {
  ico: string;
  obchodniJmeno: string | null;
  funkce: string | null;
  organ: string | null;
  datumZapisu: string | null;
  datumVymazu: string | null;
  source: "ARES_VR" | "OR_VR" | "OR_DR" | "OR_AKC";
  seenAt: number;
}

export interface IndexedTentativePerson {
  displayName: string;
  jmeno: string;
  prijmeni: string;
  memberships: IndexedTentativeMembership[];
}

// ─── Key normalization (deterministic, stabilní napříč variantami) ────────────

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

function makeTentativeKey(jmeno: string, prijmeni: string): string {
  return `${normalize(jmeno)}|${normalize(prijmeni)}`;
}

// ─── Persons (s DOB) ──────────────────────────────────────────────────────────

export interface UpsertInput {
  jmeno: string;
  prijmeni: string;
  titulPred: string | null;
  displayName: string;
  datumNarozeni: string;
  ico: string;
  obchodniJmeno: string | null;
  funkce: string | null;
  organ: string | null;
  datumZapisu: string | null;
  datumVymazu: string | null;
  source: IndexedMembership["source"];
}

export function upsertMembership(input: UpsertInput): void {
  const dob = input.datumNarozeni?.slice(0, 10);
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return;
  if (!input.jmeno && !input.prijmeni) return;
  const personKey = makeKey(input.jmeno, input.prijmeni, dob);
  dbUpsertMembership({
    personKey,
    displayName: input.displayName || `${input.titulPred ? `${input.titulPred} ` : ""}${input.jmeno} ${input.prijmeni}`.trim(),
    jmeno: input.jmeno,
    prijmeni: input.prijmeni,
    titulPred: input.titulPred,
    datumNarozeni: dob,
    ico: input.ico,
    obchodniJmeno: input.obchodniJmeno,
    funkce: input.funkce,
    organ: input.organ,
    datumZapisu: input.datumZapisu,
    datumVymazu: input.datumVymazu,
    source: input.source,
  });
}

export function findMemberships(
  jmeno: string,
  prijmeni: string,
  datumNarozeni: string,
): IndexedPerson | null {
  const dob = datumNarozeni.slice(0, 10);
  const key = makeKey(jmeno, prijmeni, dob);
  const person = dbFindPerson(key);
  if (!person) return null;
  return {
    displayName: person.displayName,
    jmeno: person.jmeno,
    prijmeni: person.prijmeni,
    titulPred: person.titulPred,
    datumNarozeni: person.datumNarozeni,
    memberships: person.memberships.map((m) => ({
      ico: m.ico,
      obchodniJmeno: m.obchodniJmeno,
      funkce: m.funkce || null,
      organ: m.organ,
      datumZapisu: m.datumZapisu || null,
      datumVymazu: m.datumVymazu,
      source: m.source as IndexedMembership["source"],
      seenAt: m.seenAt,
    })),
  };
}

// ─── Subjects ─────────────────────────────────────────────────────────────────

export function upsertSubject(ico: string, obchodniJmeno?: string | null): void {
  dbUpsertSubject(ico, obchodniJmeno ?? null);
}

export function listSubjects(): IndexedSubject[] {
  return dbListSubjects();
}

// ─── Ownership ────────────────────────────────────────────────────────────────

export function upsertOwnership(input: {
  childIco: string;
  parentIco: string;
  validFrom: string | null;
  validTo: string | null;
  source?: OwnershipEntry["source"];
}): void {
  dbUpsertOwnership({
    childIco: input.childIco,
    parentIco: input.parentIco,
    validFrom: input.validFrom,
    validTo: input.validTo,
    source: input.source ?? "ARES_VR_akcionari",
  });
}

export function getChildrenByParent(
  parentIco: string,
  includeHistorical = false,
): string[] {
  return dbGetChildrenByParent(parentIco, includeHistorical);
}

/** Obchodní jméno subjektu z indexu (pro anchor text interních odkazů). */
export function getSubjectName(ico: string): string | null {
  return dbGetSubjectName(ico);
}

export function getOwnershipDetails(
  parentIco: string,
  includeHistorical = false,
): OwnershipEntry[] {
  return dbGetOwnershipDetails(parentIco, includeHistorical).map((d) => ({
    childIco: d.childIco,
    parentIco: d.parentIco,
    validFrom: d.validFrom || null,
    validTo: d.validTo,
    source: d.source as OwnershipEntry["source"],
    seenAt: d.seenAt,
  }));
}

// ─── Tentative ────────────────────────────────────────────────────────────────

export function upsertTentativeMembership(input: {
  jmeno: string;
  prijmeni: string;
  displayName: string;
  ico: string;
  obchodniJmeno?: string | null;
  funkce?: string | null;
  organ?: string | null;
  datumZapisu?: string | null;
  datumVymazu?: string | null;
  source: IndexedTentativeMembership["source"];
}): void {
  if (!input.jmeno || !input.prijmeni || !input.ico) return;
  const tentativeKey = makeTentativeKey(input.jmeno, input.prijmeni);
  dbUpsertTentativeMembership({
    tentativeKey,
    displayName: input.displayName,
    jmeno: input.jmeno,
    prijmeni: input.prijmeni,
    ico: input.ico,
    obchodniJmeno: input.obchodniJmeno ?? null,
    funkce: input.funkce ?? null,
    organ: input.organ ?? null,
    datumZapisu: input.datumZapisu ?? null,
    datumVymazu: input.datumVymazu ?? null,
    source: input.source,
  });
}

export function findTentativeMemberships(
  jmeno: string,
  prijmeni: string,
): IndexedTentativePerson | null {
  const key = makeTentativeKey(jmeno, prijmeni);
  const person = dbFindTentative(key);
  if (!person) return null;
  return {
    displayName: person.displayName,
    jmeno: person.jmeno,
    prijmeni: person.prijmeni,
    memberships: person.memberships.map((m) => ({
      ico: m.ico,
      obchodniJmeno: m.obchodniJmeno,
      funkce: m.funkce || null,
      organ: m.organ,
      datumZapisu: m.datumZapisu || null,
      datumVymazu: m.datumVymazu,
      source: m.source as IndexedTentativeMembership["source"],
      seenAt: m.seenAt,
    })),
  };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export function indexStats(): {
  personsCount: number;
  membershipsCount: number;
  subjectsCount: number;
  ownershipParentsCount: number;
  ownershipEdgesCount: number;
  tentativeCount: number;
  tentativeMembershipsCount: number;
  lastUpdated: string;
  path: string;
} {
  const s = dbStats();
  return {
    personsCount: s.personsCount,
    membershipsCount: s.membershipsCount,
    subjectsCount: s.subjectsCount,
    ownershipParentsCount: s.ownershipParentsCount,
    ownershipEdgesCount: s.ownershipEdgesCount,
    tentativeCount: s.tentativeCount,
    tentativeMembershipsCount: s.tentativeMembershipsCount,
    lastUpdated: new Date().toISOString(),
    path: s.path,
  };
}

/** Legacy no-op. Dříve flush JSON, teď SQLite je transactional auto-commit. */
export function forceFlush(): void {
  // SQLite WAL flush by se dělal přes db.pragma('wal_checkpoint(TRUNCATE)'),
  // ale není potřeba — Node.js process exit volá close handler automaticky.
}
