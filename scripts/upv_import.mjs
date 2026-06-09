#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * ÚPV ochranné známky — bulk importer ST.96 XML do SQLite.
 *
 * Usage:
 *   node scripts/upv_import.mjs <extracted-dir>
 *
 * Example:
 *   node scripts/upv_import.mjs /mnt/velky_disk/Stažené/upv-opendata/extracted
 *
 * Datasource: 102 FULL balíčků + 149 DIFF z ÚPV (~335k XML, 89% PO).
 * Žádné IČO v datech — fuzzy match podle applicant_name_normalized + city.
 *
 * Workflow:
 *   1. Walk extracted dir → najde TM* složky
 *   2. Parse každý XML přes fast-xml-parser
 *   3. Batch insert (1000 / transaction) do upv_trademarks tabulky
 *   4. Stats: tempo, počet PO/FO/Word/Figurative/...
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { getDb } from "./_shared.mjs";

const BATCH = 1000;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,            // <com:Name> → <Name>
  parseTagValue: false,            // všechno jako string (ApplicationNumber "607075" ne 607075)
  trimValues: true,
  isArray: (name) => ["GoodsServicesClassification", "Applicant", "ClassDescription"].includes(name),
});

function normalizeName(name) {
  if (!name) return null;
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // strip diacritics: Škoda → Skoda, Česká → Ceska
    .toLowerCase()
    .replace(/[\.,;:()\-–—'"„"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractRecord(xml, sourceFile) {
  const root = xml?.Trademark;
  if (!root) return null;

  const appNum = root.ApplicationNumber?.ApplicationNumberText;
  if (!appNum) return null;

  const applicants = root.ApplicantBag?.Applicant ?? [];
  const firstApp = applicants[0]?.Contact;
  const orgName = firstApp?.Name?.OrganizationName?.OrganizationStandardName;
  const personName = firstApp?.Name?.PersonName?.PersonFullName;
  const isPO = !!orgName;

  // applicantName: text content (může být i objekt s @_ atribute)
  const rawName = isPO
    ? (typeof orgName === "string" ? orgName : orgName?.["#text"] ?? null)
    : null;

  const city = firstApp?.PostalAddressBag?.PostalAddress?.PostalStructuredAddress?.CityName ?? null;

  // Nice classes — bag může mít víc GoodsServices
  const niceClasses = [];
  const gsBag = root.GoodsServicesBag?.GoodsServices;
  const gsArr = Array.isArray(gsBag) ? gsBag : (gsBag ? [gsBag] : []);
  for (const gs of gsArr) {
    const clsBag = gs?.GoodsServicesClassificationBag?.GoodsServicesClassification ?? [];
    for (const c of clsBag) {
      if (c?.ClassificationKindCode === "Nice" && c?.ClassNumber) {
        niceClasses.push(String(c.ClassNumber));
      }
    }
  }

  // Mark text (verbal element, cs preferred)
  const markRepr = root.MarkRepresentation;
  const markFeature = markRepr?.MarkFeatureCategory ?? null;
  let markText = null;
  const verbalEl = markRepr?.MarkReproduction?.WordMarkSpecification?.MarkSignificantVerbalElementText;
  if (verbalEl) {
    markText = typeof verbalEl === "string" ? verbalEl : verbalEl["#text"] ?? null;
  }

  return {
    application_number: String(appNum),
    application_date: root.ApplicationDate ?? null,
    status_code: root.MarkCurrentStatusCode ?? null,
    mark_category: root.MarkCategory ?? null,
    mark_feature: markFeature,
    mark_text: markText,
    applicant_type: isPO ? "PO" : "FO",
    applicant_name: rawName,
    applicant_name_normalized: isPO ? normalizeName(rawName) : null,
    applicant_city: city,
    nice_classes: niceClasses.length ? niceClasses.join(",") : null,
    image_file: null,                        // set later if image exists alongside
    source_file: sourceFile,
    updated_at: Date.now(),
  };
}

function walkXmlFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir)) {
    const p = join(rootDir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory() && entry.startsWith("TM")) {
      // expected: extracted/<package-dir>/TM*/file.xml — but our extract
      // wrote everything flat to extracted/TM*, so handle both levels.
      for (const f of readdirSync(p)) {
        if (f.endsWith(".xml")) files.push({ xml: join(p, f), tmDir: p, packageName: basename(rootDir) });
      }
    } else if (st.isDirectory()) {
      // package-level dir → recurse
      for (const sub of readdirSync(p)) {
        const subP = join(p, sub);
        let sst;
        try { sst = statSync(subP); } catch { continue; }
        if (sst.isDirectory() && sub.startsWith("TM")) {
          for (const f of readdirSync(subP)) {
            if (f.endsWith(".xml")) files.push({ xml: join(subP, f), tmDir: subP, packageName: entry });
          }
        }
      }
    }
  }
  return files;
}

function findImage(tmDir) {
  for (const f of readdirSync(tmDir)) {
    if (f.match(/\.(gif|jpg|jpeg|png)$/i)) return f;
  }
  return null;
}

async function main() {
  const rootDir = process.argv[2];
  if (!rootDir) {
    console.error("Usage: node scripts/upv_import.mjs <extracted-dir>");
    process.exit(1);
  }
  if (!existsSync(rootDir)) {
    console.error(`Directory not found: ${rootDir}`);
    process.exit(1);
  }

  console.log(`Scanning ${rootDir}...`);
  const files = walkXmlFiles(resolve(rootDir));
  console.log(`Found ${files.length} XML files.`);

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
      image_file = excluded.image_file,
      source_file = excluded.source_file,
      updated_at = excluded.updated_at
  `);

  const insertMany = db.transaction((rows) => {
    for (const r of rows) insert.run(r);
  });

  let inserted = 0, skipped = 0, errors = 0;
  let stats = { PO: 0, FO: 0, Word: 0, Figurative: 0, Combined: 0, withImage: 0 };
  const t0 = Date.now();
  let batch = [];

  for (const f of files) {
    try {
      const content = readFileSync(f.xml, "utf8");
      const parsed = parser.parse(content);
      const rec = extractRecord(parsed, f.packageName);
      if (!rec) { skipped++; continue; }
      const imgName = findImage(f.tmDir);
      if (imgName) {
        rec.image_file = `${f.packageName}/${basename(f.tmDir)}/${imgName}`;
        stats.withImage++;
      }
      stats[rec.applicant_type]++;
      if (rec.mark_feature && stats[rec.mark_feature] !== undefined) stats[rec.mark_feature]++;
      batch.push(rec);
      if (batch.length >= BATCH) {
        insertMany(batch);
        inserted += batch.length;
        batch = [];
        if (inserted % 10000 === 0) {
          const rate = Math.round(inserted / ((Date.now() - t0) / 1000));
          console.log(`  ${inserted} / ${files.length} (${rate}/s)`);
        }
      }
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`  err in ${f.xml}: ${e.message}`);
    }
  }
  if (batch.length) {
    insertMany(batch);
    inserted += batch.length;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDONE in ${elapsed}s`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped (no AppNum): ${skipped}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Stats: ${JSON.stringify(stats)}`);

  const total = db.prepare("SELECT COUNT(*) as n FROM upv_trademarks").get().n;
  const po = db.prepare("SELECT COUNT(*) as n FROM upv_trademarks WHERE applicant_type='PO'").get().n;
  console.log(`\nDB total: ${total} records (${po} PO)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
