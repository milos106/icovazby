// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * MFČR ADIS SOAP klient pro registr plátců DPH a nespolehlivých plátců.
 *
 * Endpoint:
 *   https://adisrws.mfcr.cz/adistc/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP
 *
 * Provozováno Finanční správou ČR. Data publikována dle § 96a zákona č. 235/2004
 * Sb., o dani z přidané hodnoty — veřejně dostupná zdarma.
 *
 * Hlavní volání:
 *   - StatusNespolehlivyPlatceRequest → nespolehlivý plátce + zveřejněné účty
 *   - SeznamNespolehlivyPlatceRequest → kompletní seznam nespolehlivých
 *
 * Jednou voláním lze dotázat až 100 DIČ. Implementujeme jen 1 DIČ per request
 * (volá se pro konkrétní firmu v DD kartě).
 *
 * Cache: 1h TTL — data se mění zřídka (publikace nespolehlivosti je rozhodnutí
 * správce daně, ne automat). Nadhodnota přesnějšího cache by neopravnila
 * dodatečné requesty.
 */

import { fetch as undiciFetch } from "undici";

const ENDPOINT =
  "https://adisrws.mfcr.cz/adistc/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP";

const NS = "http://adis.mfcr.cz/rozhraniCRPDPH/";

export interface AdisBankAccount {
  /** Datum zveřejnění účtu */
  datumZverejneni?: string;
  /** "standardní" formát: predcisli + cislo + kodBanky */
  type: "standardni" | "nestandardni";
  /** Pro standardní účet: prefix-cislo/kodBanky */
  cisloUctuFormatted?: string;
  /** Surový string, vždy přítomen */
  raw: string;
}

export interface AdisPlatceInfo {
  dic: string;
  nespolehlivyPlatce: "ANO" | "NE" | string;
  /** Číselný kód finančního úřadu */
  cisloFu?: string;
  zverejneneUcty: AdisBankAccount[];
}

export interface AdisResponse {
  /** ISO datum vygenerování odpovědi MFČR */
  odpovedGenerovana?: string;
  statusCode?: string;
  statusText?: string;
  /** undefined = subjekt nenalezen */
  info?: AdisPlatceInfo;
}

const REQUEST_TIMEOUT_MS = 12000;

function buildSoapBody(dic: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${NS}">
  <soap:Body>
    <tns:StatusNespolehlivyPlatceRequest>
      <tns:dic>${dic}</tns:dic>
    </tns:StatusNespolehlivyPlatceRequest>
  </soap:Body>
</soap:Envelope>`;
}

/** Extrahuje hodnotu prvního výskytu atributu z XML stringu. */
function attr(xml: string, tag: string, name: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*\\s${name}="([^"]+)"[^>]*>`);
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

/**
 * Parser. ADIS odpovědi jsou ploché — používáme regex místo plnoformátového
 * XML parseru, protože je to jednorázová tabulka. Pokud by struktura
 * zkomplikovala (vnořené elementy), přejdeme na fast-xml-parser.
 */
function parseResponse(xml: string): AdisResponse {
  const out: AdisResponse = {};
  out.odpovedGenerovana = attr(xml, "status", "odpovedGenerovana");
  out.statusCode = attr(xml, "status", "statusCode");
  out.statusText = attr(xml, "status", "statusText");

  const statusPlatceMatch = xml.match(/<statusPlatceDPH\b([^>]*)>([\s\S]*?)<\/statusPlatceDPH>/);
  if (!statusPlatceMatch) return out;

  const [, headerAttrs, innerBlock] = statusPlatceMatch;
  if (!headerAttrs || innerBlock === undefined) return out;
  const dicMatch = headerAttrs.match(/\sdic="([^"]+)"/);
  const nespMatch = headerAttrs.match(/\snespolehlivyPlatce="([^"]+)"/);
  const fuMatch = headerAttrs.match(/\scisloFu="([^"]+)"/);
  const ucty: AdisBankAccount[] = [];

  const uctyRe = /<ucet\b([^>]*)>([\s\S]*?)<\/ucet>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
  while ((m = uctyRe.exec(innerBlock)) !== null) {
    const headAttrs = m[1] ?? "";
    const body = m[2] ?? "";
    const dz = headAttrs.match(/\sdatumZverejneni="([^"]+)"/)?.[1];

    const stdMatch = body.match(/<standardniUcet\b([^/>]*)\/?>/);
    if (stdMatch) {
      const a = stdMatch[1] ?? "";
      const predcisli = a.match(/\spredcisli="([^"]+)"/)?.[1];
      const cislo = a.match(/\scislo="([^"]+)"/)?.[1];
      const kodBanky = a.match(/\skodBanky="([^"]+)"/)?.[1];
      const formatted =
        predcisli && cislo && kodBanky
          ? `${predcisli}-${cislo}/${kodBanky}`
          : cislo && kodBanky
            ? `${cislo}/${kodBanky}`
            : cislo;
      ucty.push({
        datumZverejneni: dz,
        type: "standardni",
        cisloUctuFormatted: formatted,
        raw: stdMatch[0],
      });
      continue;
    }
    const nestMatch = body.match(/<nestandardniUcet\b([^/>]*)\/?>/);
    if (nestMatch) {
      const a = nestMatch[1] ?? "";
      const cislo = a.match(/\scislo="([^"]+)"/)?.[1];
      ucty.push({
        datumZverejneni: dz,
        type: "nestandardni",
        cisloUctuFormatted: cislo,
        raw: nestMatch[0],
      });
    }
  }

  out.info = {
    dic: dicMatch?.[1] ?? "",
    nespolehlivyPlatce: nespMatch?.[1] ?? "?",
    cisloFu: fuMatch?.[1],
    zverejneneUcty: ucty,
  };
  return out;
}

const cache = new Map<string, { at: number; value: AdisResponse }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hodina

/** Hlavní veřejná metoda. DIČ bez prefixu "CZ" (= IČO 8 číslic). */
export async function fetchPlatceStatus(dic: string): Promise<AdisResponse> {
  const key = dic.replace(/\D/g, "");
  if (!/^\d{8}$/.test(key)) {
    throw new Error(`Invalid DIČ '${dic}' — must be 8 digits.`);
  }
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    response = await undiciFetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "text/xml; charset=UTF-8",
        soapaction: '""',
        "user-agent": "ares-web/0.2 (+https://github.com/milos106/ares-web)",
      },
      body: buildSoapBody(key),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`ADIS HTTP ${response.status} for DIČ ${key}`);
  }
  const xml = await response.text();
  const parsed = parseResponse(xml);
  cache.set(key, { at: Date.now(), value: parsed });
  return parsed;
}

export function clearAdisCache(): void {
  cache.clear();
}
