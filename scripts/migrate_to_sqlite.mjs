#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * One-shot migrace JSON persons-index.json → SQLite persons-index.sqlite.
 *
 * Použití:
 *   node scripts/migrate_to_sqlite.mjs
 *   ARES_WEB_DATA_DIR=./data node scripts/migrate_to_sqlite.mjs
 *
 * Bezpečnost:
 *   - Pokud cílový SQLite soubor už existuje, skript skončí s chybou
 *     (= nikdy nepřepíše existující data).
 *   - JSON zůstává netknutý — disaster recovery cestou.
 *
 * Tempo: ~10s pro 16k subjektů + 20k persons + 500 ownership na CX22.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

const DATA_DIR = process.env.ARES_WEB_DATA_DIR?.trim() || "./data";
const JSON_PATH = resolve(DATA_DIR, "persons-index.json");
const SQLITE_PATH = resolve(DATA_DIR, "persons-index.sqlite");

if (!existsSync(JSON_PATH)) {
  console.error(`JSON soubor neexistuje: ${JSON_PATH}`);
  process.exit(1);
}
if (existsSync(SQLITE_PATH)) {
  console.error(`SQLite soubor už existuje: ${SQLITE_PATH}`);
  console.error(`Zkontroluj že tam nejsou data a smaž ručně, pokud chceš re-migrovat.`);
  process.exit(1);
}

const startedAt = Date.now();
console.log(`Načítám JSON: ${JSON_PATH}`);
const json = JSON.parse(readFileSync(JSON_PATH, "utf8"));
console.log(`  version: ${json.version}`);
console.log(`  subjects: ${Object.keys(json.subjects ?? {}).length}`);
console.log(`  persons: ${Object.keys(json.persons ?? {}).length}`);
console.log(`  ownership parents: ${Object.keys(json.ownership?.byParent ?? {}).length}`);
console.log(`  personsTentative: ${Object.keys(json.personsTentative ?? {}).length}`);

console.log(`\nOtevírám SQLite: ${SQLITE_PATH}`);
const db = new Database(SQLITE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

// Schema (kopie z src/persons_index/db.ts)
db.exec(`
  CREATE TABLE subjects (
    ico TEXT PRIMARY KEY,
    obchodni_jmeno TEXT,
    seen_at INTEGER NOT NULL
  );
  CREATE INDEX idx_subjects_seen_at ON subjects(seen_at DESC);

  CREATE TABLE persons (
    person_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    jmeno TEXT NOT NULL,
    prijmeni TEXT NOT NULL,
    titul_pred TEXT,
    datum_narozeni TEXT NOT NULL
  );

  CREATE TABLE memberships (
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
  CREATE INDEX idx_memberships_person ON memberships(person_key);
  CREATE INDEX idx_memberships_ico ON memberships(ico);

  CREATE TABLE ownership (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_ico TEXT NOT NULL,
    child_ico TEXT NOT NULL,
    valid_from TEXT NOT NULL DEFAULT '',
    valid_to TEXT,
    source TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    UNIQUE(parent_ico, child_ico, valid_from)
  );
  CREATE INDEX idx_ownership_parent ON ownership(parent_ico);
  CREATE INDEX idx_ownership_child ON ownership(child_ico);

  CREATE TABLE persons_tentative (
    tentative_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    jmeno TEXT NOT NULL,
    prijmeni TEXT NOT NULL
  );

  CREATE TABLE memberships_tentative (
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
  CREATE INDEX idx_memberships_tentative_key ON memberships_tentative(tentative_key);
`);

console.log(`Schema vytvořeno.`);

const insertSubject = db.prepare(`
  INSERT INTO subjects (ico, obchodni_jmeno, seen_at) VALUES (?, ?, ?)
`);
const insertPerson = db.prepare(`
  INSERT INTO persons (person_key, display_name, jmeno, prijmeni, titul_pred, datum_narozeni)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`);
const insertMembership = db.prepare(`
  INSERT INTO memberships (person_key, ico, obchodni_jmeno, funkce, organ, datum_zapisu, datum_vymazu, source, seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`);
const insertOwnership = db.prepare(`
  INSERT INTO ownership (parent_ico, child_ico, valid_from, valid_to, source, seen_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`);
const insertTentative = db.prepare(`
  INSERT INTO persons_tentative (tentative_key, display_name, jmeno, prijmeni)
  VALUES (?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`);
const insertTentativeMembership = db.prepare(`
  INSERT INTO memberships_tentative (tentative_key, ico, obchodni_jmeno, funkce, organ, datum_zapisu, datum_vymazu, source, seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`);

// Bulk insert via transactions — pro 16k záznamů zásadní rychlost
const migrate = db.transaction(() => {
  let subjectsCount = 0;
  let personsCount = 0;
  let membershipsCount = 0;
  let ownershipCount = 0;
  let tentativeCount = 0;
  let tentativeMembershipsCount = 0;

  for (const [ico, s] of Object.entries(json.subjects ?? {})) {
    insertSubject.run(ico, s.obchodniJmeno ?? null, s.seenAt ?? Date.now());
    subjectsCount++;
  }

  for (const [key, p] of Object.entries(json.persons ?? {})) {
    insertPerson.run(key, p.displayName, p.jmeno, p.prijmeni, p.titulPred ?? null, p.datumNarozeni);
    personsCount++;
    for (const m of p.memberships ?? []) {
      insertMembership.run(
        key,
        m.ico,
        m.obchodniJmeno ?? null,
        m.funkce ?? "",
        m.organ ?? null,
        m.datumZapisu ?? "",
        m.datumVymazu ?? null,
        m.source,
        m.seenAt ?? Date.now(),
      );
      membershipsCount++;
    }
  }

  for (const [parent, edges] of Object.entries(json.ownership?.byParent ?? {})) {
    for (const e of edges) {
      insertOwnership.run(
        parent,
        e.childIco,
        e.validFrom ?? "",
        e.validTo ?? null,
        e.source,
        e.seenAt ?? Date.now(),
      );
      ownershipCount++;
    }
  }

  for (const [key, p] of Object.entries(json.personsTentative ?? {})) {
    insertTentative.run(key, p.displayName, p.jmeno, p.prijmeni);
    tentativeCount++;
    for (const m of p.memberships ?? []) {
      insertTentativeMembership.run(
        key,
        m.ico,
        m.obchodniJmeno ?? null,
        m.funkce ?? "",
        m.organ ?? null,
        m.datumZapisu ?? "",
        m.datumVymazu ?? null,
        m.source,
        m.seenAt ?? Date.now(),
      );
      tentativeMembershipsCount++;
    }
  }

  return {
    subjectsCount,
    personsCount,
    membershipsCount,
    ownershipCount,
    tentativeCount,
    tentativeMembershipsCount,
  };
});

const result = migrate();
db.close();

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\nMigrace hotová za ${elapsed} s:`);
console.log(`  subjects:                  ${result.subjectsCount}`);
console.log(`  persons:                   ${result.personsCount}`);
console.log(`  memberships:               ${result.membershipsCount}`);
console.log(`  ownership edges:           ${result.ownershipCount}`);
console.log(`  personsTentative:          ${result.tentativeCount}`);
console.log(`  tentative memberships:     ${result.tentativeMembershipsCount}`);
console.log(`\nVýstup: ${SQLITE_PATH}`);
console.log(`JSON ponechán nedotčený jako backup: ${JSON_PATH}`);
