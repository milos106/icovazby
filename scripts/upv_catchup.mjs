#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * ÚPV catch-up: re-importuje všechny DIFF balíčky CHRONOLOGICKY (od starých
 * po nejnovější), aby UPSERT zapsal nejnovější verzi každé značky.
 *
 * Důvod: původní bulk import rozbalil 251 zips paralelně přes xargs -P 8
 * do flat extracted/ dir. Pro TM složku co byla i ve FULL i v DIFF (změna
 * statusu, datumu, ...) zvítězila ta extrahovaná druhá = race condition.
 * Tento script načte DIFFy v správném pořadí a každý UPSERTne přes existing
 * data, takže DB končí v deterministicky aktuálním stavu k poslednímu DIFFu.
 *
 * Usage:
 *   node scripts/upv_catchup.mjs <zips-dir>
 *
 * Example:
 *   node scripts/upv_catchup.mjs /mnt/velky_disk/Stažené/upv-opendata/zips
 */

import { mkdirSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { XMLParser } from "fast-xml-parser";
import { getDb } from "./_shared.mjs";

const TMP_BASE = "/tmp/upv-catchup";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ["GoodsServicesClassification", "Applicant", "ClassDescription"].includes(name),
});

function normalizeName(name) {
  if (!name) return null;
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[.,;:()\-–—'"„"]/g, " ").replace(/\s+/g, " ").trim();
}

function extractRecord(xml, sourceFile) {
  const root = xml?.Trademark;
  if (!root) return null;
  const appNum = root.ApplicationNumber?.ApplicationNumberText;
  if (!appNum) return null;
  const applicants = root.ApplicantBag?.Applicant ?? [];
  const firstApp = applicants[0]?.Contact;
  const orgName = firstApp?.Name?.OrganizationName?.OrganizationStandardName;
  const isPO = !!orgName;
  const rawName = isPO ? (typeof orgName === "string" ? orgName : orgName?.["#text"] ?? null) : null;
  const city = firstApp?.PostalAddressBag?.PostalAddress?.PostalStructuredAddress?.CityName ?? null;
  const niceClasses = [];
  const gsBag = root.GoodsServicesBag?.GoodsServices;
  const gsArr = Array.isArray(gsBag) ? gsBag : (gsBag ? [gsBag] : []);
  for (const gs of gsArr) {
    const clsBag = gs?.GoodsServicesClassificationBag?.GoodsServicesClassification ?? [];
    for (const c of clsBag) {
      if (c?.ClassificationKindCode === "Nice" && c?.ClassNumber) niceClasses.push(String(c.ClassNumber));
    }
  }
  const markRepr = root.MarkRepresentation;
  let markText = null;
  const verbalEl = markRepr?.MarkReproduction?.WordMarkSpecification?.MarkSignificantVerbalElementText;
  if (verbalEl) markText = typeof verbalEl === "string" ? verbalEl : verbalEl["#text"] ?? null;
  return {
    application_number: String(appNum),
    application_date: root.ApplicationDate ?? null,
    status_code: root.MarkCurrentStatusCode ?? null,
    mark_category: root.MarkCategory ?? null,
    mark_feature: markRepr?.MarkFeatureCategory ?? null,
    mark_text: markText,
    applicant_type: isPO ? "PO" : "FO",
    applicant_name: rawName,
    applicant_name_normalized: isPO ? normalizeName(rawName) : null,
    applicant_city: city,
    nice_classes: niceClasses.length ? niceClasses.join(",") : null,
    image_file: null,
    source_file: sourceFile,
    updated_at: Date.now(),
  };
}

function importDir(extractedDir, sourceLabel) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO upv_trademarks (
      application_number, application_date, status_code, mark_category,
      mark_feature, mark_text, applicant_type, applicant_name,
      applicant_name_normalized, applicant_city, nice_classes, image_file,
      source_file, updated_at
    ) VALUES (
      @application_number, @application_date, @status_code, @mark_category,
      @mark_feature, @mark_text, @applicant_type, @applicant_name,
      @applicant_name_normalized, @applicant_city, @nice_classes, @image_file,
      @source_file, @updated_at
    )
    ON CONFLICT(application_number) DO UPDATE SET
      application_date = excluded.application_date,
      status_code = excluded.status_code,
      mark_category = excluded.mark_category,
      mark_feature = excluded.mark_feature,
      mark_text = excluded.mark_text,
      applicant_type = excluded.applicant_type,
      applicant_name = excluded.applicant_name,
      applicant_name_normalized = excluded.applicant_name_normalized,
      applicant_city = excluded.applicant_city,
      nice_classes = excluded.nice_classes,
      source_file = excluded.source_file,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rows) => { for (const r of rows) insert.run(r); });

  let processed = 0, errors = 0;
  const batch = [];
  function walkAndImport(dir) {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory() && entry.startsWith("TM")) {
        for (const f of readdirSync(p)) {
          if (!f.endsWith(".xml")) continue;
          try {
            const parsed = parser.parse(readFileSync(join(p, f), "utf8"));
            const rec = extractRecord(parsed, sourceLabel);
            if (rec) batch.push(rec);
          } catch (e) {
            errors++;
          }
        }
      } else if (st.isDirectory()) {
        walkAndImport(p);
      }
    }
  }
  walkAndImport(extractedDir);
  if (batch.length) tx(batch);
  processed = batch.length;
  return { processed, errors };
}

