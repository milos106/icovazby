// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Vazby osoby" — vezme jméno + datum narození, najde osobu v Hlídači státu,
 * stáhne všechny historické vazby (členství v orgánech, politické posty),
 * a dohrá IČO z ARES podle názvu firmy.
 *
 * Typický use case: v DD reportu klikneš na statutární orgán → uvidíš ve
 * kterých dalších firmách (taky historicky) tato osoba seděla, plus button
 * "Vykreslit graf" který pošle resolvované IČOs do Mapy propojení.
 *
 * Bottleneck: HS udalosti vrací jen NÁZVY firem (string), ne IČO. Resolve je
 * tedy ARES search per název. Rate-limit ARES je 5/s, hard-cap 50 unikátních
 * firem na osobu (Babiš = 30+, většina hlavounů se vleze). Výsledky se
 * cachují v paměti 24 h sdíleně mezi všemi requesty.
 */

import type { AresClient } from "../ares/client.js";
import { InvalidInputError } from "../errors.js";
import {
  HlidacStatuMissingTokenError,
  fetchOsobaDetail,
  searchOsoby,
} from "../hlidacstatu/client.js";
import { findMemberships, type IndexedMembership } from "../persons_index/store.js";

/** Tituly, které smažeme před oddělením jméno/příjmení. */
const TITLE_TOKENS = new Set([
  "ing",
  "ing.",
  "bc",
  "bc.",
  "mgr",
  "mgr.",
  "mudr",
  "mudr.",
  "judr",
  "judr.",
  "phdr",
  "phdr.",
  "rndr",
  "rndr.",
  "mvdr",
  "mvdr.",
  "paedr",
  "paedr.",
  "pharmdr",
  "pharmdr.",
  "doc",
  "doc.",
  "prof",
  "prof.",
  "csc",
  "csc.",
  "drsc",
  "drsc.",
  "phd",
  "ph.d.",
  "mba",
  "mba.",
  "dis",
  "dis.",
  "ba",
  "ma",
  "msc",
  "lic",
  "lic.",
  "th.d.",
  "thlic.",
]);

export interface ParsedName {
  jmeno: string;
  prijmeni: string;
  titulPred: string;
  titulPo: string;
}

/**
 * Rozparsuje "Ing. ZBYNĚK PRŮŠA" na {jmeno: "ZBYNĚK", prijmeni: "PRŮŠA"}.
 * Vícejmenné "JAN MARTIN NOVÁK" → jmeno = "JAN MARTIN", prijmeni = "NOVÁK".
 */
export function parseFullName(full: string): ParsedName {
  const tokens = full.trim().split(/\s+/).filter(Boolean);
  const titulPredArr: string[] = [];
  const middle: string[] = [];
  const titulPoArr: string[] = [];
  // Vezmeme titles ze začátku
  let i = 0;
  while (i < tokens.length && TITLE_TOKENS.has(tokens[i].toLowerCase())) {
    titulPredArr.push(tokens[i]);
    i++;
  }
  // Titles ze konce
  let j = tokens.length - 1;
  while (j >= i && TITLE_TOKENS.has(tokens[j].toLowerCase().replace(/,$/, ""))) {
    titulPoArr.unshift(tokens[j].replace(/,$/, ""));
    j--;
  }
  // Zbytek = jméno(a) + příjmení
  for (let k = i; k <= j; k++) middle.push(tokens[k]);
  if (middle.length === 0) {
    return { jmeno: "", prijmeni: "", titulPred: titulPredArr.join(" "), titulPo: titulPoArr.join(" ") };
  }
  const prijmeni = middle[middle.length - 1];
  const jmeno = middle.slice(0, -1).join(" ");
  return {
    jmeno,
    prijmeni,
    titulPred: titulPredArr.join(" "),
    titulPo: titulPoArr.join(" "),
  };
}

