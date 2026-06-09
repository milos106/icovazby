#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Refresh existing — týdenní cron. Re-fetchne ARES VR pro 2000 nejstarších
 * subjektů, updatuje memberships + ownership v SQLite (transactional, safe).
 */

import {
  fetchAresVr,
  extractFromVr,
  upsertMembership,
  upsertTentativeMembership,
  upsertOwnership,
  upsertSubject,
  listOldestSubjects,
  getDb,
  stats,
} from "./_shared.mjs";

const BATCH = Number(process.env.REFRESH_BATCH ?? 2000);
const CONCURRENCY = Number(process.env.REFRESH_CONCURRENCY ?? 4);
const PROGRESS_EVERY = 200;

async function processOne(subj) {
  try {
    const vr = await fetchAresVr(subj.ico);
    if (!vr) return { changed: false };
    const { memberships, tentativeMemberships, ownership } = extractFromVr(vr, subj.ico, subj.obchodniJmeno);
    for (const m of memberships) upsertMembership(m);
    for (const m of tentativeMemberships) upsertTentativeMembership(m);
    for (const e of ownership) upsertOwnership(e);
    // Touch subject seenAt
    upsertSubject(subj.ico, subj.obchodniJmeno);
    return { changed: memberships.length + tentativeMemberships.length + ownership.length > 0 };
  } catch {
    return { changed: false };
  }
}

async function main() {
  const startedAt = Date.now();
  const candidates = listOldestSubjects(BATCH);
  console.log(`Refresh batch: ${candidates.length} subjektů`);

  let processed = 0;
  let withChanges = 0;
  const queue = candidates.slice();

  async function worker() {
    while (queue.length > 0) {
      const subj = queue.shift();
      if (!subj) break;
      const result = await processOne(subj);
      processed++;
      if (result.changed) withChanges++;
      if (processed % PROGRESS_EVERY === 0) {
        const rate = processed / ((Date.now() - startedAt) / 1000);
        console.log(`[${processed}/${candidates.length}] ${rate.toFixed(1)} req/s | ${withChanges} změněno`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const s = stats();
  console.log(`\nRefresh hotov za ${elapsed} s`);
  console.log(`  Zpracováno: ${processed} subjektů`);
  console.log(`  Změněno: ${withChanges}`);
  console.log(`  Inventory: ${s.subjectsCount}/${s.personsCount}/${s.ownershipEdgesCount} (subjects/persons/ownership)`);
  getDb().close();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
