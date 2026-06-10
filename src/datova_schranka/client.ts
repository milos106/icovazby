// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Datová schránka — lookup ID schránky podle IČO ze veřejného seznamu
 * na mojedatovaschranka.cz.
 *
 * Princip:
 * - GET /sds/searchListPost?searchValue={ICO}&searchCriterion=ovm_name_of_subject&searchType=20
 *   (searchType 20 = právnická osoba)
 * - Vrátí HTML s tabulkou výsledků, kde je ID schránky v <span class="fw-bold">
 *   uvnitř bloku s odpovídajícím IČO
 * - Parsujeme HTML pomocí regex (lightweight, bez dependency)
 *
 * Limitace (zákonné):
 * - Od 1.2.2024 (novela zák. č. 300/2008 Sb.):
 *   - Právnické osoby (PO): zveřejněné ✅ lookup funguje
 *   - Podnikající FO (OSVČ): vymazané ze seznamu pokud sami nezvolili publish
 *   - Fyzické osoby: vymazané ze seznamu pokud sami nezvolili publish
 * - Pro FO/OSVČ vracíme `null` — uživatel ručně přes web
 *
 * Cache: ID schránek se mění zřídka (firma ji nemění během existence), TTL 30 dní.
 */

import { fetch as undiciFetch } from "undici";

const BASE = "https://www.mojedatovaschranka.cz/sds/searchListPost";
const TIMEOUT_MS = 10_000;

export interface DatovaSchrankaResult {
  ico: string;
  dsId: string;
  jmeno: string;
  typ: string;
  adresa: string | null;
}

/**
 * Pro PO (s.r.o., a.s., k.s., ...) vrací DS ID. Pro OSVČ/FO nebo
 * neexistující subjekt vrací null.
 *
 * searchType=20 = právnická osoba (PO)
 * Pro OVM (orgány veř. moci) by se použil 10 — ale ti mají typicky
 * vlastní IČO a vidíme je pres ARES separátně. Pro standardní DD
 * cíl jsou PO firmy.
 */
export async function lookupDsByIco(ico: string): Promise<DatovaSchrankaResult | null> {
  const normalized = ico.replace(/\D/g, "").padStart(8, "0").slice(-8);
  if (!/^\d{8}$/.test(normalized)) return null;

  const url = `${BASE}?searchValue=${encodeURIComponent(normalized)}&searchCriterion=ovm_name_of_subject&searchType=20`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let html: string;
  try {
    // Identifikujeme se otevřeně — žádné browser maškarády. Respektujeme
    // robots.txt (/sds/ není zakázaný), § 14a zák. 300/2008 (veřejný seznam),
    // cache 30 dní (snižuje zátěž MV), per-IP rate limit 60/h na našem konci.
    const res = await undiciFetch(url, {
      headers: {
        "user-agent": "icovazby.cz/0.9 (SimpleSolar s.r.o., info@simplesolar.cz) - public DD aggregator, respects robots.txt",
        "accept": "text/html, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
        "referer": "https://www.mojedatovaschranka.cz/sds/search",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  return parseDsResponse(html, normalized);
}

/**
 * Parser HTML odpovědi z mojedatovaschranka.cz. Robustní přístup:
 * - Najít všechny detail linky `onclick="window.location='detail?dbid=XXX'"`
 * - Pro každý prohledat okolní 1500 znaků kolem na IČO match
 * - Při shodě extrahovat jméno z `<div class="overme" title="JMÉNO">`,
 *   typ z `<span style="font-size: 8pt...">TYP</span>`, adresu z markupu
 *
 * Méně fragile než matching na celou strukturu — když MV ČR přidá další
 * elementy, dbid stále zůstane (je core data identifikátor).
 */
export function parseDsResponse(html: string, expectedIco: string): DatovaSchrankaResult | null {
  // Hledej všechny dbid v onclick handlerech (Unicode escape &#39; = ')
  const dbidRegex = /dbid=([a-z0-9]+)['&]/g;
  const positions: Array<{ dbid: string; pos: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = dbidRegex.exec(html)) !== null) {
    positions.push({ dbid: m[1], pos: m.index });
  }

  for (const { dbid, pos } of positions) {
    // IČO bývá ~1700 znaků za dbid (po jméně a stylech)
    const start = Math.max(0, pos - 200);
    const end = Math.min(html.length, pos + 3000);
    const window = html.slice(start, end);

    const icoMatch = window.match(/IČO:\s*<span class="fw-bold">(\d+)<\/span>/);
    if (!icoMatch || icoMatch[1] !== expectedIco) continue;

    // Found! Extrahuj jméno
    const jmenoMatch = window.match(/<div class="overme" title="([^"]+)">/);
    const jmeno = jmenoMatch ? jmenoMatch[1].trim() : "(neznámý subjekt)";

    // Typ (PO / OVM / ...) je v <span style="font-size: 8pt..."> na konci bloku
    const typMatch = window.match(/<span style="font-size:\s*8pt[^>]*>([^<]+)<\/span>/);
    const typ = typMatch ? typMatch[1].trim() : "Neznámý";

    // Adresa = třetí položka oddělená &middot;
    // Format: ID: X &middot; IČO: Y &middot; ADRESA
    const middotParts = window.split("&middot;");
    let adresa: string | null = null;
    if (middotParts.length >= 3) {
      // Druhá pozice za IČO blokem
      const after = middotParts[2];
      const adresaMatch = after.match(/^\s*([^<&]+)/);
      if (adresaMatch) adresa = adresaMatch[1].trim() || null;
    }

    return { ico: expectedIco, dsId: dbid, jmeno, typ, adresa };
  }
  return null;
}
