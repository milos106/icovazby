/**
 * Česká národní banka — denní kurzy devizového trhu.
 *
 * REST endpoint: https://api.cnb.cz/cnbapi/exrates/daily?lang=EN
 * Update once per business day around 14:30 — caching 6h is safe.
 *
 * License: ČNB website conditions ("nadměrné přístupy" budou omezeny), but
 * exchange rates have always been treated as public data per § 35 zákona o
 * ČNB. Attribution recommended; commercial use not explicitly restricted.
 *
 * Note: ČNB REST API rejects `lang=CS` with a validation error — only EN works
 * for this endpoint. The actual data is currency-agnostic.
 */

import { fetch as undiciFetch } from "undici";

const ENDPOINT = "https://api.cnb.cz/cnbapi/exrates/daily?lang=EN";
const TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface RawCnbRate {
  validFor: string;
  order: number;
  country: string;
  currency: string;
  amount: number;
  currencyCode: string;
  rate: number;
}

export interface RawCnbRatesResponse {
  rates: RawCnbRate[];
}

let cache: { at: number; value: RawCnbRatesResponse } | null = null;

export async function fetchDailyRates(): Promise<RawCnbRatesResponse> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(ENDPOINT, {
      headers: {
        accept: "application/json",
        "user-agent": "ares-web/0.2 (+https://github.com/milos106/ares-web)",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`ČNB HTTP ${response.status}`);
  }
  const json = (await response.json()) as RawCnbRatesResponse;
  cache = { at: Date.now(), value: json };
  return json;
}

/** Vrátí rate (Kč za 1 jednotku po normalizaci na amount=1). */
export function rateFor(rates: RawCnbRatesResponse, code: string): number | null {
  const r = rates.rates.find((x) => x.currencyCode === code.toUpperCase());
  if (!r) return null;
  return r.rate / r.amount;
}

/** Stručná atribuce. */
export const CNB_ATTRIBUTION = {
  source: "Česká národní banka — denní kurzy devizového trhu",
  url: "https://www.cnb.cz/cs/financni-trhy/devizovy-trh/",
  apiUrl: "https://api.cnb.cz/",
  updateInterval: "1x denně (pracovní den ~14:30)",
};
