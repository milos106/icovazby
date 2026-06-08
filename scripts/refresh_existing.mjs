#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Refresh existing — týdenní cron, re-fetchne ARES VR pro nejstarší
 * subjekty v inventory a updatuje memberships + ownership. Tím chytíme
 * změny ve statutárním orgánu, akcionářích a společnících (běžná
 * fluktuace v živých firmách).
 *
 * Strategie: vezmeme 2000 subjektů s nejstarším `seenAt`. Default cap
 * REFRESH_BATCH=2000 → při 16k inventory full cycle za ~8 týdnů.
 *
 * Atomic write merge s běžícím serverem — viz _shared.mjs.
 */

import {
  loadIndex,
  mergeAndWrite,
  fetchAresVr,
  makePersonKey,
  extractFromVr,
} from "./_shared.mjs";

const BATCH = Number(process.env.REFRESH_BATCH ?? 2000);
const CONCURRENCY = Number(process.env.REFRESH_CONCURRENCY ?? 4);
const PROGRESS_EVERY = 200;

async function processOne(ico, obchodniJmenoFromSubject) {
  try {
    const vr = await fetchAresVr(ico);
    if (!vr) return null;
    const { memberships, ownership } = extractFromVr(
      vr,
      ico,
      obchodniJmenoFromSubject,
    );
    return { memberships, ownership };
  } catch {
    return null;
  }
}

async function main() {
  const startedAt = Date.now();
  const idx = loadIndex();

  const candidates = Object.values(idx.subjects ?? {})
    .sort((a, b) => (a.seenAt ?? 0) - (b.seenAt ?? 0))
    .slice(0, BATCH);

  console.log(`Refresh batch: ${candidates.length} / ${Object.keys(idx.subjects).length} subjektů`);

  const additions = { subjects: {}, persons: {}, ownership: {} };
  let processed = 0;
  let withChanges = 0;
  let edgesAdded = 0;
  let membershipsAdded = 0;
  const queue = candidates.slice();

  async function worker() {
    while (queue.length > 0) {
      const subj = queue.shift();
      if (!subj) break;
      const result = await processOne(subj.ico, subj.obchodniJmeno);
      processed++;

      if (result) {
        let firmChanged = false;

        for (const m of result.memberships) {
          const key = makePersonKey(m.jmeno, m.prijmeni, m.datumNarozeni);
          if (!additions.persons[key]) {
            additions.persons[key] = {
              displayName: `${m.jmeno} ${m.prijmeni}`,
              jmeno: m.jmeno,
              prijmeni: m.prijmeni,
              titulPred: m.titulPred,
              datumNarozeni: m.datumNarozeni,
              memberships: [],
            };
          }
          additions.persons[key].memberships.push({
            ico: m.ico,
            obchodniJmeno: m.obchodniJmeno,
            funkce: m.funkce,
            organ: m.organ,
            datumZapisu: m.datumZapisu,
            datumVymazu: m.datumVymazu,
            source: "ARES_VR",
            seenAt: Date.now(),
          });
          membershipsAdded++;
          firmChanged = true;
        }

        for (const e of result.ownership) {
          (additions.ownership[e.parentIco] ??= []).push(e);
          edgesAdded++;
          firmChanged = true;
        }

        // Touch subject seenAt aby se appearoval na konci sortu
        additions.subjects[subj.ico] = {
          ico: subj.ico,
          obchodniJmeno: subj.obchodniJmeno,
          seenAt: Date.now(),
        };

        if (firmChanged) withChanges++;
      } else {
        // i bez výsledku touch — nezacyklit na 404 subjects
        additions.subjects[subj.ico] = {
          ...subj,
          seenAt: Date.now(),
        };
      }

      if (processed % PROGRESS_EVERY === 0) {
        const rate = processed / ((Date.now() - startedAt) / 1000);
        console.log(
          `[${processed}/${candidates.length}] ${rate.toFixed(1)} req/s | ` +
            `${withChanges} změněno | ${edgesAdded} hran | ${membershipsAdded} členství`,
        );
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  mergeAndWrite(idx, additions);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`Refresh hotov za ${elapsed} s`);
  console.log(`  Zpracováno: ${processed} subjektů`);
  console.log(`  Změněno (membership nebo ownership): ${withChanges}`);
  console.log(`  Nových ownership hran: ${edgesAdded}`);
  console.log(`  Nových membership záznamů (dedup ještě proběhne při merge): ${membershipsAdded}`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
