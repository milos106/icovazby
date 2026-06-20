// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { hsTokenContext } from "./token_context.js";

const BASE = "https://api.hlidacstatu.cz";

export class HlidacStatuMissingTokenError extends Error {
  constructor() {
    super("HLIDAC_API_TOKEN is not set — Hlídač státu integration is disabled.");
    this.name = "HlidacStatuMissingTokenError";
  }
}

/**
 * 429 z Hlídače státu — denní/hodinový limit per token. Specific error type
 * umožňuje route handlerům vrátit graceful `{ ok: false, reason: 'hs_rate_limited' }`.
 */
export class HlidacStatuRateLimitedError extends Error {
  constructor(public readonly body: string) {
    super(`Hlídač státu HTTP 429: ${body.slice(0, 200)}`);
    this.name = "HlidacStatuRateLimitedError";
  }
}

/**
 * HS vrátil neočekávanou odpověď — typicky HTTP 200 s HTML stránkou
 * (Cloudflare/proxy/údržba) nebo 5xx. Bez tohoto by JSON.parse hodil
 * neošetřený SyntaxError → 500 „Interní chyba serveru". Typovaná chyba
 * umožní route handlerům vrátit čistou hlášku „dočasně nedostupné".
 */
export class HlidacStatuUnavailableError extends Error {
  constructor(detail: string) {
    super(`Hlídač státu nedostupný: ${detail}`);
    this.name = "HlidacStatuUnavailableError";
  }
}

function getToken(): string {
  // Priority: per-request token (z X-Hlidac-Token hlavičky) > env token.
  // Tím je možné aby každý uživatel přinesl vlastní token a nesdílel rate
  // limit s ostatními.
  const fromRequest = hsTokenContext.getStore()?.trim();
  const t = fromRequest || process.env.HLIDAC_API_TOKEN?.trim();
  if (!t) throw new HlidacStatuMissingTokenError();
  return t;
}

const TIMEOUT_MS = 15000;
const cache = new Map<string, { at: number; value: unknown }>();
// HS data (UBO, dotace, smlouvy, ISIR) se mění v jednotkách týdnů — 24 h
// cache je bezpečná. Bumped z 6 h, aby šetřila daily quotu admin tokenu;
// per-user tokeny (X-Hlidac-Token) jdou stejnou cache, tj. pomáhá to všem.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Retry budget pro 429: 1 retry po 5 s. Krátké burst během vícekartového
// DD profilu (5 paralelních HS callů najednou) tím přežijeme bez crashe,
// ale neopakujeme donekonečna na vyčerpaný daily limit.
const RATE_LIMIT_RETRY_DELAY_MS = 5000;

async function fetchOnce(path: string, token: string): Promise<Awaited<ReturnType<typeof undiciFetch>>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await undiciFetch(`${BASE}${path}`, {
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
}

async function getJson<T>(path: string): Promise<T> {
  const key = path;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value as T;
  }
  const token = getToken();
  let response = await fetchOnce(path, token);
  // Single retry pro 429 — pomáhá při krátkém burst limitu (per-minute quota
  // překročená kvůli paralelním DD callům). Pokud daily limit, druhý pokus
  // vrátí znovu 429 → propaguje se jako HlidacStatuRateLimitedError.
  if (response.status === 429) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_DELAY_MS));
    response = await fetchOnce(path, token);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 429) {
      throw new HlidacStatuRateLimitedError(body);
    }
    // 4xx/5xx (mimo 429) — HS chyba/výpadek, často HTML (Cloudflare/údržba).
    throw new HlidacStatuUnavailableError(`HTTP ${response.status}: ${body.slice(0, 160)}`);
  }
  // HS občas vrátí HTTP 200 s HTML stránkou (proxy/Cloudflare/údržba) — to by
  // shodilo response.json() na neošetřený SyntaxError → 500. Parsujeme bezpečně.
  const text = await response.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    throw new HlidacStatuUnavailableError(`neočekávaná odpověď (ne-JSON): ${text.slice(0, 120)}`);
  }
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

