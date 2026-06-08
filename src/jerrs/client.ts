// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * JERRS open-data client — seznamy regulovaných subjektů ČNB.
 *
 * Plný WS JERRS (SOAP getSubjekt/getSubjekty) vyžaduje komerční certifikát
 * a žádost emailem na jerrsws@cnb.cz — pro otevřenou webovou aplikaci je
 * to nepoužitelné. Místo toho používáme stejný backend přes oficiální
 * open-data export ČNB, který je publikovaný podle nařízení vlády 425/2016 Sb.
 * (volné užití):
 *
 *   https://apl.cnb.cz/apljerrsdad/JERRS.OPENDATA.STAHUJ?p_seznam={1..7}
 *
 * Pokrytí: banky, směnárny, NPSU (nebank. poskytovatelé spot. úvěru),
 * SZSU/VZSU/ZVSU/ZZSU (zprostředkovatelé spot. úvěru). Nepokrývá penzijky,
 * pojišťovny, investiční společnosti — ty jsou jen za certifikátem nebo
 * v PDF na cnb.cz.
 *
 * Index: stáhneme všech 7 CSV při prvním dotazu (~2 MB celkem), uložíme
 * IČO → kategorie do paměti, 24h TTL.
 */

import { fetch as undiciFetch } from "undici";

const BASE = "https://apl.cnb.cz/apljerrsdad/JERRS.OPENDATA.STAHUJ?p_seznam=";
const TIMEOUT_MS = 30000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — datová aktualizace 1x denně

export interface JerrsCategory {
  id: number;
  code: string;
  label: string;
  description: string;
}

export const JERRS_CATEGORIES: ReadonlyArray<JerrsCategory> = [
  {
    id: 1,
    code: "BANK",
    label: "Banka / pobočka zahraniční banky",
    description: "Subjekt s bankovní licencí podle z. č. 21/1992 Sb.",
  },
  {
    id: 2,
    code: "SMEN",
    label: "Směnárna",
    description: "Osoba oprávněná provozovat směnárenskou činnost.",
  },
  {
    id: 3,
    code: "SZSU",
    label: "Samostatný zprostředkovatel spotřebitelského úvěru",
    description: "Licencovaný samostatný zprostředkovatel (SZSU) podle z. č. 257/2016 Sb.",
  },
  {
    id: 4,
    code: "VZSU",
    label: "Vázaný zástupce",
    description: "Vázaný zástupce registrovaný na základě zastoupení samostatného zprostředkovatele.",
  },
  {
    id: 5,
    code: "ZVSU",
    label: "Zprostředkovatel vázaného spotřebitelského úvěru",
    description: "Zprostředkovatel oprávněný k vázanému spotřebitelskému úvěru.",
  },
  {
    id: 6,
    code: "ZZSU",
    label: "Zahraniční zprostředkovatel hypotečního úvěru",
    description: "Zahraniční zprostředkovatel hypotečního spotřebitelského úvěru.",
  },
  {
    id: 7,
    code: "NPSU",
    label: "Nebankovní poskytovatel spotřebitelského úvěru",
    description: "Licencovaný nebankovní poskytovatel spotřebitelského úvěru (NPSU).",
  },
];

export const JERRS_CATEGORY_BY_ID: ReadonlyMap<number, JerrsCategory> = new Map(
  JERRS_CATEGORIES.map((c) => [c.id, c]),
);

export interface JerrsMembership {
  category: JerrsCategory;
  name: string;
  datumVzniku: string | null;
  address: string;
  obec: string | null;
  psc: string | null;
  zeme: string | null;
}

interface IndexEntry {
  ico: string;
  memberships: JerrsMembership[];
}

interface Snapshot {
  loadedAt: number;
  byIco: Map<string, JerrsMembership[]>;
  counts: Record<string, number>;
  totalRows: number;
}

let snapshot: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;

