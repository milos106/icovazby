// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TMView trademark search service — orchestruje client + filtering podle
 * české firmy. Vstup: IČO. Výstup: list ochranných známek, kde aplikant
 * odpovídá obchodnímu jménu firmy.
 *
 * Pravidla pro fair use (viz README): rate limit 2 req/s, LRU cache 24h
 * v server.ts, attribution v UI, žádný image caching.
 */

import type { AresClient } from "../ares/client.js";
import { validateIco as validateIcoFn } from "../ares/normalize.js";
import { InvalidInputError } from "../errors.js";
import { searchTrademarks, type TmViewTradeMark } from "./client.js";

/** Sufixy obchodního jména, které nejsou součástí identity firmy. */
const CORP_SUFFIXES = [
  ", a.s.",
  " a.s.",
  ", s.r.o.",
  " s.r.o.",
  ", v.o.s.",
  ", k.s.",
  ", s.p.",
  ", družstvo",
  ", spol. s r.o.",
  " holding",
  " group",
];

function stripCorpSuffix(name: string): string {
  let n = name;
  for (const s of CORP_SUFFIXES) {
    const idx = n.toLowerCase().indexOf(s.toLowerCase());
    if (idx > 0) n = n.slice(0, idx);
  }
  return n.trim();
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function applicantMatches(applicants: string[], firmCore: string): boolean {
  const firmNorm = normalize(firmCore);
  if (!firmNorm) return false;
  for (const a of applicants ?? []) {
    if (normalize(a).includes(firmNorm)) return true;
  }
  return false;
}

/** Office priority pro řazení (vyšší = lépe pro CZ user). */
function officeRank(office: string): number {
  if (office === "CZ") return 100;
  if (office === "EM" || office === "EU") return 90; // EU TM
  if (office === "WO") return 80;
  if (office === "SK") return 70;
  return 0;
}

export interface TrademarkResult {
  ST13: string;
  tmName: string;
  tmOffice: string;
  applicationNumber: string;
  applicationDate: string | null;
  applicantName: string[];
  tradeMarkStatus: string;
  niceClass: number[];
  /** Direct link na detail v TMView. */
  detailUrl: string;
  /** Hot-link na TMView CDN (pro náhled, žádný proxy ani caching). */
  imageUrl?: string;
}

export interface GetTrademarksResponse {
  ico: string;
  obchodniJmeno: string;
  query: string;
  /** Z TMView dotazu vrácený total — kolik všech matches existuje. */
  totalCandidates: number;
  /** Z toho po filtraci podle applicantName matche s obchodním jménem. */
  ownedCount: number;
  trademarks: TrademarkResult[];
  /** Statistika podle úřadu — pro UI badge. */
  byOffice: Record<string, number>;
  _attribution: {
    source: string;
    license: string;
    primarySource: string;
    note: string;
  };
}

const TMVIEW_ATTRIBUTION = {
  source: "TMView (EUIPN) — agregátor ochranných známek z národních úřadů",
  license: "Data podléhají licencím jednotlivých úřadů (ÚPV CZ, EUIPO, WIPO atd.). Open Data / CC BY 4.0 ve většině případů.",
  primarySource: "https://www.tmdn.org/tmview/",
  note: "icovazby není affiliated s EUIPN. Pro produkční použití doporučujeme EUIPO Cobranding partnership.",
};

export async function getTrademarksByCompany(
  client: AresClient,
  icoInput: string,
): Promise<GetTrademarksResponse> {
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });

  // Získat obchodní jméno z ARES pro filter
  const subject = await client.getEconomicSubject(normalized);
  const obchodniJmeno = subject.obchodniJmeno ?? "";
  if (!obchodniJmeno) {
    return {
      ico: normalized,
      obchodniJmeno: "",
      query: "",
      totalCandidates: 0,
      ownedCount: 0,
      trademarks: [],
      byOffice: {},
      _attribution: TMVIEW_ATTRIBUTION,
    };
  }

  const firmCore = stripCorpSuffix(obchodniJmeno);
  // První 2 slova jako search query — TMView basicSearch je full-text na TM name
  // a indirectly umí matchnout firmy se stejným jménem v applicantu.
  const queryWords = firmCore.split(/\s+/).filter((w) => w.length >= 3);
  const query = queryWords.slice(0, 2).join(" ") || firmCore;

  let pageSize = 50;
  const search = await searchTrademarks({
    query,
    criteria: "C",
    pageSize,
    page: 1,
  });

  // Filter na applicantName containing firm core name
  const owned = search.tradeMarks.filter((tm) =>
    applicantMatches(tm.applicantName, firmCore),
  );

  // Sort — CZ první, pak EU, pak WO, pak ostatní; uvnitř každého podle data desc
  owned.sort((a, b) => {
    const rd = officeRank(b.tmOffice) - officeRank(a.tmOffice);
    if (rd !== 0) return rd;
    return (b.applicationDate ?? "").localeCompare(a.applicationDate ?? "");
  });

  const byOffice: Record<string, number> = {};
  for (const tm of owned) byOffice[tm.tmOffice] = (byOffice[tm.tmOffice] ?? 0) + 1;

  const trademarks: TrademarkResult[] = owned.slice(0, 50).map((tm) => ({
    ST13: tm.ST13,
    tmName: tm.tmName,
    tmOffice: tm.tmOffice,
    applicationNumber: tm.applicationNumber,
    applicationDate: tm.applicationDate ? tm.applicationDate.slice(0, 10) : null,
    applicantName: tm.applicantName,
    tradeMarkStatus: tm.tradeMarkStatus,
    niceClass: tm.niceClass ?? [],
    detailUrl: `https://www.tmdn.org/tmview/#/tmview/detail/${tm.ST13}`,
    imageUrl: tm.markImageURI,
  }));

  return {
    ico: normalized,
    obchodniJmeno,
    query,
    totalCandidates: search.totalResults,
    ownedCount: owned.length,
    trademarks,
    byOffice,
    _attribution: TMVIEW_ATTRIBUTION,
  };
}
