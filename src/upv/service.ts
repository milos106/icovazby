// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ÚPV ochranné známky — lookup z lokálního SQLite indexu.
 *
 * ÚPV neposkytuje IČO ani street adresu, takže propojení s ARES jde jen přes
 * fuzzy match obchodního jména + city. Pro běžné firmy (známé brandy)
 * dobře fungující, pro generická jména („Jan Novák s.r.o.") ambiguous.
 *
 * Volá se z DD pipeline po ARES lookup — předáme `obchodniJmeno` + sídlo
 * city a vrátíme seznam značek + agg statistiky.
 */

import { getDb } from "../persons_index/db.js";

export interface UpvTrademark {
  applicationNumber: string;
  applicationDate: string | null;
  statusCode: string | null;
  statusLabel: string;
  markCategory: string | null;
  markFeature: string | null;
  markText: string | null;
  applicantName: string | null;
  applicantCity: string | null;
  niceClasses: number[];
  imageFile: string | null;
}

export interface UpvSearchResult {
  query: { name: string; city?: string };
  count: number;
  active: number;
  expired: number;
  byFeature: Record<string, number>;
  trademarks: UpvTrademark[];
  source: { dataset: string; attribution: string };
}

/**
 * ST.96 status code mapping. Většina záznamů má kód 6 nebo 9. Detail
 * z dokumentace WIPO ST.96 + ÚPV praxe.
 */
const STATUS_LABELS: Record<string, string> = {
  "1": "Přihláška podaná",
  "2": "Po formálním průzkumu",
  "3": "Zveřejněna",
  "4": "S námitkami",
  "5": "Registrovaná",
  "6": "Platná (registrovaná)",
  "7": "Zanikla — neobnovena",
  "8": "Vzdaná",
  "9": "Zaniklá / odmítnutá",
  "41": "Předběžně odmítnutá",
  "51": "Po obnově",
  "52": "Předmět sporu",
};

function statusLabel(code: string | null): string {
  if (!code) return "Neznámý";
  return STATUS_LABELS[code] ?? `Kód ${code}`;
}

function isActiveStatus(code: string | null): boolean {
  // 1, 2, 3, 4, 5, 6 = živé řízení nebo platná značka.
  // 7, 8, 9 = zaniklé / odmítnuté.
  if (!code) return false;
  return ["1", "2", "3", "4", "5", "6", "51"].includes(code);
}

function normalize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,;:()\-–—'"„"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Vyhledá ochranné známky podle obchodního jména. Fuzzy přes `LIKE %name%`
 * na normalized sloupci. Pro krátká jména (< 4 znaky) vrátí prázdno — jinak
 * bychom matchovali tisíce nekontextních záznamů (např. "ABC" matchne
 * stovky firem).
 */
export function searchUpvByName(name: string, city?: string): UpvSearchResult {
  const dataset = "ÚPV, otevřená data ST.96 (10-02-2026 + denní DIFF)";
  const attribution = "Úřad průmyslového vlastnictví ČR, https://isdv.upv.gov.cz";

  const normalized = normalize(name);
  // Strip běžné suffixy aby se "AGROFERT, a.s." matchnul s "AGROFERT" v DB.
  const stripped = normalized.replace(/\s+(a s|s r o|spol s r o|k s|v o s|sro|as)$/u, "").trim();
  const queryKey = stripped.length >= 4 ? stripped : normalized;

  if (queryKey.length < 4) {
    return {
      query: { name, city },
      count: 0,
      active: 0,
      expired: 0,
      byFeature: {},
      trademarks: [],
      source: { dataset, attribution },
    };
  }

  const db = getDb();
  const params: Record<string, string> = { needle: `%${queryKey}%` };
  let sql = `
    SELECT application_number, application_date, status_code, mark_category,
           mark_feature, mark_text, applicant_name, applicant_city,
           nice_classes, image_file
    FROM upv_trademarks
    WHERE applicant_name_normalized LIKE @needle
  `;
  if (city) {
    sql += " AND (applicant_city LIKE @cityNeedle OR applicant_city IS NULL)";
    params.cityNeedle = `%${city.split(",")[0]?.trim() ?? city}%`;
  }
  sql += " ORDER BY application_date DESC LIMIT 500";

  const rows = db.prepare(sql).all(params) as Array<{
    application_number: string;
    application_date: string | null;
    status_code: string | null;
    mark_category: string | null;
    mark_feature: string | null;
    mark_text: string | null;
    applicant_name: string | null;
    applicant_city: string | null;
    nice_classes: string | null;
    image_file: string | null;
  }>;

  const trademarks: UpvTrademark[] = rows.map((r) => ({
    applicationNumber: r.application_number,
    applicationDate: r.application_date,
    statusCode: r.status_code,
    statusLabel: statusLabel(r.status_code),
    markCategory: r.mark_category,
    markFeature: r.mark_feature,
    markText: r.mark_text,
    applicantName: r.applicant_name,
    applicantCity: r.applicant_city,
    niceClasses: r.nice_classes ? r.nice_classes.split(",").map(Number).filter((n) => Number.isFinite(n)) : [],
    imageFile: r.image_file,
  }));

  const active = trademarks.filter((t) => isActiveStatus(t.statusCode)).length;
  const expired = trademarks.length - active;

  const byFeature: Record<string, number> = {};
  for (const t of trademarks) {
    const key = t.markFeature ?? "Unknown";
    byFeature[key] = (byFeature[key] ?? 0) + 1;
  }

  return {
    query: { name, city },
    count: trademarks.length,
    active,
    expired,
    byFeature,
    trademarks,
    source: { dataset, attribution },
  };
}
