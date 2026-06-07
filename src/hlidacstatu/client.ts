/**
 * Hlídač státu API client.
 *
 * License: data from Hlídač státu, z.ú. are CC BY 3.0 CZ. Attribution
 * (full, functional internet link to hlidacstatu.cz) is mandatory on every
 * page that displays this data — handled in the footer + per-section.
 *
 * Auth: Bearer-style token in the `Authorization: Token <value>` header.
 * The token comes from HLIDAC_API_TOKEN env var (no fallback). Calls fail
 * fast if the token is not set.
 *
 * Docs: https://api.hlidacstatu.cz/swagger/index.html
 *       https://www.hlidacstatu.cz/api/v1/doc
 */

import { fetch as undiciFetch } from "undici";

const BASE = "https://api.hlidacstatu.cz";

export class HlidacStatuMissingTokenError extends Error {
  constructor() {
    super("HLIDAC_API_TOKEN is not set — Hlídač státu integration is disabled.");
    this.name = "HlidacStatuMissingTokenError";
  }
}

function getToken(): string {
  const t = process.env.HLIDAC_API_TOKEN?.trim();
  if (!t) throw new HlidacStatuMissingTokenError();
  return t;
}

const TIMEOUT_MS = 15000;
const cache = new Map<string, { at: number; value: unknown }>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hodin

async function getJson<T>(path: string): Promise<T> {
  const key = path;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value as T;
  }
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(`${BASE}${path}`, {
      headers: {
        accept: "application/json",
        authorization: `Token ${token}`,
        "user-agent": "ares-web/0.2 (+https://github.com/milos106/ares-web)",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Hlídač státu HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  const json = (await response.json()) as T;
  cache.set(key, { at: Date.now(), value: json });
  return json;
}

// ─── Schemas — raw shapes returned by the API ─────────────────────────────────

export interface RawUboRecord {
  datum_zapis?: string | null;
  datum_vymaz?: string | null;
  udaj_typ?: string | null;
  udaj_typ_nazev?: string | null;
  postaveni?: string | null;
  osoba_jmeno?: string | null;
  osoba_prijmeni?: string | null;
  osoba_titul_pred?: string | null;
  osoba_titul_za?: string | null;
  osoba_datum_narozeni?: string | null;
  adresa_text?: string | null;
  podil_na_prospechu_typ?: string | null;
  podil_na_prospechu_hodnota?: string | null;
  podil_na_hlasovani_typ?: string | null;
  podil_na_hlasovani_hodnota?: string | null;
  slovni_vyjadreni?: string | null;
  [key: string]: unknown;
}

export interface RawUboResult {
  id: string;
  ico: string;
  nazev_subjektu?: string;
  skutecni_majitele: RawUboRecord[];
}

export interface RawUboResponse {
  total: number;
  page: number;
  results: RawUboResult[];
}

// ─── Public method ────────────────────────────────────────────────────────────

export async function fetchUboByIco(ico: string): Promise<RawUboResponse> {
  const key = ico.replace(/\D/g, "");
  if (!/^\d{8}$/.test(key)) {
    throw new Error(`Invalid IČO '${ico}'.`);
  }
  return getJson<RawUboResponse>(
    `/api/v2/datasety/skutecni-majitele/hledat?dotaz=ico%3A${key}&strana=1&razeni=skutecni_majitele.datum_zapis`,
  );
}

/** Vrátí Hlídač státu token status bez sahnutí na API. */
export function hasHlidacToken(): boolean {
  return Boolean(process.env.HLIDAC_API_TOKEN?.trim());
}

export function clearHlidacCache(): void {
  cache.clear();
}
