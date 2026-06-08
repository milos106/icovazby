// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Holding discovery — auto-rozkrytí struktury holdingu z parent IČO.
 *
 * Algoritmus: BFS po grafu firma→firma s dvěma typy hran:
 *   1. Sdílený jednatel: firma B má v statutárním orgánu osobu, která
 *      sedí i ve firmě A (z lokálního indexu osoba→firmy).
 *   2. Akcionář: firma B má jako akcionáře právnickou osobu A (přímo
 *      z OR detail.akcionar.osoby[].ico).
 *
 * Confidence:
 *   - HIGH: parent IČO je přímo akcionář kandidáta (akcionář hrana
 *           je nezpochybnitelný signál vlastnictví).
 *   - MEDIUM: ≥2 jednatelé sdíleni mezi parent a kandidátem.
 *   - LOW: 1 jednatel sdílen NEBO firma byla nalezena přes 2. úroveň
 *          (subsidiary subsidiary).
 *
 * Limity:
 *   - depth ∈ {1, 2, 3} — kolik hopů od parent zkoumat
 *   - maxIcos — strop na velikost výsledku (default 50, UI graf je čitelný do ~30)
 *   - cap na fetchované firmy za běhu (4× maxIcos) — chrání proti explozi
 */

import pLimit from "p-limit";
import type { AresClient } from "../ares/client.js";
import { validateIco as validateIcoFn } from "../ares/normalize.js";
import { flattenMembers } from "../ares/vr.js";
import { cached } from "../cache.js";
import { InvalidInputError } from "../errors.js";
import { fetchVrDetailByIco } from "../justice_vr/client.js";
import { findMemberships, listSubjects } from "../persons_index/store.js";

// Globální per-běh limit souběžných ARES/VR calls. Bez něj jeden holding
// na velkou firmu pošle desítky requestů paralelně a banne nás z ARES.
const aresLimit = pLimit(Number(process.env.HOLDING_CONCURRENCY ?? 3));

export interface DiscoveredCompany {
  ico: string;
  obchodniJmeno: string | null;
  level: number;
  confidence: "high" | "medium" | "low";
  signals: string[];
  jednateleShared: string[];
}

export interface HoldingDiscoveryResult {
  parent: { ico: string; obchodniJmeno: string | null };
  discovered: DiscoveredCompany[];
  totalIcos: number;
  truncated: boolean;
  walkedFirms: number;
  depthUsed: number;
}