/** YYYY-MM-DD validace. */
function normalizeDate(input: string): string | null {
  const m = input.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// Typy událostí, které pro DD účely vykládáme jako "vazba na organizaci".
// Nezahrnujeme Politickou stranu (zájem o firmu), členství v politické straně
// samo o sobě není vazba k firmě (i když v UI to může být relevantní).
const VAZBA_TYPES = new Set([
  "Soukromá pracovní",
  "Vazby",
  "Politická exekutivní",
  "Veřejná správa jiné",
  "Volená funkce",
]);

const MAX_UNIQUE_COMPANIES = 50;
const ICO_RESOLVE_TTL_MS = 24 * 60 * 60 * 1000;

interface IcoResolution {
  ico: string | null;
  obchodniJmeno: string | null;
  ambiguousMatchCount: number; // 0 = no match, 1 = unique, >1 = ambiguous
  resolvedAt: number;
}

const icoCache = new Map<string, IcoResolution>();

/**
 * Normalizace názvu firmy pro cache klíč.
 * "AGROFERT, a.s." → "agrofert as"; ", " kolapsuje na " ".
 */
function normalizeCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function resolveIcoForName(client: AresClient, name: string): Promise<IcoResolution> {
  const key = normalizeCompanyKey(name);
  if (!key) return { ico: null, obchodniJmeno: null, ambiguousMatchCount: 0, resolvedAt: Date.now() };
  const cached = icoCache.get(key);
  if (cached && Date.now() - cached.resolvedAt < ICO_RESOLVE_TTL_MS) return cached;

  try {
    const result = await client.searchEconomicSubjects({
      obchodniJmeno: name,
      pocet: 5,
      start: 0,
    });
    const total = result.pocetCelkem ?? 0;
    const subjects = result.ekonomickeSubjekty ?? [];
    let resolved: IcoResolution;
    if (total === 0 || subjects.length === 0) {
      resolved = { ico: null, obchodniJmeno: null, ambiguousMatchCount: 0, resolvedAt: Date.now() };
    } else if (total === 1 || subjects.length === 1) {
      const s = subjects[0];
      resolved = {
        ico: s.ico,
        obchodniJmeno: s.obchodniJmeno ?? null,
        ambiguousMatchCount: 1,
        resolvedAt: Date.now(),
      };
    } else {
      // Více než 1 match — zkus přesnou shodu na normalizovaný název.
      const exact = subjects.find((s) => normalizeCompanyKey(s.obchodniJmeno ?? "") === key);
      if (exact) {
        resolved = {
          ico: exact.ico,
          obchodniJmeno: exact.obchodniJmeno ?? null,
          ambiguousMatchCount: 1,
          resolvedAt: Date.now(),
        };
      } else {
        // Zaznamenat ambiguitu, vrátit top hit jako návrh
        const top = subjects[0];
        resolved = {
          ico: top.ico,
          obchodniJmeno: top.obchodniJmeno ?? null,
          ambiguousMatchCount: total,
          resolvedAt: Date.now(),
        };
      }
    }
    icoCache.set(key, resolved);
    return resolved;
  } catch {
    // Neselháváme celou vazbu kvůli jedné resolution chybě.
    const fail: IcoResolution = {
      ico: null,
      obchodniJmeno: null,
      ambiguousMatchCount: 0,
      resolvedAt: Date.now(),
    };
    return fail;
  }
}

export interface PersonVazba {
  typ: string;
  organizace: string;
  role: string | null;
  datumOd: string | null;
  datumDo: string | null;
  isActive: boolean;
  resolvedIco: string | null;
  resolvedName: string | null;
  ambiguousMatchCount: number;
  /** "LOCAL_INDEX" = z lokálního perzistent indexu (ARES_VR/OR/UBO union),
   *  "HLIDAC_STATU" = z HS osoby udalosti. */
  source: "LOCAL_INDEX" | "HLIDAC_STATU";
}

export interface PersonVazbyResult {
  person: {
    jmeno: string;
    prijmeni: string;
    titulPred: string | null;
    titulPo: string | null;
    narozeni: string | null;
    nameId: string | null;
    profileUrl: string | null;
  };
  vazby: PersonVazba[];
  truncated: boolean;
  totalUnique: number;
  resolved: number;
  /** Souhrn co se použilo pro UI hlášku. */
  sources: {
    localIndexHits: number;
    hlidacStatuHits: number;
    hlidacStatuAvailable: boolean;
  };
}

export interface PersonVazbyArgs {
  jmeno: string;
  prijmeni?: string;
  datumNarozeni: string;
  includeHistorical?: boolean;
  resolveIco?: boolean;
}

export async function getPersonVazbyService(
  client: AresClient,
  args: PersonVazbyArgs,
): Promise<PersonVazbyResult> {
  let { jmeno: rawJmeno } = args;
  let prijmeni = args.prijmeni ?? "";
  if (!prijmeni) {
    const parsed = parseFullName(rawJmeno);
    rawJmeno = parsed.jmeno;
    prijmeni = parsed.prijmeni;
  }
  if (!rawJmeno || !prijmeni) {
    throw new InvalidInputError("Jméno i příjmení jsou povinné — nebylo možné rozparsovat plné jméno.");
  }
  const date = normalizeDate(args.datumNarozeni);
  if (!date) throw new InvalidInputError("Neplatné datum narození (vyžaduje YYYY-MM-DD).");

  // 1) Lokální index — instant, žádné síťové dotazy. Pokrytí: všichni
  // statutáři a další osoby z firem které kdy aplikace prošla.
  const localPerson = findMemberships(rawJmeno, prijmeni, date);
  const includeHistorical = args.includeHistorical !== false;
  // Mapování source → kategorie typu vazby (pro UI sloupec „Typ")
  const categoryOf = (s: IndexedMembership["source"]): string =>
    s === "OR_DR" ? "Dozorčí rada"
      : s === "OR_AKC" ? "Akcionář/společník"
      : s === "UBO" ? "Skutečný majitel"
      : "Statutární orgán";
  // Dedup mezi lokálními zdroji: stejná firma + stejná kategorie + stejné
  // datumZapisu → jeden záznam (OR má detailnější data, preferujeme).
  const dedupMap = new Map<string, PersonVazba>();
  for (const m of localPerson?.memberships ?? []) {
    if (!includeHistorical && m.datumVymazu) continue;
    const category = categoryOf(m.source);
    const key = `${m.ico}|${category}|${(m.funkce ?? "").toLowerCase()}`;
    const incoming: PersonVazba = {
      typ: category,
      organizace: m.obchodniJmeno ?? m.ico,
      role: m.funkce,
      datumOd: m.datumZapisu,
      datumDo: m.datumVymazu,
      isActive: !m.datumVymazu,
      resolvedIco: m.ico,
      resolvedName: m.obchodniJmeno,
      ambiguousMatchCount: 1,
      source: "LOCAL_INDEX",
    };
    const existing = dedupMap.get(key);
    if (!existing) {
      dedupMap.set(key, incoming);
      continue;
    }
    // Preferujeme zdroj s konkrétnějším datumZapisu (OR > ARES_VR)
    const incomingHasDate = Boolean(incoming.datumOd);
    const existingHasDate = Boolean(existing.datumOd);
    if (incomingHasDate && !existingHasDate) dedupMap.set(key, incoming);
  }
  const localVazby = [...dedupMap.values()];
  localVazby.sort((a, b) => (b.datumOd ?? "").localeCompare(a.datumOd ?? ""));

  // 2) Lookup osoby v HS — jen pokud token. Selhání jakéhokoli kroku
  // znamená že použijeme jen lokální data.
  let hsAvailable = false;
  let hsPerson: {
    jmeno: string;
    prijmeni: string;
    titulPred: string | null;
    titulPo: string | null;
    narozeni: string | null;
    nameId: string;
    profileUrl: string;
  } | null = null;
  let udalosti: Array<{ typ?: string; organizace?: string; role?: string | null; datumOd?: string | null; datumDo?: string | null }> = [];
  try {
    const matches = await searchOsoby(rawJmeno, prijmeni, date);
    if (matches.length > 0) {
      hsAvailable = true;
      const top = matches[0];
      const detail = await fetchOsobaDetail(top.nameId);
      hsPerson = {
        jmeno: detail.jmeno ?? rawJmeno,
        prijmeni: detail.prijmeni ?? prijmeni,
        titulPred: detail.titulPred ?? null,
        titulPo: detail.titulPo ?? null,
        narozeni: detail.narozeni ? detail.narozeni.slice(0, 10) : date,
        nameId: detail.nameId,
        profileUrl: `https://www.hlidacstatu.cz${detail.profile}`,
      };
      udalosti = (detail.udalosti ?? []).filter((u) => VAZBA_TYPES.has(u.typ ?? ""));
    }
  } catch (e) {
    if (e instanceof HlidacStatuMissingTokenError) {
      // Pokračujeme jen s lokálními daty.
    } else {
      // Network / 5xx — nevyhazujeme, jen vynecháme HS.
    }
  }

  // 3) HS události — filtr historical, sort, dedup
  const filtered = includeHistorical ? udalosti : udalosti.filter((u) => !u.datumDo);
  const uniqueOrgs = new Set<string>();
  const ordered: typeof filtered = [];
  for (const u of filtered) {
    const org = (u.organizace ?? "").trim();
    if (!org) continue;
    ordered.push(u);
    uniqueOrgs.add(org);
  }
  ordered.sort((a, b) => (b.datumOd ?? "").localeCompare(a.datumOd ?? ""));

  // 4) ARES resolve — pouze HS události s názvy firem (lokální index už má IČO)
  const resolveIco = args.resolveIco !== false;
  const orgsToResolve = [...uniqueOrgs].slice(0, MAX_UNIQUE_COMPANIES);
  const truncated = uniqueOrgs.size > MAX_UNIQUE_COMPANIES;
  const resolutions = new Map<string, IcoResolution>();
  if (resolveIco) {
    const results = await Promise.all(
      orgsToResolve.map(async (name) => ({ name, res: await resolveIcoForName(client, name) })),
    );
    for (const { name, res } of results) resolutions.set(name, res);
  }

  const hsVazby: PersonVazba[] = ordered.map((u) => {
    const org = (u.organizace ?? "").trim();
    const res = resolutions.get(org);
    return {
      typ: u.typ ?? "",
      organizace: org,
      role: u.role ?? null,
      datumOd: u.datumOd ? u.datumOd.slice(0, 10) : null,
      datumDo: u.datumDo ? u.datumDo.slice(0, 10) : null,
      isActive: !u.datumDo,
      resolvedIco: res?.ico ?? null,
      resolvedName: res?.obchodniJmeno ?? null,
      ambiguousMatchCount: res?.ambiguousMatchCount ?? 0,
      source: "HLIDAC_STATU",
    };
  });

  // 5) Spojení local + HS, dedup podle (ico, funkce). Local-first priorita
  // protože má spolehlivé datumZapisu z OR/ARES VR a IČO bez ambiguity.
  const combined: PersonVazba[] = [...localVazby];
  const seenLocalKeys = new Set(
    localVazby.map((v) => `${v.resolvedIco ?? ""}|${(v.role ?? "").toLowerCase()}`),
  );
  for (const v of hsVazby) {
    const key = `${v.resolvedIco ?? ""}|${(v.role ?? "").toLowerCase()}`;
    if (v.resolvedIco && seenLocalKeys.has(key)) continue;
    combined.push(v);
  }

  let resolved = 0;
  const seenIcos = new Set<string>();
  for (const v of combined) {
    if (v.resolvedIco && !seenIcos.has(v.resolvedIco) && v.ambiguousMatchCount === 1) {
      seenIcos.add(v.resolvedIco);
      resolved++;
    }
  }

  const totalUnique = new Set(combined.map((v) => v.resolvedIco ?? v.organizace)).size;

  // LIA (docs/GDPR_LIA_VAZBY_OSOBY.md, záruka #2): datum narození se NEVRACÍ ve
  // výstupu. Uživatel ho zadal na vstupu (model „potvrzuji, neobjevuji"), takže
  // opisovat ho zpět je zbytečné a bránilo by to úniku DOB třetí osoby.
  const personOut = hsPerson ?? {
    jmeno: rawJmeno,
    prijmeni,
    titulPred: localPerson?.titulPred ?? null,
    titulPo: null,
    narozeni: null as string | null,
    nameId: null,
    profileUrl: null,
  };
  personOut.narozeni = null;

  return {
    person: personOut,
    vazby: combined,
    truncated,
    totalUnique,
    resolved,
    sources: {
      localIndexHits: localVazby.length,
      hlidacStatuHits: hsVazby.length,
      hlidacStatuAvailable: hsAvailable,
    },
  };
}
