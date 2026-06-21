// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Primární vládní sankční seznamy mimo EU — OFAC (US), UN, UK (OFSI).
 *
 * Doplněk k eu_sanctions (EU konsolidovaný list). Všechny tři jsou veřejné a
 * volně užitelné i komerčně (US/UN/UK vládní data). Stahujeme přímo z primárních
 * zdrojů (NE přes OpenSanctions, který má pro komerci licenci). Cache 24 h.
 *
 * Match: stejný token-set algoritmus jako EU (case+diacritic-insensitive, ≥2
 * tokeny, exact token-set superset). Sdílíme `normalizeNameForMatching`.
 */
import { fetch as undiciFetch } from "undici";
import { XMLParser } from "fast-xml-parser";
import { normalizeNameForMatching } from "../eu_sanctions/client.js";

const UA = "ares-web/0.2 (+https://github.com/milos106/ares-web)";
const TIMEOUT_MS = 90000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type SanctionSource = "OFAC" | "UN" | "UK";
export interface SanctionEntity {
  source: SanctionSource;
  name: string; // hlavní jméno
  programme: string | null; // režim / program
  refId: string;
}

async function fetchText(url: string, accept: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await undiciFetch(url, { redirect: "follow", headers: { "user-agent": UA, accept }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Minimalistický CSV řádek parser — kvótované pole s čárkami uvnitř. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// ─── OFAC SDN (CSV) ────────────────────────────────────────────────────────────
// ent_num, SDN_Name, SDN_Type, Program, Title, ... — bereme hlavní jméno.
async function fetchOfac(): Promise<SanctionEntity[]> {
  const csv = await fetchText("https://www.treasury.gov/ofac/downloads/sdn.csv", "text/csv");
  const out: SanctionEntity[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line) continue;
    const c = parseCsvLine(line);
    const num = c[0];
    const name = (c[1] ?? "").replace(/^-0-$/, "").trim();
    const program = (c[3] ?? "").replace(/^-0-$/, "").trim();
    if (!name) continue;
    out.push({ source: "OFAC", name, programme: program || null, refId: `OFAC-${num}` });
  }
  return out;
}

// ─── UN konsolidovaný (XML) ─────────────────────────────────────────────────────
// <INDIVIDUAL>/<ENTITY> s FIRST_NAME..FOURTH_NAME (+ aliasy). Skládáme celé jméno.
interface UnNode {
  DATAID?: string | number;
  FIRST_NAME?: string;
  SECOND_NAME?: string;
  THIRD_NAME?: string;
  FOURTH_NAME?: string;
  UN_LIST_TYPE?: string;
}
function unFullName(n: UnNode): string {
  return [n.FIRST_NAME, n.SECOND_NAME, n.THIRD_NAME, n.FOURTH_NAME].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
async function fetchUn(): Promise<SanctionEntity[]> {
  const xml = await fetchText("https://scsanctions.un.org/resources/xml/en/consolidated.xml", "application/xml,text/xml");
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, trimValues: true });
  const parsed = parser.parse(xml);
  const root = parsed?.CONSOLIDATED_LIST ?? parsed?.consolidated_list ?? parsed;
  const asArr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const inds = asArr<UnNode>(root?.INDIVIDUALS?.INDIVIDUAL);
  const ents = asArr<UnNode>(root?.ENTITIES?.ENTITY);
  const out: SanctionEntity[] = [];
  for (const n of [...inds, ...ents]) {
    const name = unFullName(n);
    if (!name) continue;
    out.push({ source: "UN", name, programme: n.UN_LIST_TYPE ? String(n.UN_LIST_TYPE) : null, refId: `UN-${n.DATAID ?? name}` });
  }
  return out;
}

// ─── UK OFSI ConList (CSV s hlavičkou) ─────────────────────────────────────────
// Sloupce „Name 1".."Name 6" → celé jméno; „Group Type", „Regime".
async function fetchUk(): Promise<SanctionEntity[]> {
  const csv = await fetchText("https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv", "text/csv");
  const lines = csv.split(/\r?\n/);
  // hlavička je na 1. řádku, který obsahuje „Name 1" (před ním může být meta řádek)
  let headerIdx = lines.findIndex((l) => /Name 1/.test(l) && /Name 6/.test(l));
  if (headerIdx < 0) return [];
  const header = parseCsvLine(lines[headerIdx]!);
  const col = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const nameCols = [1, 2, 3, 4, 5, 6].map((i) => col(`Name ${i}`)).filter((i) => i >= 0);
  const regimeCol = col("Regime");
  const groupIdCol = col("Group ID");
  const out: SanctionEntity[] = [];
  const seen = new Set<string>();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const c = parseCsvLine(lines[i]!);
    // UK řadí Name 1=příjmení … Name 6=jméno; složíme od 6 k 1 (čitelné pořadí)
    const parts = nameCols.map((ci) => c[ci] ?? "").filter(Boolean);
    const name = parts.reverse().join(" ").replace(/\s+/g, " ").trim();
    if (!name) continue;
    const gid = groupIdCol >= 0 ? c[groupIdCol] : String(i);
    const dedupe = `${gid}|${name}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ source: "UK", name, programme: regimeCol >= 0 ? c[regimeCol] ?? null : null, refId: `UK-${gid}` });
  }
  return out;
}

// ─── Combined snapshot + token index ───────────────────────────────────────────
interface IndexEntry { entity: SanctionEntity; tokens: Set<string> }
interface Snapshot { loadedAt: number; entities: SanctionEntity[]; byToken: Map<string, IndexEntry[]>; sources: Record<SanctionSource, number> }
let snapshot: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;

async function buildSnapshot(): Promise<Snapshot> {
  // každý zdroj resilientně — selhání jednoho nezruší ostatní
  const results = await Promise.allSettled([fetchOfac(), fetchUn(), fetchUk()]);
  const entities: SanctionEntity[] = [];
  const sources: Record<SanctionSource, number> = { OFAC: 0, UN: 0, UK: 0 };
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const e of r.value) { entities.push(e); sources[e.source]++; }
    }
  }
  const byToken = new Map<string, IndexEntry[]>();
  for (const ent of entities) {
    const tokens = new Set(normalizeNameForMatching(ent.name).split(" ").filter((t) => t.length >= 2));
    if (tokens.size === 0) continue;
    const ie: IndexEntry = { entity: ent, tokens };
    for (const t of tokens) {
      const l = byToken.get(t);
      if (l) l.push(ie);
      else byToken.set(t, [ie]);
    }
  }
  return { loadedAt: Date.now(), entities, byToken, sources };
}

async function getSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.loadedAt < CACHE_TTL_MS) return snapshot;
  if (inflight) return inflight;
  inflight = buildSnapshot().then((s) => { snapshot = s; return s; }).finally(() => { inflight = null; });
  return inflight;
}

export interface ExtraSanctionsHit { query: string; source: SanctionSource; matchedAs: string; programme: string | null }

/** Screening jmen proti OFAC+UN+UK (stejná token-set logika jako EU). */
export async function screenExtraSanctions(names: string[]): Promise<{ hits: ExtraSanctionsHit[]; sources: Record<SanctionSource, number> }> {
  if (process.env.SANCTIONS_EXTRA_DISABLED === "true") return { hits: [], sources: { OFAC: 0, UN: 0, UK: 0 } };
  const s = await getSnapshot();
  const hits: ExtraSanctionsHit[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    if (!raw) continue;
    const qTokens = [...new Set(normalizeNameForMatching(raw).split(" ").filter((t) => t.length >= 2))];
    if (qTokens.length < 2) continue;
    let candidates: IndexEntry[] | null = null;
    let smallest = Infinity;
    for (const t of qTokens) {
      const l = s.byToken.get(t);
      if (!l) { candidates = null; break; }
      if (l.length < smallest) { smallest = l.length; candidates = l; }
    }
    if (!candidates) continue;
    for (const ie of candidates) {
      if (!qTokens.every((t) => ie.tokens.has(t))) continue;
      const key = `${raw}|${ie.entity.refId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ query: raw, source: ie.entity.source, matchedAs: ie.entity.name, programme: ie.entity.programme });
    }
  }
  return { hits, sources: s.sources };
}

export const EXTRA_SANCTIONS_ATTRIBUTION = {
  sources: "OFAC SDN (US Treasury), UN Security Council Consolidated List, UK OFSI Consolidated List",
  license: "Vládní data US/UN/UK — volné užití vč. komerčního (uveď zdroj). Stahováno z primárních zdrojů.",
  matchNote: "Token-set match (case+diacritic-insensitive, ≥2 tokeny). Pro 100% jistotu konzultuj primární zdroj.",
};

export function clearExtraSanctionsCache(): void { snapshot = null; }
