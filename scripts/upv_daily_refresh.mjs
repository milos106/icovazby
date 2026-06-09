#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * ÚPV ochranné známky — daily refresh.
 *
 * Spouští se z systemd timer (icovazby-upv.timer) denně ráno. Najde poslední
 * dostupný DIFF balíček (typicky za včerejšek), stáhne, rozbalí, naimportuje
 * přes UPSERT do `upv_trademarks` tabulky. Změněné značky se aktualizují,
 * nové se vloží.
 *
 * Workflow:
 *   1. Zkusí stáhnout DIFF z dnes, včera, ..., max 7 dní zpět (kdyby ÚPV
 *      pozdě nahrál)
 *   2. Rozbalí do /tmp
 *   3. Spustí inline parser (sdílí logiku s upv_import.mjs)
 *   4. Statistika + cleanup
 *
 * Lze spustit ručně:
 *   node scripts/upv_daily_refresh.mjs           — auto detekce data
 *   node scripts/upv_daily_refresh.mjs 09-06-2026  — konkrétní datum
 */

import { writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { XMLParser } from "fast-xml-parser";
import { getDb } from "./_shared.mjs";

const BASE_URL = "https://isdv.upv.gov.cz/doc/opendatast96/tm";
const TMP_DIR = "/tmp/upv-daily";
const MAX_DAYS_BACK = 7;

function ddmmyyyy(date) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${date.getFullYear()}`;
}

/** Najde poslední dostupný DIFF, případně použije zadaný datum. */
function findDiffUrl(explicitDate) {
  const dates = explicitDate
    ? [explicitDate]
    : Array.from({ length: MAX_DAYS_BACK }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - i);
        return ddmmyyyy(d);
      });

  for (const date of dates) {
    const url = `${BASE_URL}/OPENDATAST96_TM_CZ_DIFF_${date}_0001.zip`;
    // HEAD check
    const head = spawnSync("curl", ["-sI", "-o", "/dev/null", "-w", "%{http_code}", url]);
    const code = head.stdout?.toString().trim();
    if (code === "200") {
      console.log(`Found DIFF for ${date}: ${url}`);
      return { url, date };
    }
    console.log(`  ${date}: HTTP ${code} (skip)`);
  }
  return null;
}

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

  let inserted = 0, errors = 0;
  const batch = [];
  for (const entry of readdirSync(extractedDir)) {
    if (!entry.startsWith("TM")) continue;
    const tmDir = join(extractedDir, entry);
    let st;
    try { st = statSync(tmDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of readdirSync(tmDir)) {
      if (!f.endsWith(".xml")) continue;
      try {
        const parsed = parser.parse(readFileSync(join(tmDir, f), "utf8"));
        const rec = extractRecord(parsed, sourceLabel);
        if (rec) batch.push(rec);
      } catch (e) {
        errors++;
        if (errors <= 3) console.error(`  err in ${f}: ${e.message}`);
      }
    }
  }
  if (batch.length) tx(batch);
  inserted = batch.length;
  return { inserted, errors };
}

async function main() {
  const explicitDate = process.argv[2]; // optional: DD-MM-YYYY
  console.log(`ÚPV daily refresh started (${new Date().toISOString()})`);

  const found = findDiffUrl(explicitDate);
  if (!found) {
    console.error(`No DIFF available for last ${MAX_DAYS_BACK} days. Exiting.`);
    process.exit(0); // 0, ne fail — víkend/svátek ÚPV nepublikuje
  }

  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  const zipPath = join(TMP_DIR, "diff.zip");
  console.log(`Downloading ${found.url}...`);
  const dl = spawnSync("curl", ["-sL", "-o", zipPath, found.url], { stdio: "inherit" });
  if (dl.status !== 0) { console.error("Download failed"); process.exit(1); }

  console.log(`Extracting...`);
  const ex = spawnSync("unzip", ["-qoq", "-d", TMP_DIR, zipPath]);
  if (ex.status !== 0) { console.error("Extract failed"); process.exit(1); }

  const beforeCount = getDb().prepare("SELECT COUNT(*) as n FROM upv_trademarks").get().n;
  console.log(`Importing... (DB before: ${beforeCount})`);
  const { inserted, errors } = importDir(TMP_DIR, `DIFF_${found.date}`);
  const afterCount = getDb().prepare("SELECT COUNT(*) as n FROM upv_trademarks").get().n;
  const newRows = afterCount - beforeCount;

  console.log(`\nResult:`);
  console.log(`  Processed: ${inserted}`);
  console.log(`  New rows: ${newRows}`);
  console.log(`  Updated rows: ${inserted - newRows}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  DB total: ${afterCount}`);

  rmSync(TMP_DIR, { recursive: true, force: true });
  console.log(`Done.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
