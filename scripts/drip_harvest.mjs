#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Drip harvest — periodicky (hodina-otrok) přidává firmy do inventory.
 *
 * Dva zdroje (priorita):
 *   1. ORPHAN PARENTS — IČO v ownership.byParent která ještě nejsou v
 *      subjects (= víme že tu firmu někdo vlastní nebo má jako akcionáře,
 *      ale samu firmu jsme nikdy nefetchovali). Takový bonus 1:1 — zlepší
 *      konektivitu grafu.
 *   2. KEYWORD ROTATION — 100 nejčastějších slov v českých obchodních
 *      jménech. Rotuje deterministicky podle uloženého stavu.
 *
 * Limit: 20 nových firem/běh (env DRIP_PER_RUN). Hourly = ~480/den.
 *
 * Atomic write merge s běžícím serverem — viz _shared.mjs.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ARES_BASE,
  INDEX_FILE,
  loadIndex,
  mergeAndWrite,
  fetchAresSubject,
  fetchAresVr,
  searchAresByName,
  makePersonKey,
  extractFromVr,
  currentObchodniJmeno,
} from "./_shared.mjs";

const PER_RUN = Number(process.env.DRIP_PER_RUN ?? 20);
const STATE_FILE = resolve(INDEX_FILE, "..", ".drip-state.json");

// Top 100 slov v českých obchodních jménech — pokrývá široké spektrum
// odvětví (stavebnictví, doprava, IT, zemědělství, výroba, služby).
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
];

