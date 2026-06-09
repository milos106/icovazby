#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Drip harvest — hodinový cron. Přidává firmy do inventory.
 *
 * Priority:
 *   1. Orphan parents (firmy které vystupují jako parent v ownership ale
 *      samy ještě nejsou v subjects)
 *   2. Keyword rotation (~130 slov, ratchet přes pravniForma pro wide queries)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  DB_FILE,
  fetchAresSubject,
  fetchAresVr,
  searchAresByName,
  extractFromVr,
  currentObchodniJmeno,
  upsertSubject,
  upsertMembership,
  upsertTentativeMembership,
  upsertOwnership,
  listAllSubjectIcos,
  listOrphanParents,
  stats,
  getDb,
} from "./_shared.mjs";

const PER_RUN = Number(process.env.DRIP_PER_RUN ?? 20);
const STATE_FILE = resolve(DB_FILE, "..", ".drip-state.json");

const KEYWORDS = [
  "stavební", "doprava", "servis", "obchod", "výroba", "služby", "montáže",
  "instalace", "stavby", "konzult", "projekt", "trade", "group", "holding",
  "real", "estate", "invest", "finance", "consulting", "studio", "design",
  "media", "marketing", "agency", "logistics", "transport", "spedice",
  "auto", "moto", "automotive", "elektro", "energo", "energie", "solar",
  "fotovoltaika", "klima", "voda", "plyn", "topení", "izolace", "stavitelství",
  "geo", "geodez", "architekt", "inženýr", "technologie", "technika",
  "průmysl", "metal", "kov", "ocel", "dřevo", "wood", "papír", "tisk",
  "print", "reklama", "pivovar", "potravin", "maso", "mlék", "pekárna",
  "cukrárna", "zelenina", "ovoce", "agro", "farma", "lesy", "zahrada",
  "chemie", "plast", "guma", "textil", "móda", "oděvy", "obuv", "kožen",
  "sklo", "keramika", "porcelán", "nábytek", "interiér", "úklid", "ochrana",
  "bezpečn", "security", "advokát", "právní", "účetní", "daně", "audit",
  "škola", "education", "sport", "fitness", "wellness", "hotel", "restaurace",
  "café", "kavárna", "bar", "pizzeria", "klinika", "lékárna", "zdraví",
  "rehabilitace", "veterin", "kosmetika", "salon", "kadeřnic",
  "loter", "herna", "casino", "kasino", "sázk", "lottery", "betting",
  "bookmaker", "tipsport", "fortuna", "synot", "jackpot", "bingo", "tombol",
  "PR", "public relations", "branding", "komunikace", "kreativ", "promo",
  "event", "production", "publishing", "vydavatel", "noviny", "magazín",
  "rozhlas", "televize", "studio film", "post-production",
];

const PRAVNI_FORMA_RATCHET = [
  null,
  { pravniForma: ["121"] },
  { pravniForma: ["112"], sidloKodObce: 554782 },
  { pravniForma: ["112"], sidloKodObce: 582786 },
];

function loadState() {
  if (!existsSync(STATE_FILE)) return { keywordIndex: 0 };
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { keywordIndex: 0 }; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function processIco(ico, knownIcos) {
  if (knownIcos.has(ico)) return null;
  try {
    const [subject, vr] = await Promise.allSettled([
      fetchAresSubject(ico),
      fetchAresVr(ico),
    ]);
    const sub = subject.status === "fulfilled" ? subject.value : null;
    if (!sub) return null;

    const vrVal = vr.status === "fulfilled" ? vr.value : null;
    const obchodniJmeno = sub.obchodniJmeno ?? currentObchodniJmeno(vrVal) ?? null;
    upsertSubject(ico, obchodniJmeno);
    knownIcos.add(ico);

    if (vrVal) {
      const { memberships, tentativeMemberships, ownership } = extractFromVr(vrVal, ico, obchodniJmeno);
      for (const m of memberships) upsertMembership(m);
      for (const m of tentativeMemberships) upsertTentativeMembership(m);
      for (const e of ownership) upsertOwnership(e);
    }
    return { ico, obchodniJmeno };
  } catch (err) {
    console.error(`  fail ${ico}:`, err.message);
    return null;
  }
}

async function harvestKeyword(keyword, knownIcos, max) {
  console.log(`Keyword "${keyword}" → ARES search`);
  for (const filter of PRAVNI_FORMA_RATCHET) {
    const { tooMany, results } = await searchAresByName(keyword, 100, filter ?? {});
    if (tooMany) {
      console.log(`  filter ${JSON.stringify(filter) ?? "{}"} → too many, retry`);
      continue;
    }
    const newIcos = [];
    for (const r of results) {
      const ico = String(r.ico ?? "").padStart(8, "0");
      if (!/^\d{8}$/.test(ico)) continue;
      if (knownIcos.has(ico)) continue;
      newIcos.push(ico);
      if (newIcos.length >= max) break;
    }
    console.log(`  → ${results.length} hits, ${newIcos.length} new`);
    return newIcos;
  }
  console.log(`  ⚠ keyword "${keyword}" vrací moc výsledků`);
  return [];
}

async function main() {
  const startedAt = Date.now();
  // Pre-load existující IČO do paměti pro rychlý lookup
  const knownIcos = new Set(listAllSubjectIcos());
  console.log(`Existující subjects: ${knownIcos.size}`);

  const state = loadState();
  let processed = 0;

  // Phase 1: orphan parents
  const orphanBudget = Math.ceil(PER_RUN / 2);
  const orphans = listOrphanParents(orphanBudget);
  console.log(`Orphan parents v ownership: ${orphans.length}`);
  for (const ico of orphans) {
    if (processed >= PER_RUN) break;
    const add = await processIco(ico, knownIcos);
    if (add) {
      processed++;
      console.log(`  + ${ico} ${add.obchodniJmeno ?? ""}`);
    }
  }

  // Phase 2: keyword rotation
  while (processed < PER_RUN) {
    const keyword = KEYWORDS[state.keywordIndex % KEYWORDS.length];
    state.keywordIndex = (state.keywordIndex + 1) % KEYWORDS.length;
    const newIcos = await harvestKeyword(keyword, knownIcos, PER_RUN - processed);
    for (const ico of newIcos) {
      if (processed >= PER_RUN) break;
      const add = await processIco(ico, knownIcos);
      if (add) {
        processed++;
        console.log(`  + ${ico} ${add.obchodniJmeno ?? ""}`);
      }
    }
    if (newIcos.length === 0 && state.keywordIndex % KEYWORDS.length === 0) break;
  }

  saveState(state);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const s = stats();
  console.log(`\nDrip hotovo za ${elapsed} s — ${processed} firem přidáno`);
  console.log(`  Inventory: ${s.subjectsCount} subjektů, ${s.personsCount} osob, ${s.ownershipEdgesCount} ownership hran`);
  console.log(`  orphan parents zbývá: ${listOrphanParents(9999).length}`);
  console.log(`  next keyword index: ${state.keywordIndex}`);
  getDb().close();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