interface Candidate {
  ico: string;
  level: number;
  obchodniJmeno: string | null;
  signals: Set<string>;
  jednateleShared: Set<string>;
  isParentAkcionar: boolean;
  sharedStatutaryWithParent: Set<string>;
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function personKey(jmeno: string, prijmeni: string, datumNarozeni: string): string {
  return `${normalize(jmeno)}|${normalize(prijmeni)}|${datumNarozeni}`;
}

/**
 * Extrakce osob ze statutárního orgánu firmy. Vrátí seznam
 * (jmeno, prijmeni, datumNarozeni) pro každou fyzickou osobu.
 * Bere VR (z ARES) i OR (z verejnerejstriky.msp.gov.cz) — OR má
 * pole jmeno/prijmeni/datumNarozeni přímo, VR potřebuje flattenMembers.
 */
async function getStatutaryPersons(
  client: AresClient,
  ico: string,
  includeHistorical = false,
): Promise<Array<{ jmeno: string; prijmeni: string; datumNarozeni: string }>> {
  const persons: Array<{ jmeno: string; prijmeni: string; datumNarozeni: string }> = [];
  try {
    const vr = await cached(`vr:raw:${ico}`, () => aresLimit(() => client.getVrRecord(ico)));
    const members = flattenMembers(vr, { activeOnly: !includeHistorical });
    for (const m of members) {
      const fo = m.fyzickaOsoba;
      if (!fo?.jmeno || !fo.prijmeni || !fo.datumNarozeni) continue;
      persons.push({ jmeno: fo.jmeno, prijmeni: fo.prijmeni, datumNarozeni: fo.datumNarozeni });
    }
  } catch {
    /* VR může chybět (firma zanikla, OSVČ, etc.) — vrátíme co máme */
  }
  return persons;
}

/**
 * Z OR detailu vytáhne akcionáře, kteří jsou PRÁVNICKÉ osoby (mají
 * IČO). Tyto IČO se přidávají do queue jako "akcionář signál".
 */
async function getAkcionarLegalEntities(
  client: AresClient,
  ico: string,
  includeHistorical = false,
): Promise<string[]> {
  // ARES VR endpoint má `akcionari` s plnou historií. Předtím jsme používali
  // VR portal /api/rejstriky/detail/:ico, ale ten je v ověřovacím provozu
  // a často vrací { message: error } místo detailu (např. pro ZZN Polabí).
  // ARES VR je authoritativní a vrátí všechny PO akcionáře včetně historických.
  try {
    const vr = await cached(`vr:raw:${ico}`, () => aresLimit(() => client.getVrRecord(ico)));
    const out = new Set<string>();
    type AkcionarBlock = {
      datumZapisu?: string;
      datumVymazu?: string | null;
      clenoveOrganu?: Array<{
        datumVymazu?: string | null;
        pravnickaOsoba?: { ico?: string };
      }>;
    };
    for (const zaznam of (vr as { zaznamy?: Array<{ akcionari?: AkcionarBlock[] }> }).zaznamy ?? []) {
      for (const blok of zaznam.akcionari ?? []) {
        if (!includeHistorical && blok.datumVymazu) continue;
        for (const clen of blok.clenoveOrganu ?? []) {
          if (!includeHistorical && clen.datumVymazu) continue;
          const akcIco = clen.pravnickaOsoba?.ico;
          if (akcIco && /^\d{7,8}$/.test(akcIco)) {
            out.add(akcIco.padStart(8, "0"));
          }
        }
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

/**
 * Zjistí, ve kterých dalších firmách osoba sedí (přes lokální index).
 * HS se neptáme — tato funkce běží pro každého jednatele v levelu,
 * takže by HS dotazy explodovaly. Lokální index je instant a stačí
 * pro to, co aplikace už prošla.
 */
function getPersonOtherCompanies(
  jmeno: string,
  prijmeni: string,
  datumNarozeni: string,
): string[] {
  const p = findMemberships(jmeno, prijmeni, datumNarozeni);
  if (!p) return [];
  const out: string[] = [];
  for (const m of p.memberships) out.push(m.ico);
  return [...new Set(out)];
}

export async function discoverHolding(
  client: AresClient,
  parentIcoInput: string,
  depth = 2,
  maxIcos = 50,
  includeHistorical = false,
): Promise<HoldingDiscoveryResult> {
  const v = validateIcoFn(parentIcoInput);
  if (!v.valid || !v.normalized) throw new InvalidInputError("Neplatné parent IČO.");
  const parent = v.normalized;
  if (depth < 1 || depth > 3) {
    throw new InvalidInputError("Depth musí být 1, 2 nebo 3.");
  }
  if (maxIcos < 5 || maxIcos > 200) {
    throw new InvalidInputError("maxIcos musí být 5–200.");
  }

  const candidates = new Map<string, Candidate>();
  const visited = new Set<string>([parent]);

  // Statutáři parent firmy — slouží jako reference pro „shared statutary"
  // signál. Klíče v setu jsou normalizované person-key.
  const parentStatutary = new Set<string>();
  let parentObchodniJmeno: string | null = null;
  try {
    const subject = await cached(`subj:${parent}`, () => aresLimit(() => client.getEconomicSubject(parent)));
    parentObchodniJmeno = subject.obchodniJmeno ?? null;
  } catch {
    /* ignore */
  }
  const parentPersons = await getStatutaryPersons(client, parent, includeHistorical);
  for (const p of parentPersons) {
    parentStatutary.add(personKey(p.jmeno, p.prijmeni, p.datumNarozeni));
  }

  // BFS queue
  interface QueueItem {
    ico: string;
    level: number;
    fromParent: boolean; // true pro level 1, false dál
  }
  const queue: QueueItem[] = [{ ico: parent, level: 0, fromParent: true }];
  let walkedFirms = 0;
  const fetchCap = maxIcos * 4;

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    if (item.level >= depth) continue;
    if (walkedFirms >= fetchCap) break;
    walkedFirms++;

    // Krok A: získat akcionáře této firmy (jen pro level >= 1 — parent
    // sám sebe akcionářem nedělá).
    const akcionari = item.level >= 0 ? await getAkcionarLegalEntities(client, item.ico, includeHistorical) : [];

    // Krok B: získat jednatele této firmy a pro každého ho cross-refnout
    // přes lokální index.
    const persons = await getStatutaryPersons(client, item.ico, includeHistorical);
    const personOtherIcos = new Map<string, { fullName: string; icos: string[] }>();
    for (const p of persons) {
      const otherIcos = getPersonOtherCompanies(p.jmeno, p.prijmeni, p.datumNarozeni)
        .filter((other) => other !== item.ico && other !== parent);
      const fullName = `${p.jmeno} ${p.prijmeni}`;
      personOtherIcos.set(personKey(p.jmeno, p.prijmeni, p.datumNarozeni), {
        fullName,
        icos: otherIcos,
      });
    }

    // Krok C: agregace kandidátů z akcionářů (= silný signál) a z osob.
    const nextLevel = item.level + 1;
    const seenThisRound = new Set<string>();

    for (const ico of akcionari) {
      if (ico === parent || ico === item.ico || visited.has(ico)) continue;
      seenThisRound.add(ico);
      const cand = candidates.get(ico) || {
        ico,
        level: nextLevel,
        obchodniJmeno: null,
        signals: new Set<string>(),
        jednateleShared: new Set<string>(),
        isParentAkcionar: false,
        sharedStatutaryWithParent: new Set<string>(),
      };
      cand.signals.add(item.ico === parent ? "parent-akcionar-chain" : `akcionar-of:${item.ico}`);
      // Pokud item == parent, neaplikuje se (parent není akcionář sebe).
      // Pokud naopak parent je akcionářem v item, byl by item už ve výsledku
      // jako kandidát; tento směr (akcionář NA item) je opačný.
      candidates.set(ico, cand);
    }

    for (const [, { fullName, icos }] of personOtherIcos) {
      for (const ico of icos) {
        if (ico === parent || ico === item.ico || visited.has(ico)) continue;
        seenThisRound.add(ico);
        const cand = candidates.get(ico) || {
          ico,
          level: nextLevel,
          obchodniJmeno: null,
          signals: new Set<string>(),
          jednateleShared: new Set<string>(),
          isParentAkcionar: false,
          sharedStatutaryWithParent: new Set<string>(),
        };
        cand.jednateleShared.add(fullName);
        cand.signals.add(item.ico === parent ? `shared-statutary-with-parent` : `via:${item.ico}`);
        if (parentStatutary.has(personKey(fullName.split(" ")[0], fullName.split(" ").slice(1).join(" "), persons.find((p) => `${p.jmeno} ${p.prijmeni}` === fullName)?.datumNarozeni ?? ""))) {
          cand.sharedStatutaryWithParent.add(fullName);
        }
        candidates.set(ico, cand);
      }
    }

    // Krok D: označit parent jako akcionář pro kandidáty, pokud akcionáři
    // KANDIDÁTA obsahují parent IČO. To se dělá tak, že pro level 1 firem
    // při fetchování VR detailu zkontrolujeme akcionáře.
    if (item.level === 0) {
      // Pro level 0 (parent) — jednorázové cyklování pro každou level-1
      // kandidátní firmu detekuje, zda parent je jejím akcionářem.
      for (const ico of seenThisRound) {
        const akc = await getAkcionarLegalEntities(client, ico, includeHistorical);
        if (akc.includes(parent)) {
          const cand = candidates.get(ico);
          if (cand) {
            cand.isParentAkcionar = true;
            cand.signals.add("parent-je-akcionar");
          }
        }
      }
    }

    // Enqueue pro další level pokud jsme nedosáhli hloubky a počtu IČO
    if (nextLevel < depth && candidates.size < maxIcos) {
      for (const ico of seenThisRound) {
        if (visited.has(ico)) continue;
        visited.add(ico);
        queue.push({ ico, level: nextLevel, fromParent: false });
      }
    } else {
      for (const ico of seenThisRound) visited.add(ico);
    }
  }

  // Krok D2: Reverse holding scan — projít VŠECHNY firmy v subjekt inventáři
  // (firmy, které uživatel kdy projel přes DD/VR) a u každé zkontrolovat
  // zda parent je v akcionářích NEBO v statutárním orgánu jako právnická
  // osoba. Tím chytíme „obrácený směr": dceřinky kde Agrofert je akcionář
  // bez sdíleného jednatele (např. ZZN Polabí).
  const subjects = listSubjects()
    .map((s) => s.ico)
    .filter((ico) => ico !== parent && !candidates.has(ico) && !visited.has(ico));
  if (subjects.length > 0) {
    const reverseHits = await Promise.all(
      // Reverse scan má vyšší cap (5000) než BFS — projíždíme jen lokálně
      // známé subjects, ARES VR call je paralelní s rate-limit. Pro 16k
      // subjects to znamená cca 30 s; můžeme za to spolehlivě najít všechny
      // akcionářské vazby (např. ZZN Polabí je s indexem ~10 000).
      subjects.slice(0, 5000).map(async (ico) => {
        try {
          // Akcionáře získáme z ARES VR (authoritativní zdroj, vždy odpovídá).
          // VR portal /api/rejstriky/detail je v ověřovacím provozu a často
          // selhává — pro ZZN Polabí např. vrací {message: error}. Předtím
          // jsme z toho early-return-ovali a chyběli akcionářské nálezy.
          const akcionari = await getAkcionarLegalEntities(client, ico, includeHistorical);
          const parentIsAkcionar = akcionari.includes(parent);

          // VR portal detail je nice-to-have pro: (a) obchodniJmeno, (b)
          // statutární orgán právnické osoby. Jeho selhání neblokuje hit.
          let parentInStat = false;
          let obchodniJmeno: string | null = null;
          try {
            const detail = await cached(`vrportal:${ico}`, () => aresLimit(() => fetchVrDetailByIco(ico)));
            if (detail) {
              obchodniJmeno = detail.nazev?.value ?? null;
              for (const raw of (detail.statutarniOrgan?.osoby ?? []) as Array<{
                value?: { osoba?: { ico?: string } };
              }>) {
                if ((raw.value?.osoba?.ico ?? "").padStart(8, "0") === parent) {
                  parentInStat = true;
                  break;
                }
              }
            }
          } catch {
            /* VR portal nedostupný — pokračujeme jen s akcionáři */
          }

          if (!parentIsAkcionar && !parentInStat) return null;
          return { ico, obchodniJmeno, isParentAkcionar: parentIsAkcionar, parentInStat };
        } catch {
          return null;
        }
      }),
    );
    for (const hit of reverseHits) {
      if (!hit) continue;
      const cand: Candidate = {
        ico: hit.ico,
        level: 1,
        obchodniJmeno: hit.obchodniJmeno,
        signals: new Set<string>(),
        jednateleShared: new Set<string>(),
        isParentAkcionar: hit.isParentAkcionar,
        sharedStatutaryWithParent: new Set<string>(),
      };
      if (hit.isParentAkcionar) cand.signals.add("parent-je-akcionar");
      if (hit.parentInStat) cand.signals.add("parent-ve-statutaru");
      candidates.set(hit.ico, cand);
      walkedFirms++;
    }
  }

  // Krok E: doplnit obchodní jména pro kandidáty (rychlý ARES profile lookup).
  // Paralelně přes p-limit, aby se ARES nezaplavil.
  const candList = [...candidates.values()];
  await Promise.all(
    candList.slice(0, maxIcos).map(async (c) => {
      try {
        const subject = await cached(
          `subj:${c.ico}`,
          () => aresLimit(() => client.getEconomicSubject(c.ico)),
        );
        c.obchodniJmeno = subject.obchodniJmeno ?? null;
      } catch {
        /* firma možná zanikla nebo invalid ICO */
      }
    }),
  );

  // Krok F: confidence ranking
  function scoreOf(c: Candidate): "high" | "medium" | "low" {
    if (c.isParentAkcionar) return "high";
    if (c.sharedStatutaryWithParent.size >= 2) return "high";
    if (c.sharedStatutaryWithParent.size === 1) return "medium";
    if (c.level >= 2) return "low";
    return "medium";
  }

  const discovered: DiscoveredCompany[] = candList.map((c) => ({
    ico: c.ico,
    obchodniJmeno: c.obchodniJmeno,
    level: c.level,
    confidence: scoreOf(c),
    signals: [...c.signals],
    jednateleShared: [...c.jednateleShared],
  }));

  // Seřadit podle confidence (high → medium → low), pak podle počtu sdílených
  discovered.sort((a, b) => {
    const scoreMap = { high: 0, medium: 1, low: 2 };
    const sa = scoreMap[a.confidence];
    const sb = scoreMap[b.confidence];
    if (sa !== sb) return sa - sb;
    return b.jednateleShared.length - a.jednateleShared.length;
  });

  const truncated = discovered.length > maxIcos;
  const trimmed = discovered.slice(0, maxIcos);

  return {
    parent: { ico: parent, obchodniJmeno: parentObchodniJmeno },
    discovered: trimmed,
    totalIcos: trimmed.length,
    truncated,
    walkedFirms,
    depthUsed: depth,
  };
}