function loadState() {
  if (!existsSync(STATE_FILE)) return { keywordIndex: 0 };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { keywordIndex: 0 };
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function processIco(ico, current) {
  // Skip pokud už máme
  if (current.subjects[ico]) return null;

  try {
    const [subject, vr] = await Promise.allSettled([
      fetchAresSubject(ico),
      fetchAresVr(ico),
    ]);
    const sub = subject.status === "fulfilled" ? subject.value : null;
    if (!sub) return null;

    const vrVal = vr.status === "fulfilled" ? vr.value : null;
    const obchodniJmeno =
      sub.obchodniJmeno ?? currentObchodniJmeno(vrVal) ?? null;

    const additions = {
      subjects: {},
      persons: {},
      personsTentative: {},
      ownership: {},
    };

    additions.subjects[ico] = {
      ico,
      obchodniJmeno,
      seenAt: Date.now(),
    };

    if (vrVal) {
      const { memberships, tentativeMemberships, ownership } = extractFromVr(vrVal, ico, obchodniJmeno);
      for (const m of memberships) {
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
      }
      for (const m of tentativeMemberships) {
        const tkey = m.jmeno.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
          + "|"
          + m.prijmeni.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
        if (!additions.personsTentative[tkey]) {
          additions.personsTentative[tkey] = {
            displayName: `${m.jmeno} ${m.prijmeni}`,
            jmeno: m.jmeno,
            prijmeni: m.prijmeni,
            memberships: [],
          };
        }
        additions.personsTentative[tkey].memberships.push({
          ico: m.ico,
          obchodniJmeno: m.obchodniJmeno,
          funkce: m.funkce,
          organ: m.organ,
          datumZapisu: m.datumZapisu,
          datumVymazu: m.datumVymazu,
          source: "ARES_VR",
          seenAt: Date.now(),
        });
      }
      for (const e of ownership) {
        (additions.ownership[e.parentIco] ??= []).push(e);
      }
    }

    return additions;
  } catch (err) {
    console.error(`  fail ${ico}:`, err.message);
    return null;
  }
}

async function getOrphanParents(idx, max) {
  const orphans = [];
  for (const parentIco of Object.keys(idx.ownership?.byParent ?? {})) {
    if (!idx.subjects[parentIco]) {
      orphans.push(parentIco);
      if (orphans.length >= max) break;
    }
  }
  return orphans;
}

// Pravní formy pro zúžení wide keywords. ARES ratchet — když query
// vrátí >1000 hits, postupně přidáváme filter pravniForma. 112=s.r.o.,
// 101=fyzická osoba podnikající, 121=a.s.
const PRAVNI_FORMA_RATCHET = [
  null,                                  // bez filtru
  { pravniForma: ["121"] },              // a.s. (méně početné)
  { pravniForma: ["112"], sidloKodObce: 554782 }, // s.r.o. + Praha
  { pravniForma: ["112"], sidloKodObce: 582786 }, // s.r.o. + Brno
];

async function harvestKeyword(keyword, idx, max) {
  console.log(`Keyword "${keyword}" → ARES search`);
  for (const filter of PRAVNI_FORMA_RATCHET) {
    const { tooMany, results } = await searchAresByName(keyword, 100, filter ?? {});
    if (tooMany) {
      console.log(`  filter ${JSON.stringify(filter) ?? "{}"} → too many, retry s užším filtrem`);
      continue;
    }
    const newIcos = [];
    for (const r of results) {
      const ico = String(r.ico ?? "").padStart(8, "0");
      if (!/^\d{8}$/.test(ico)) continue;
      if (idx.subjects[ico]) continue;
      newIcos.push(ico);
      if (newIcos.length >= max) break;
    }
    console.log(`  → ${results.length} hits${filter ? " (filter=" + JSON.stringify(filter) + ")" : ""}, ${newIcos.length} new`);
    return newIcos;
  }
  console.log(`  ⚠ keyword "${keyword}" vrací moc výsledků i s ratchety, skip`);
  return [];
}

async function main() {
  const startedAt = Date.now();
  const idx = loadIndex();
  const state = loadState();

  const allAdditions = { subjects: {}, persons: {}, personsTentative: {}, ownership: {} };
  let processed = 0;

  // Fáze 1: orphan parents (max polovina budget)
  const orphanBudget = Math.ceil(PER_RUN / 2);
  const orphans = await getOrphanParents(idx, orphanBudget);
  console.log(`Orphan parents v inventory ke zpracování: ${orphans.length}`);

  for (const ico of orphans) {
    if (processed >= PER_RUN) break;
    const add = await processIco(ico, idx);
    if (add) {
      Object.assign(allAdditions.subjects, add.subjects);
      Object.assign(allAdditions.persons, add.persons);
      for (const [tkey, tperson] of Object.entries(add.personsTentative ?? {})) {
        if (!allAdditions.personsTentative[tkey]) {
          allAdditions.personsTentative[tkey] = tperson;
        } else {
          allAdditions.personsTentative[tkey].memberships.push(...tperson.memberships);
        }
      }
      for (const [p, es] of Object.entries(add.ownership)) {
        (allAdditions.ownership[p] ??= []).push(...es);
      }
      idx.subjects[ico] = add.subjects[ico];
      processed++;
      console.log(`  + ${ico} ${add.subjects[ico].obchodniJmeno ?? ""}`);
    }
  }

  // Fáze 2: keyword harvest pro zbytek budgetu
  while (processed < PER_RUN) {
    const keyword = KEYWORDS[state.keywordIndex % KEYWORDS.length];
    state.keywordIndex = (state.keywordIndex + 1) % KEYWORDS.length;
    const newIcos = await harvestKeyword(keyword, idx, PER_RUN - processed);

    for (const ico of newIcos) {
      if (processed >= PER_RUN) break;
      const add = await processIco(ico, idx);
      if (add) {
        Object.assign(allAdditions.subjects, add.subjects);
        Object.assign(allAdditions.persons, add.persons);
        for (const [p, es] of Object.entries(add.ownership)) {
          (allAdditions.ownership[p] ??= []).push(...es);
        }
        idx.subjects[ico] = add.subjects[ico];
        processed++;
        console.log(`  + ${ico} ${add.subjects[ico].obchodniJmeno ?? ""}`);
      }
    }
    // Pojistka: pokud keyword nedal žádné nové, zkus dál (max 5 keywords/běh)
    if (newIcos.length === 0 && state.keywordIndex % KEYWORDS.length === 0) break;
  }

  if (processed > 0) {
    mergeAndWrite(idx, allAdditions);
  }
  saveState(state);

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log(`Drip hotovo za ${elapsed} s — ${processed} firem přidáno`);
  console.log(`  orphan parents zbývá: ${(await getOrphanParents(idx, 9999)).length}`);
  console.log(`  next keyword index: ${state.keywordIndex}`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
