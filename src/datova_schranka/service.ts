// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Service vrstva pro Datovou schránku — wraps client + SQLite cache.
 *
 * Cache: 30 dní pro nalezené i nenalezené (negative cache abychom
 * neopakovali fail lookup pro FO/OSVČ vymazané ze seznamu).
 */

import { getDb } from "../persons_index/db.js";
import { type DatovaSchrankaResult, lookupDsByIco } from "./client.js";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface DsServiceResult {
  ico: string;
  dsId: string | null;
  jmeno: string | null;
  typ: string | null;
  adresa: string | null;
  found: boolean;
  cached: boolean;
  checkedAt: number;
  _source: {
    name: string;
    url: string;
    license: string;
    note: string;
  };
}

function readCache(ico: string): DsServiceResult | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM ds_cache WHERE ico = ?").get(ico) as
    | {
        ico: string;
        ds_id: string | null;
        jmeno: string | null;
        typ: string | null;
        adresa: string | null;
        found: number;
        checked_at: number;
      }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.checked_at > CACHE_TTL_MS) return null;
  return {
    ico: row.ico,
    dsId: row.ds_id,
    jmeno: row.jmeno,
    typ: row.typ,
    adresa: row.adresa,
    found: Boolean(row.found),
    cached: true,
    checkedAt: row.checked_at,
    _source: SOURCE_ATTRIBUTION,
  };
}

function writeCache(ico: string, result: DatovaSchrankaResult | null): DsServiceResult {
  const db = getDb();
  const checked_at = Date.now();
  const found = result !== null;
  db.prepare(`
    INSERT INTO ds_cache (ico, ds_id, jmeno, typ, adresa, found, checked_at)
    VALUES (@ico, @ds_id, @jmeno, @typ, @adresa, @found, @checked_at)
    ON CONFLICT(ico) DO UPDATE SET
      ds_id = excluded.ds_id,
      jmeno = excluded.jmeno,
      typ = excluded.typ,
      adresa = excluded.adresa,
      found = excluded.found,
      checked_at = excluded.checked_at
  `).run({
    ico,
    ds_id: result?.dsId ?? null,
    jmeno: result?.jmeno ?? null,
    typ: result?.typ ?? null,
    adresa: result?.adresa ?? null,
    found: found ? 1 : 0,
    checked_at,
  });
  return {
    ico,
    dsId: result?.dsId ?? null,
    jmeno: result?.jmeno ?? null,
    typ: result?.typ ?? null,
    adresa: result?.adresa ?? null,
    found,
    cached: false,
    checkedAt: checked_at,
    _source: SOURCE_ATTRIBUTION,
  };
}

const SOURCE_ATTRIBUTION = {
  name: "Seznam držitelů datových schránek",
  url: "https://www.mojedatovaschranka.cz/sds/",
  license: "veřejná data dle § 14a zák. č. 300/2008 Sb.",
  note: "Experimental: lookup přes HTML scraping veřejného seznamu. ID schránek pro PO (právnické osoby) jsou zveřejněné ze zákona. Pro OSVČ/FO od 1.2.2024 vymazané ze seznamu (lookup vrátí not found).",
};

export async function getDsByIco(ico: string): Promise<DsServiceResult> {
  const normalized = ico.replace(/\D/g, "").padStart(8, "0").slice(-8);
  if (!/^\d{8}$/.test(normalized)) {
    return {
      ico: normalized,
      dsId: null,
      jmeno: null,
      typ: null,
      adresa: null,
      found: false,
      cached: false,
      checkedAt: Date.now(),
      _source: SOURCE_ATTRIBUTION,
    };
  }
  const cached = readCache(normalized);
  if (cached) return cached;
  const result = await lookupDsByIco(normalized).catch(() => null);
  return writeCache(normalized, result);
}
