// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GLEIF LEI (Legal Entity Identifier) — globální registr „kdo vlastní koho".
 *
 * Veřejné REST API, BEZ klíče (api.gleif.org/api/v1), data pod CC0 (volně i
 * komerčně, bez atribuce). Pro nás dvě věci:
 *  1) deterministický join IČO→LEI přes `filter[entity.registeredAs]={ICO}`
 *     (české firmy mají IČO v `entity.registeredAs`, RA000163 = obch. rejstřík),
 *  2) Level-2 vztahy (mateřská/dceřiné firmy) — VČETNĚ zahraničních → přeshraniční
 *     vlastnická struktura, kterou ARES/UBO graf nemá.
 *
 * Rate limit 60 req/min. On-demand per firma = OK; endpoint je cachovaný.
 */
import { fetch as undiciFetch } from "undici";

const BASE = "https://api.gleif.org/api/v1";
const UA = "ares-web/0.2 (+https://github.com/milos106/ares-web)";
const TIMEOUT_MS = 20000;

export const GLEIF_ATTRIBUTION = {
  zdroj: "GLEIF — Global Legal Entity Identifier Foundation (LEI)",
  licence: "CC0 1.0 (volně užitelné)",
  pozn: "LEI má jen menšina firem (hl. s vazbou na finanční trhy). Vztahy = účetní konsolidace (Level 2).",
  url: "https://www.gleif.org/",
};

async function fetchJson(path: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await undiciFetch(`${BASE}${path}`, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "application/vnd.api+json" },
      signal: controller.signal,
    });
    // 404 / "Resource not found" = vztah neexistuje (ne chyba) → null.
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GLEIF HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export interface LeiRecord {
  lei: string;
  name: string;
  country: string;
  status: string | null; // ACTIVE / INACTIVE
  registrationStatus: string | null; // ISSUED / LAPSED / RETIRED…
  registeredAs: string | null;
}

function shapeRecord(r: any): LeiRecord | null {
  const a = r?.attributes;
  const e = a?.entity;
  if (!a?.lei || !e) return null;
  return {
    lei: a.lei,
    name: e.legalName?.name ?? "(neznámé jméno)",
    country: e.legalAddress?.country ?? "",
    status: e.status ?? null,
    registrationStatus: a.registration?.status ?? null,
    registeredAs: e.registeredAs ?? null,
  };
}

/** IČO → LEI (deterministicky přes registeredAs). Preferuje CZ záznam (registeredAs
 *  je 8místné IČO, teoreticky může kolidovat s cizím ID). */
export async function fetchLeiByIco(ico: string): Promise<LeiRecord | null> {
  const norm = String(ico).replace(/\D/g, "");
  if (!norm) return null;
  const d = await fetchJson(`/lei-records?filter%5Bentity.registeredAs%5D=${encodeURIComponent(norm)}`);
  const rows: any[] = Array.isArray(d?.data) ? d.data : [];
  if (rows.length === 0) return null;
  const shaped = rows.map(shapeRecord).filter((x): x is LeiRecord => x !== null);
  return shaped.find((x) => x.country === "CZ") ?? shaped[0] ?? null;
}

export interface RelatedEntity {
  lei: string;
  name: string;
  country: string;
}

export interface ParentException {
  category: string; // DIRECT_ACCOUNTING_CONSOLIDATION_PARENT / ULTIMATE_…
  reason: string; // NATURAL_PERSONS / NON_CONSOLIDATING / NO_KNOWN_PERSON / NON_PUBLIC
}

export interface CrossBorder {
  directParent: RelatedEntity | null;
  ultimateParent: RelatedEntity | null;
  parentException: ParentException | null; // proč není mateřská (fyz. osoba apod.)
  children: RelatedEntity[];
}

function shapeRelated(r: any): RelatedEntity | null {
  const a = r?.attributes;
  const e = a?.entity;
  if (!a?.lei) return null;
  return { lei: a.lei, name: e?.legalName?.name ?? a.lei, country: e?.legalAddress?.country ?? "" };
}

async function fetchParent(lei: string, kind: "direct-parent" | "ultimate-parent"): Promise<RelatedEntity | null> {
  const d = await fetchJson(`/lei-records/${encodeURIComponent(lei)}/${kind}`).catch(() => null);
  if (!d?.data) return null;
  return shapeRelated(d.data);
}

async function fetchParentException(lei: string): Promise<ParentException | null> {
  for (const k of ["direct-parent-reporting-exception", "ultimate-parent-reporting-exception"]) {
    const d = await fetchJson(`/lei-records/${encodeURIComponent(lei)}/${k}`).catch(() => null);
    const a = d?.data?.attributes;
    if (a?.reason) return { category: a.category ?? "", reason: a.reason };
  }
  return null;
}

/** Vztahy LEI: mateřské (přímá/koncová) + dceřiné, ohraničeno. Když mateřská
 *  není (fyz. osoba), vrací reporting exception jako honest signál. */
export async function fetchCrossBorder(lei: string): Promise<CrossBorder> {
  const [directParent, ultimateParent, childrenResp] = await Promise.all([
    fetchParent(lei, "direct-parent"),
    fetchParent(lei, "ultimate-parent"),
    fetchJson(`/lei-records/${encodeURIComponent(lei)}/direct-children?page%5Bsize%5D=50`).catch(() => null),
  ]);
  const children: RelatedEntity[] = Array.isArray(childrenResp?.data)
    ? childrenResp.data.map(shapeRelated).filter((x: RelatedEntity | null): x is RelatedEntity => x !== null)
    : [];
  // Reporting exception jen když chybí přímá mateřská — vysvětlí proč.
  const parentException = directParent ? null : await fetchParentException(lei);
  return { directParent, ultimateParent, parentException, children };
}
