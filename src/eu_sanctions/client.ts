// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * EU consolidated financial sanctions list client.
 *
 * Zdroj: oficiální XML feed Evropské komise (FSF — Financial Sanctions Files),
 * dokumentovaný na EU Open Data Portal jako veřejně dostupný:
 *
 *   https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw
 *
 * Token `dG9rZW4tMjAxNw` (base64 "token-2017") je oficiální veřejný token
 * pro nepřihlášený přístup; je explicitně publikovaný na data.europa.eu
 * jako URL distribuce datasetu. (Komerční stakeholders mají vlastní
 * EU Login tokeny, ale pro reuse open-data je výchozí token správný.)
 *
 * Licence: EU institucionální data — Commission Decision 2011/833/EU
 * (volné užití včetně komerčního, požadavek uvedení zdroje).
 *
 * Velikost: ~25 MB XML, ~6000 sanctionEntity záznamů, generováno průběžně.
 * Cachujeme 24 h.
 */

import { XMLParser } from "fast-xml-parser";
import { fetch as undiciFetch } from "undici";

const DEFAULT_URL =
  "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw";
const TIMEOUT_MS = 60000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface EuSanctionsEntity {
  logicalId: string;
  euReferenceNumber: string;
  subjectType: "person" | "enterprise" | "unknown";
  programmes: string[]; // např. RUS, IRN, MLI — režim sankcí
  remark: string | null;
  aliases: Array<{
    wholeName: string;
    firstName: string;
    lastName: string;
    strong: boolean;
  }>;
  birthYears: number[];
  citizenships: string[]; // ISO2 kódy
  publicationUrls: string[];
}

interface RawAlias {
  "@_wholeName"?: string;
  "@_firstName"?: string;
  "@_lastName"?: string;
  "@_strong"?: string;
}

interface RawRegulation {
  "@_programme"?: string;
  publicationUrl?: string;
}

interface RawBirthdate {
  "@_year"?: string;
  "@_birthdate"?: string;
}

interface RawCitizenship {
  "@_countryIso2Code"?: string;
}

interface RawEntity {
  "@_logicalId"?: string;
  "@_euReferenceNumber"?: string;
  subjectType?: { "@_code"?: string };
  remark?: string | string[];
  regulation?: RawRegulation | RawRegulation[];
  nameAlias?: RawAlias | RawAlias[];
  birthdate?: RawBirthdate | RawBirthdate[];
  citizenship?: RawCitizenship | RawCitizenship[];
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Diacritics-free lowercased normalization for fuzzy matching.
 * "Krčmář" → "krcmar", "İsmail" → "ismail".
 */
export function normalizeNameForMatching(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalized token set — order-insensitive multi-word matching.
 * Returns sorted distinct alpha tokens joined by space.
 */
export function tokenSetKey(s: string): string {
  const tokens = normalizeNameForMatching(s).split(" ").filter((t) => t.length >= 2);
  return [...new Set(tokens)].sort().join(" ");
}

interface AliasIndex {
  entity: EuSanctionsEntity;
  aliasIdx: number;
  tokens: Set<string>;
}

interface Snapshot {
  loadedAt: number;
  generationDate: string | null;
  entities: EuSanctionsEntity[];
  // Inverted token index: token → aliasy obsahující ten token.
  // Umožňuje subset matching: "vladimir putin" → "vladimir vladimirovich putin".
  byToken: Map<string, AliasIndex[]>;
}

let snapshot: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;

function parseEntity(raw: RawEntity): EuSanctionsEntity {
  const code = raw.subjectType?.["@_code"] ?? "unknown";
  const subjectType: EuSanctionsEntity["subjectType"] =
    code === "person" ? "person" : code === "enterprise" ? "enterprise" : "unknown";

  const regs = asArray(raw.regulation);
  const programmesSet = new Set<string>();
  const publicationUrls: string[] = [];
  for (const r of regs) {
    if (r["@_programme"]) programmesSet.add(r["@_programme"]);
    if (r.publicationUrl && /^https?:\/\//i.test(r.publicationUrl)) publicationUrls.push(r.publicationUrl); // jen http(s) → :href nemůže být javascript:
  }

  const aliases = asArray(raw.nameAlias).map((a) => ({
    wholeName: (a["@_wholeName"] ?? "").trim(),
    firstName: (a["@_firstName"] ?? "").trim(),
    lastName: (a["@_lastName"] ?? "").trim(),
    strong: a["@_strong"] === "true",
  }));

  const birthYearsSet = new Set<number>();
  for (const b of asArray(raw.birthdate)) {
    const y = Number.parseInt(b["@_year"] ?? "", 10);
    if (Number.isFinite(y) && y > 1800 && y < 2100) birthYearsSet.add(y);
  }

  const citizenshipsSet = new Set<string>();
  for (const c of asArray(raw.citizenship)) {
    if (c["@_countryIso2Code"]) citizenshipsSet.add(c["@_countryIso2Code"]);
  }

  return {
    logicalId: raw["@_logicalId"] ?? "",
    euReferenceNumber: raw["@_euReferenceNumber"] ?? "",
    subjectType,
    programmes: [...programmesSet],
    remark: Array.isArray(raw.remark) ? raw.remark[0] ?? null : raw.remark ?? null,
    aliases,
    birthYears: [...birthYearsSet].sort(),
    citizenships: [...citizenshipsSet],
    publicationUrls,
  };
}

async function fetchXml(): Promise<{ xml: string; generationDate: string | null }> {
  const url = process.env.EU_SANCTIONS_URL?.trim() || DEFAULT_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await undiciFetch(url, {
      redirect: "follow",
      headers: {
        accept: "application/xml,text/xml",
        "user-agent": "ares-web/0.2 (+https://github.com/milos106/ares-web)",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`EU sanctions HTTP ${response.status}`);
    }
    const xml = await response.text();
    const m = xml.match(/generationDate="([^"]+)"/);
    return { xml, generationDate: m ? m[1] : null };
  } finally {
    clearTimeout(timer);
  }
}

async function buildSnapshot(): Promise<Snapshot> {
  const { xml, generationDate } = await fetchXml();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseAttributeValue: false,
    trimValues: true,
  });
  const parsed = parser.parse(xml);
  const rawEntities = asArray<RawEntity>(parsed?.export?.sanctionEntity);
  const entities = rawEntities.map(parseEntity);