// ─── Smlouvy (Registr smluv) ──────────────────────────────────────────────────
// Veřejné zakázky (verejnezakazky/hledat) vyžadují komerční licenci. Smlouvy
// (z. č. 340/2015 Sb.) jsou na free tieru dostupné a obsahují finální plnění.

export interface RawSmlouvaParty {
  jmeno?: string | null;
  nazev?: string | null;
  ico?: string | null;
  adresa?: string | null;
  datovaSchranka?: string | null;
}

export interface RawSmlouva {
  id?: string;
  identifikator?: { idSmlouvy?: string; idVerze?: string };
  calculatedPriceWithVATinCZK?: number;
  hodnotaVcetneDph?: number;
  hodnotaBezDph?: number;
  datumUzavreni?: string | null;
  casZverejneni?: string | null;
  predmet?: string | null;
  cisloSmlouvy?: string | null;
  platce?: RawSmlouvaParty | null;
  prijemce?: RawSmlouvaParty | RawSmlouvaParty[] | null;
  odkaz?: string | null;
  cenaNeuvedenaDuvod?: string | null;
  sVazbouNaPolitikyAktualni?: boolean;
  [key: string]: unknown;
}

export interface RawSmlouvyResponse {
  total: number;
  page: number;
  results: RawSmlouva[];
}

// ─── Dotace ───────────────────────────────────────────────────────────────────
// Data agregovaná Hlídačem státu z CEDR, MMR, MPSV, EU fondů atd. — všechny
// uvedené dotace státní peníze (přímé i z EU s národní koalsementací).

export interface RawDotaceRecipient {
  ico?: string;
  name?: string;
  hlidacName?: string;
  displayName?: string;
  obec?: string;
}

export interface RawDotace {
  id?: string;
  primaryDataSource?: string;
  assumedAmount?: number | null;
  subsidyAmount?: number | null;
  payedAmount?: number | null;
  returnedAmount?: number | null;
  approvedYear?: number | null;
  subsidyProvider?: string | null;
  subsidyProviderIco?: string | null;
  programName?: string | null;
  programCode?: string | null;
  projectName?: string | null;
  projectCode?: string | null;
  projectDescription?: string | null;
  displayProject?: string | null;
  recipient?: RawDotaceRecipient | null;
  [key: string]: unknown;
}

export interface RawDotaceResponse {
  total: number;
  page: number;
  results: RawDotace[];
}

// ─── Insolvence (ISIR via Hlídač státu) ──────────────────────────────────────
// API podporuje strukturované query syntaxe:
//   ico:X            — kterákoli role
//   icodluznik:X     — pouze jako dlužník (= v insolvenci sám)
//   icoveritel:X     — věřitel
//   icospravce:X     — insolvenční správce
// Pro DD nás zajímá především icodluznik:.

export interface RawInsolvencePerson {
  idPuvodce?: string;
  plneJmeno?: string;
  ico?: string;
  role?: string;
  mesto?: string;
  psc?: string;
  zeme?: string;
  zalozen?: string;
  odstranen?: string;
}

export interface RawInsolvenceRecord {
  isFullRecord?: boolean;
  spisovaZnacka?: string;
  stav?: string;
  soud?: string;
  datumZalozeni?: string;
  posledniZmena?: string;
  vyskrtnuto?: string | null;
  url?: string | null;
  dluznici?: RawInsolvencePerson[];
  veritele?: RawInsolvencePerson[];
  spravci?: RawInsolvencePerson[];
  onRadar?: boolean;
  odstraneny?: boolean;
  dokumenty?: unknown[];
  [key: string]: unknown;
}

export interface RawInsolvenceResponse {
  total: number;
  page: number;
  results: RawInsolvenceRecord[];
}