/**
 * Minimalistický CSV parser (RFC 4180 podmnožina).
 *
 * Schéma každého ze 7 seznamů (11 sloupců):
 *   ičo,název,název_ulice,číslo_domovní,číslo_orientační,znak_čísla_orientačního,
 *   název_části_obce,název_obce,psč,země_kód,datum_vzniku
 *
 * Citujeme jen řetězce, čísla a datum jsou holé. Embedded "" je escape pro ".
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

async function fetchList(id: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await undiciFetch(`${BASE}${id}`, {
      redirect: "follow",
      headers: {
        accept: "text/csv,*/*",
        "user-agent": "ares-web/0.2 (+https://github.com/milos106/ares-web)",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`JERRS p_seznam=${id} HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeIco(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.padStart(8, "0");
}

function buildAddress(row: string[]): string {
  // 2:ulice 3:č.domovní 4:č.orientační 5:znak 6:část obce 7:obec 8:psč
  const ulice = row[2];
  const cDomovni = row[3];
  const cOrient = row[4];
  const znak = row[5];
  const obec = row[7];
  const psc = row[8];
  let cislo = "";
  if (cDomovni && cOrient) cislo = `${cDomovni}/${cOrient}${znak || ""}`;
  else cislo = cDomovni || cOrient || "";
  const street = [ulice, cislo].filter(Boolean).join(" ");
  return [street, [psc, obec].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

async function buildSnapshot(): Promise<Snapshot> {
  const byIco = new Map<string, JerrsMembership[]>();
  const counts: Record<string, number> = {};
  let totalRows = 0;
  const lists = await Promise.all(
    JERRS_CATEGORIES.map(async (cat) => ({ cat, csv: await fetchList(cat.id) })),
  );
  for (const { cat, csv } of lists) {
    const rows = parseCsv(csv);
    // první řádek = header
    const dataRows = rows.slice(1);
    counts[cat.code] = dataRows.length;
    totalRows += dataRows.length;
    for (const row of dataRows) {
      if (row.length < 11) continue;
      const ico = normalizeIco(row[0]);
      if (!/^\d{8}$/.test(ico)) continue;
      const membership: JerrsMembership = {
        category: cat,
        name: row[1] || "",
        datumVzniku: row[10] || null,
        address: buildAddress(row),
        obec: row[7] || null,
        psc: row[8] || null,
        zeme: row[9] || null,
      };
      const existing = byIco.get(ico);
      if (existing) existing.push(membership);
      else byIco.set(ico, [membership]);
    }
  }
  return { loadedAt: Date.now(), byIco, counts, totalRows };
}

async function getSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.loadedAt < CACHE_TTL_MS) return snapshot;
  if (inflight) return inflight;
  inflight = buildSnapshot()
    .then((s) => {
      snapshot = s;
      return s;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export interface JerrsLookupResult {
  ico: string;
  isRegulated: boolean;
  memberships: JerrsMembership[];
  totalSubjects: number;
  loadedAt: string;
}

export async function lookupJerrsByIco(ico: string): Promise<JerrsLookupResult> {
  const key = normalizeIco(ico);
  if (!/^\d{8}$/.test(key)) {
    throw new Error(`Invalid IČO '${ico}'.`);
  }
  const s = await getSnapshot();
  const memberships = s.byIco.get(key) ?? [];
  return {
    ico: key,
    isRegulated: memberships.length > 0,
    memberships,
    totalSubjects: s.totalRows,
    loadedAt: new Date(s.loadedAt).toISOString(),
  };
}

export const JERRS_ATTRIBUTION = {
  source: "ČNB — JERRS otevřená data (seznamy regulovaných subjektů)",
  url: "https://www.cnb.cz/cs/dohled-financni-trh/seznamy/Otevrena-data/",
  apiUrl: "https://apl.cnb.cz/apljerrsdad/JERRS.OPENDATA.STAHUJ",
  license: "Otevřená data podle nařízení vlády 425/2016 Sb. (volné užití)",
  updateInterval: "1× denně",
  coverage: "Banky, směnárny, NPSU/SZSU/VZSU/ZVSU/ZZSU — spotřebitelský úvěr a bankovnictví",
  notCovered:
    "Investiční společnosti, pojišťovny, penzijní společnosti, platební instituce — vyžadují plný WS JERRS s komerčním certifikátem.",
};

export function clearJerrsCache(): void {
  snapshot = null;
}
