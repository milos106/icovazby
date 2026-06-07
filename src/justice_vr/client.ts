/**
 * Veřejný rejstřík (OR) klient — nová cesta přes verejnerejstriky.msp.gov.cz.
 *
 * Pozadí: starý dataor.justice.cz (SOAP/XML) je TLS-blokovaný a or.justice.cz
 * nemá API. V červnu 2026 MSp ČR spustil v ověřovacím provozu nový portál
 * verejnerejstriky.msp.gov.cz s čistým JSON API:
 *
 *   GET /api/rejstriky/navrhy?hledanyText={Q}&rejstriky=VR
 *     → fulltext + IČO search, vrátí seznam {subjektId, nazev, ico}
 *
 *   GET /api/rejstriky/detail/{subjektId}?subjektId={id}&typDetailu=VR_PLATNE
 *     → plný strukturovaný výpis z OR: statutární orgán + osoby
 *       (s datumNarozeni, adresou, funkcí), dozorčí rada, akcionář,
 *       předmět činnosti + podnikání, akcie + základní kapitál,
 *       spisová značka, ostatní skutečnosti (historie fúzí/převodů)
 *
 * Bez auth, bez API klíče. Portál se sám hlásí jako „ověřovací provoz" ale
 * data jsou tatáž jako or.justice.cz. Licence: veřejný rejstřík dle
 * z. č. 304/2013 Sb. — volný přístup, vyžaduje uvedení zdroje.
 */

import { fetch as undiciFetch } from "undici";

const BASE = "https://verejnerejstriky.msp.gov.cz";
const TIMEOUT_MS = 15000;
const ICO_TO_SUBJECT_TTL_MS = 24 * 60 * 60 * 1000;
const DETAIL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const icoSubjectCache = new Map<string, { subjektId: number; at: number }>();
const detailCache = new Map<string, { detail: VrDetailRaw; at: number }>();

// ─── Raw types (částečně, jen pole co používáme) ──────────────────────────────

interface VrIdented {
  id: number;
  validFrom?: string | null;
  validTo?: string | null;
  skryty?: boolean;
  hlavicka?: string;
}

interface VrSimpleValue extends VrIdented {
  value: string;
}

interface VrAddress {
  ruianKod?: number;
  stat?: string;
  okres?: string;
  obec?: string;
  castObce?: string;
  ulice?: string;
  cisloPop?: string;
  cisloOr?: string;
  psc?: string;
  mop?: string;
}

interface VrOsoba {
  id?: number;
  jmeno?: string;
  prijmeni?: string;
  titulPred?: string | null;
  titulPo?: string | null;
  datumNarozeni?: string;
  adresa?: VrAddress;
  nazev?: string; // pro právnickou osobu
  ico?: string;
}

interface VrClenOrganu extends VrIdented {
  value?: {
    osoba?: VrOsoba;
    funkce?: { funkce?: string; vznikFunkce?: string };
    clenstvi?: { vznikClenstvi?: string };
  };
}

interface VrOrgan extends VrIdented {
  osoby?: VrClenOrganu[];
  pocet?: number;
  text?: string;
}

interface VrAkcieValue {
  typ?: string;
  podoba?: string;
  pocet?: number;
  hodnota?: { typ?: string; textValue?: string };
  text?: string;
}

interface VrAkcie extends VrIdented {
  value?: VrAkcieValue;
}

interface VrOstatniSkutecnost extends VrIdented {
  value: string;
}

interface VrOstatniSkutecnosti extends VrIdented {
  skutecnosti?: VrOstatniSkutecnost[];
}