  // Postavíme inverted index na úrovni tokenů. Každý alias má tokeny ze
  // všech variant zápisu (wholeName + firstName/lastName) — query token
  // matchne alias, pokud token je členem jeho množiny.
  const byToken = new Map<string, AliasIndex[]>();
  for (const ent of entities) {
    for (let i = 0; i < ent.aliases.length; i++) {
      const a = ent.aliases[i];
      const combined = `${a.wholeName} ${a.firstName} ${a.lastName}`;
      const tokens = new Set(
        normalizeNameForMatching(combined)
          .split(" ")
          .filter((t) => t.length >= 2),
      );
      if (tokens.size === 0) continue;
      const ai: AliasIndex = { entity: ent, aliasIdx: i, tokens };
      for (const t of tokens) {
        const list = byToken.get(t);
        if (list) list.push(ai);
        else byToken.set(t, [ai]);
      }
    }
  }

  return {
    loadedAt: Date.now(),
    generationDate,
    entities,
    byToken,
  };
}

async function getSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.loadedAt < CACHE_TTL_MS) return snapshot;
  if (inflight) return inflight;
  inflight = buildSnapshot()
    .then((s) => {
      snapshot = s;
      return s;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export interface EuSanctionsHit {
  query: string;
  matchedAs: string;
  entity: EuSanctionsEntity;
}

export interface EuSanctionsScreenResult {
  queries: string[];
  hits: EuSanctionsHit[];
  totalEntities: number;
  generationDate: string | null;
  loadedAt: string;
}

/**
 * Screening jednoho nebo více jmen proti EU sanctions listu.
 *
 * Algoritmus: tokenizujeme query (lowercase, bez diacritics, ≥2 znaky),
 * pro každý token najdeme aliasy z indexu, intersect množiny.
 * Aliasy, jejichž tokenset je nadmnožinou query tokenů → hit.
 * Příklad: "Vladimir Putin" matchne "Vladimir Vladimirovich Putin".
 * Skip: query s méně než 2 distinctními tokeny (příliš mnoho falešných pozitiv).
 */
export async function screenEuSanctions(names: string[]): Promise<EuSanctionsScreenResult> {
  // Test/offline opt-out: vrátit prázdný snapshot bez síťového volání.
  // CI test runner nikdy nemá EU feed cache hot, full XML fetch by trval >5s.
  if (process.env.EU_SANCTIONS_DISABLED === "true") {
    return { queries: names, hits: [], totalEntities: 0, generationDate: null, loadedAt: new Date().toISOString() };
  }
  const s = await getSnapshot();
  const hits: EuSanctionsHit[] = [];
  const seenPair = new Set<string>();

  for (const raw of names) {
    if (!raw) continue;
    const qTokens = [...new Set(
      normalizeNameForMatching(raw)
        .split(" ")
        .filter((t) => t.length >= 2),
    )];
    if (qTokens.length < 2) continue;

    // Najdi nejmenší postingovou listinu pro start; pak filtruj.
    let candidates: AliasIndex[] | null = null;
    let smallestSize = Infinity;
    for (const t of qTokens) {
      const list = s.byToken.get(t);
      if (!list) {
        candidates = null;
        break;
      }
      if (list.length < smallestSize) {
        smallestSize = list.length;
        candidates = list;
      }
    }
    if (!candidates) continue;

    for (const ai of candidates) {
      if (!qTokens.every((t) => ai.tokens.has(t))) continue;
      const pairKey = `${raw}|${ai.entity.logicalId}`;
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);
      const matchedAs = ai.entity.aliases[ai.aliasIdx]?.wholeName ?? "";
      hits.push({ query: raw, matchedAs, entity: ai.entity });
    }
  }

  return {
    queries: names,
    hits,
    totalEntities: s.entities.length,
    generationDate: s.generationDate,
    loadedAt: new Date(s.loadedAt).toISOString(),
  };
}

export const EU_SANCTIONS_ATTRIBUTION = {
  source: "EU consolidated financial sanctions list",
  publisher: "Evropská komise — FPI (Service for Foreign Policy Instruments)",
  url: "https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions",
  feedUrl: "https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content",
  license: "Commission Decision 2011/833/EU — volné užití včetně komerčního, vyžaduje uvedení zdroje.",
  matchNote:
    "Match algoritmus: case- + diacritic-insensitive token-set exact match na min. 2 tokeny. Nepoužívá fuzzy distance — chrání před šumem, ale může zmeškat varianty psaní jmen. Pro 100% jistotu konzultujte zdroj.",
};

export function clearEuSanctionsCache(): void {
  snapshot = null;
}
