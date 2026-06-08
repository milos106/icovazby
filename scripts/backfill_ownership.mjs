#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Backfill ownership cache z existujícího inventory.
 *
 * Pro každý subjekt v persons-index.json stáhne jeho ARES VR záznam
 * a vytáhne `akcionari[].clenoveOrganu[].pravnickaOsoba.ico` jako
 * parent → child vztahy. Výsledek mergne do `ownership.byParent` v
 * témže JSON souboru.
 *
 * Použití:
 *   node scripts/backfill_ownership.mjs            # produkční data v ./data/
 *   ARES_WEB_DATA_DIR=./data node scripts/backfill_ownership.mjs
 *   BACKFILL_LIMIT=100 ...                         # omez pro test
 *   BACKFILL_CONCURRENCY=4 ...                     # default 4
 *   BACKFILL_RESUME=1 ...                          # přeskoč parents které
 *                                                    už mají ownership záznam
 *
 * ARES limit: žádná pevná kvóta, ale rate-limit ~10 req/s. S concurrency 4
 * a ARES ~200ms/call ≈ 20 req/s sustained — pro 16k subjects to je ~14 min.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DATA_DIR = process.env.ARES_WEB_DATA_DIR?.trim() || "./data";
const FILE = resolve(DATA_DIR, "persons-index.json");
const LIMIT = Number(process.env.BACKFILL_LIMIT ?? 0);
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY ?? 4);
const RESUME = process.env.BACKFILL_RESUME === "1";
const ARES_BASE = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest";
const PROGRESS_EVERY = 200;

if (!existsSync(FILE)) {
  console.error(`Index file nenalezen: ${FILE}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(FILE, "utf8"));
raw.ownership ??= { byParent: {} };

const subjectIcos = Object.keys(raw.subjects ?? {});
console.log(`Načteno ${subjectIcos.length} subjektů z ${FILE}`);
console.log(`Existující ownership.byParent parents: ${Object.keys(raw.ownership.byParent).length}`);

let queue = subjectIcos.slice();
if (LIMIT > 0) queue = queue.slice(0, LIMIT);

let processed = 0;
let withAkcionari = 0;
let edgesAdded = 0;
const startedAt = Date.now();
let lastFlush = Date.now();

function upsertEdge(child, parent, validFrom, validTo) {
  const c = String(child).replace(/\D/g, "").padStart(8, "0");
  const p = String(parent).replace(/\D/g, "").padStart(8, "0");
  if (!/^\d{8}$/.test(c) || !/^\d{8}$/.test(p) || c === p) return false;
  const entries = (raw.ownership.byParent[p] ??= []);
  const existing = entries.find(
    (e) => e.childIco === c && (e.validFrom ?? null) === (validFrom ?? null),
  );
  if (existing) {
    existing.seenAt = Date.now();
    if (validTo && !existing.validTo) existing.validTo = validTo;
    return false;
  }
  entries.push({
    childIco: c,
    parentIco: p,
    validFrom: validFrom ?? null,
    validTo: validTo ?? null,
    source: "ARES_VR_akcionari",
    seenAt: Date.now(),
  });
  return true;
}

async function fetchVr(ico) {
  const url = `${ARES_BASE}/ekonomicke-subjekty-vr/${ico}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`ARES VR ${ico} → HTTP ${res.status}`);
  return await res.json();
}

function extractOwnership(ico, vr) {
  if (!vr?.zaznamy) return [];
  const out = [];
  const pushOwner = (clen, fallbackFrom, fallbackTo) => {
    const ownerIco = clen.pravnickaOsoba?.ico;
    if (!ownerIco || !/^\d{7,8}$/.test(ownerIco)) return;
    out.push({
      parentIco: ownerIco,
      childIco: ico,
      validFrom: clen.datumZapisu ?? fallbackFrom ?? null,
      validTo: clen.datumVymazu ?? fallbackTo ?? null,
    });
  };
  for (const zaznam of vr.zaznamy) {
    // a.s. → akcionari (vnořené bloky s clenoveOrganu)
    for (const blok of zaznam.akcionari ?? []) {
      for (const clen of blok.clenoveOrganu ?? []) {
        pushOwner(clen, blok.datumZapisu, blok.datumVymazu);
      }
    }
    // s.r.o. → spolecnici (flat list členů). Drtivá většina českých firem.
    for (const clen of zaznam.spolecnici ?? []) {
      pushOwner(clen);
    }
  }
  return out;
}

async function processIco(ico) {
  if (RESUME) {
    // pokud už ico figuruje jako child kdekoli v ownership, přeskoč.
    for (const list of Object.values(raw.ownership.byParent)) {
      if (list.some((e) => e.childIco === ico)) return;
    }
  }
  try {
    const vr = await fetchVr(ico);
    if (!vr) return;
    const edges = extractOwnership(ico, vr);
    if (edges.length > 0) {
      withAkcionari++;
      for (const e of edges) {
        if (upsertEdge(e.childIco, e.parentIco, e.validFrom, e.validTo)) edgesAdded++;
      }
    }
  } catch (err) {
    // tichá tolerance — ARES občas 5xx, pokračujeme
  }
}

async function runPool() {
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const ico = queue.shift();
      if (!ico) break;
      await processIco(ico);
      processed++;
      if (processed % PROGRESS_EVERY === 0) {
        const rate = processed / ((Date.now() - startedAt) / 1000);
        console.log(
          `[${processed}/${subjectIcos.length}] ${rate.toFixed(1)} req/s | ` +
            `${withAkcionari} s akcionáři | ${edgesAdded} nových hran | ` +
            `parents: ${Object.keys(raw.ownership.byParent).length}`,
        );
        if (Date.now() - lastFlush > 30_000) {
          writeFileSync(FILE, JSON.stringify(raw, null, 2));
          lastFlush = Date.now();
        }
      }
    }
  });
  await Promise.all(workers);
}

await runPool();

raw.lastUpdated = new Date().toISOString();
writeFileSync(FILE, JSON.stringify(raw, null, 2));

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log("");
console.log(`Hotovo za ${elapsed} s`);
console.log(`  Zpracováno: ${processed} subjektů`);
console.log(`  S akcionáři: ${withAkcionari}`);
console.log(`  Nových hran v ownership: ${edgesAdded}`);
console.log(`  Parents celkem: ${Object.keys(raw.ownership.byParent).length}`);