// Parse DIFF date z filename: OPENDATAST96_TM_CZ_DIFF_DD-MM-YYYY_0001.zip → Date
function parseDiffDate(filename) {
  const m = filename.match(/DIFF_(\d{2})-(\d{2})-(\d{4})_(\d+)\.zip$/);
  if (!m) return null;
  return { d: Number(m[1]), mo: Number(m[2]), y: Number(m[3]), seq: Number(m[4]), sortKey: `${m[3]}-${m[2]}-${m[1]}-${m[4].padStart(4, "0")}` };
}

async function main() {
  const zipsDir = process.argv[2];
  if (!zipsDir) {
    console.error("Usage: node scripts/upv_catchup.mjs <zips-dir>");
    process.exit(1);
  }

  const allZips = readdirSync(zipsDir).filter((f) => f.endsWith(".zip"));
  const diffZips = allZips
    .filter((f) => f.includes("_DIFF_"))
    .map((f) => ({ name: f, ...parseDiffDate(f) }))
    .filter((x) => x.sortKey)
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  console.log(`Found ${diffZips.length} DIFF balíčků k chronologickému re-importu`);
  console.log(`Order: ${diffZips[0]?.name} … ${diffZips[diffZips.length - 1]?.name}`);

  rmSync(TMP_BASE, { recursive: true, force: true });
  mkdirSync(TMP_BASE, { recursive: true });

  const db = getDb();
  const t0 = Date.now();
  let totalProcessed = 0;
  let totalErrors = 0;
  const before = db.prepare("SELECT COUNT(*) as n FROM upv_trademarks").get().n;

  for (let i = 0; i < diffZips.length; i++) {
    const z = diffZips[i];
    const tmpDir = join(TMP_BASE, `diff_${i}`);
    mkdirSync(tmpDir, { recursive: true });
    const zipPath = join(zipsDir, z.name);
    const ex = spawnSync("unzip", ["-qoq", "-d", tmpDir, zipPath]);
    if (ex.status !== 0) {
      console.error(`  skip ${z.name}: extract failed`);
      rmSync(tmpDir, { recursive: true, force: true });
      continue;
    }
    const { processed, errors } = importDir(tmpDir, z.name);
    totalProcessed += processed;
    totalErrors += errors;
    rmSync(tmpDir, { recursive: true, force: true });

    if (i % 20 === 0 || i === diffZips.length - 1) {
      const rate = Math.round(totalProcessed / ((Date.now() - t0) / 1000));
      console.log(`  [${i + 1}/${diffZips.length}] ${z.name}: +${processed} rec (running ${rate} rec/s)`);
    }
  }

  const after = db.prepare("SELECT COUNT(*) as n FROM upv_trademarks").get().n;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s`);
  console.log(`  Processed: ${totalProcessed}`);
  console.log(`  Errors: ${totalErrors}`);
  console.log(`  DB: ${before} → ${after} (+${after - before} new)`);

  rmSync(TMP_BASE, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