export async function fetchInsolvenceAsDluznik(
  ico: string,
  options: { strana?: number; razeni?: string } = {},
): Promise<RawInsolvenceResponse> {
  const key = ico.replace(/\D/g, "");
  if (!/^\d{8}$/.test(key)) {
    throw new Error(`Invalid IČO '${ico}'.`);
  }
  const strana = options.strana ?? 1;
  // newest first — pro aktivní případy vidíme to nejnovější
  const razeni = options.razeni ?? "datum_desc";
  return getJson<RawInsolvenceResponse>(
    `/api/v2/insolvence/hledat?dotaz=icodluznik%3A${key}&strana=${strana}&razeni=${encodeURIComponent(razeni)}`,
  );
}

export async function fetchDotaceByIco(
  ico: string,
  options: { strana?: number; razeni?: string } = {},
): Promise<RawDotaceResponse> {
  const key = ico.replace(/\D/g, "");
  if (!/^\d{8}$/.test(key)) {
    throw new Error(`Invalid IČO '${ico}'.`);
  }
  const strana = options.strana ?? 1;
  // payed desc — nejvyšší vyplacené první
  const razeni = options.razeni ?? "payed_desc";
  return getJson<RawDotaceResponse>(
    `/api/v2/dotace/hledat?dotaz=ico%3A${key}&strana=${strana}&razeni=${encodeURIComponent(razeni)}`,
  );
}

/**
 * Vyhledá smlouvy podle IČO (kterékoli ze stran — platce i příjemce).
 * Řazení podle ceny desc — vrátí nejdražší smlouvy jako první (top hits).
 */
export async function fetchSmlouvyByIco(
  ico: string,
  options: { strana?: number; razeni?: string } = {},
): Promise<RawSmlouvyResponse> {
  const key = ico.replace(/\D/g, "");
  if (!/^\d{8}$/.test(key)) {
    throw new Error(`Invalid IČO '${ico}'.`);
  }
  const strana = options.strana ?? 1;
  const razeni = options.razeni ?? "cena_desc";
  return getJson<RawSmlouvyResponse>(
    `/api/v2/smlouvy/hledat?dotaz=ico%3A${key}&strana=${strana}&razeni=${encodeURIComponent(razeni)}`,
  );
}

// ─── Osoby (lookup + detail) ──────────────────────────────────────────────────
// /api/v2/osoby/hledat vyžaduje Jmeno + Prijmeni + DatumNarozeni (YYYY-MM-DD).
// Bez všech tří API odmítne 400 "Jmeno, prijmeni i datum narozeni jsou povinne."

export interface RawOsobaHlidacMatch {
  titulPred?: string | null;
  jmeno?: string;
  prijmeni?: string;
  titulPo?: string | null;
  narozeni?: string | null;
  nameId: string;
  profile: string;
}

export interface RawOsobaUdalost {
  typ?: string;
  organizace?: string;
  role?: string | null;
  castka?: number;
  datumOd?: string | null;
  datumDo?: string | null;
}

export interface RawOsobaDetail {
  titulPred?: string | null;
  jmeno?: string;
  prijmeni?: string;
  titulPo?: string | null;
  narozeni?: string | null;
  nameId: string;
  profile: string;
  politickaStrana?: unknown;
  sponzoring?: unknown[];
  udalosti?: RawOsobaUdalost[];
  socialniSite?: unknown[];
}

export async function searchOsoby(
  jmeno: string,
  prijmeni: string,
  datumNarozeni: string,
): Promise<RawOsobaHlidacMatch[]> {
  const qs = new URLSearchParams({
    Jmeno: jmeno,
    Prijmeni: prijmeni,
    DatumNarozeni: datumNarozeni,
  });
  return getJson<RawOsobaHlidacMatch[]>(`/api/v2/osoby/hledat?${qs.toString()}`);
}

export async function fetchOsobaDetail(nameId: string): Promise<RawOsobaDetail> {
  const safe = encodeURIComponent(nameId);
  return getJson<RawOsobaDetail>(`/api/v2/osoby/${safe}`);
}

/** Vrátí Hlídač státu token status bez sahnutí na API. */
export function hasHlidacToken(): boolean {
  return Boolean(process.env.HLIDAC_API_TOKEN?.trim());
}

export function clearHlidacCache(): void {
  cache.clear();
}