export interface VrDetailRaw {
  subjektId?: number;
  typ?: string;
  datumVygenerovani?: string;
  datumZapisu?: string;
  ico?: VrSimpleValue;
  nazev?: VrSimpleValue;
  sidlo?: VrSimpleValue;
  pravniForma?: VrSimpleValue;
  spisovaZnacka?: VrSimpleValue;
  zakladniKapital?: VrSimpleValue;
  predmetCinnosti?: VrSimpleValue[];
  predmetPodnikani?: VrSimpleValue[];
  statutarniOrgan?: VrOrgan;
  dozorciRada?: VrOrgan;
  akcionar?: VrOrgan;
  akcie?: VrAkcie[];
  ostatniSkutecnosti?: VrOstatniSkutecnosti;
}

interface VrSearchHit {
  subjektId: number;
  nazev?: { value?: string };
  ico?: { value?: string };
}

interface VrSearchResponse {
  data: VrSearchHit[];
  pocetCelkem: number;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function getJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await undiciFetch(`${BASE}${path}`, {
      headers: {
        accept: "application/json",
        "user-agent": "ares-web/0.2 (+https://github.com/milos106/ares-web)",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`VR API HTTP ${response.status} for ${path}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeIco(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.padStart(8, "0");
}

/**
 * Najde subjektId pro dané IČO. Subjekt může mít víc shod (záznamy o
 * zaniklých dceřinkách atd.) — bereme první aktivní. Cache 24h.
 */
async function findSubjektIdByIco(ico: string): Promise<number | null> {
  const key = normalizeIco(ico);
  const cached = icoSubjectCache.get(key);
  if (cached && Date.now() - cached.at < ICO_TO_SUBJECT_TTL_MS) {
    return cached.subjektId;
  }
  const url = `/api/rejstriky/navrhy?hledanyText=${encodeURIComponent(key)}&rejstriky=VR`;
  const res = await getJson<VrSearchResponse>(url);
  if (!res?.data || res.data.length === 0) return null;
  // Najdi přesnou shodu na IČO; bez padding pro zpětnou kompatibilitu
  const target = key.replace(/^0+/, "");
  const hit = res.data.find((h) => {
    const v = h.ico?.value?.replace(/\D/g, "") ?? "";
    return v === target || v.padStart(8, "0") === key;
  }) ?? res.data[0];
  if (!hit?.subjektId) return null;
  icoSubjectCache.set(key, { subjektId: hit.subjektId, at: Date.now() });
  return hit.subjektId;
}

async function fetchDetail(subjektId: number, typDetailu = "VR_PLATNE"): Promise<VrDetailRaw> {
  const cacheKey = `${subjektId}|${typDetailu}`;
  const cached = detailCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DETAIL_CACHE_TTL_MS) return cached.detail;
  const url = `/api/rejstriky/detail/${subjektId}?subjektId=${subjektId}&typDetailu=${encodeURIComponent(typDetailu)}`;
  const detail = await getJson<VrDetailRaw>(url);
  detailCache.set(cacheKey, { detail, at: Date.now() });
  return detail;
}

export async function fetchVrDetailByIco(ico: string): Promise<VrDetailRaw | null> {
  const subjektId = await findSubjektIdByIco(ico);
  if (subjektId === null) return null;
  return fetchDetail(subjektId);
}

// ─── Public attribution constant ──────────────────────────────────────────────

export const VR_ATTRIBUTION = {
  source: "Veřejný rejstřík (OR)",
  publisher: "Ministerstvo spravedlnosti ČR",
  url: "https://verejnerejstriky.msp.gov.cz/",
  apiUrl: `${BASE}/api/rejstriky/detail/`,
  legalBasis: "Zákon č. 304/2013 Sb., o veřejných rejstřících právnických a fyzických osob",
  license:
    'Veřejně přístupné údaje z OR. Doporučená atribuce: "Source: Veřejný rejstřík, Ministerstvo spravedlnosti ČR".',
  status:
    "Portál v ověřovacím provozu (oficiálním zdrojem zůstává or.justice.cz). API funguje a poskytuje totožná data.",
};

export function clearVrCache(): void {
  icoSubjectCache.clear();
  detailCache.clear();
}
