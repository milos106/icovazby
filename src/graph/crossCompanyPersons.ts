// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VrOdpoved } from "../ares/types.js";
import {
  currentObchodniJmeno,
  flattenMembers,
  memberDisplayName,
  personKey,
  pickPrimaryZaznam,
} from "../ares/vr.js";

export interface CompanyInput {
  ico: string;
  vr: VrOdpoved | null;
}

export interface Membership {
  ico: string;
  company?: string;
  funkce?: string;
  organ?: string;
  /** Set when the membership has ended (historical entry). */
  datumVymazu?: string | null;
  datumZapisu?: string | null;
}

export interface SharedPerson {
  personKey: string;
  jmeno: string;
  datumNarozeni?: string;
  memberships: Membership[];
}

export interface GraphResult {
  companies: { ico: string; obchodniJmeno?: string; vrFound: boolean }[];
  totalActivePersons: number;
  /** Všechny aktivní osoby+právnické osoby napříč firmami, seřazené podle
   *  počtu unikátních firem (sdílené nahoře). Slouží pro expand „Aktivních
   *  osob" v UI. */
  activePersons: SharedPerson[];
  sharedPersons: SharedPerson[];
  /** Vlastnické hrany mezi firmami v sadě (akcionář-PO → vlastněná firma).
   *  Jen v rámci dotazované sady IČO — pro „vrstvu vlastnictví" v mapě. */
  ownershipEdges: { from: string; to: string }[];
  mermaid: string;
}

export interface BuildGraphOptions {
  /**
   * If true, also include members whose `datumVymazu` is set (= former
   * statutaries). When combined with active members this surfaces nominee /
   * musical-chair patterns invisible to a snapshot of just current members.
   */
  includeHistorical?: boolean;
}

/**
 * Build a person→companies cross-reference from a batch of VR responses.
 *
 * - By default, active members only (`datumVymazu == null`). Pass
 *   `{ includeHistorical: true }` to also include former members.
 * - Identity key = lastname + firstname + birth date. ARES does not expose
 *   rodné číslo via the public API, so collisions are possible but rare in
 *   practice for a small known set of IČOs.
 * - A "shared person" is one whose key appears across two or more distinct
 *   IČOs in the input set.
 * - Legal-entity members (`pravnickaOsoba`) are tracked separately and also
 *   reported when shared.
 */
export function buildCrossCompanyGraph(
  companies: CompanyInput[],
  opts: BuildGraphOptions = {},
): GraphResult {
  const includeHistorical = opts.includeHistorical ?? false;
  const companyMeta: GraphResult["companies"] = [];
  // personKey → memberships
  const personMap = new Map<string, SharedPerson>();
  // legal-entity IČO → memberships (separate space from personKey)
  const legalMap = new Map<string, SharedPerson>();

  for (const { ico, vr } of companies) {
    const primary = pickPrimaryZaznam(vr);
    const obchodniJmeno = currentObchodniJmeno(primary);
    companyMeta.push({ ico, obchodniJmeno, vrFound: vr !== null && (vr.zaznamy?.length ?? 0) > 0 });

    const members = flattenMembers(vr, { activeOnly: !includeHistorical });

    for (const m of members) {
      if (m.fyzickaOsoba) {
        const key = personKey(m.fyzickaOsoba);
        if (!key) continue;
        if (!personMap.has(key)) {
          personMap.set(key, {
            personKey: key,
            jmeno: memberDisplayName(m),
            datumNarozeni: m.fyzickaOsoba.datumNarozeni,
            memberships: [],
          });
        }
        personMap.get(key)!.memberships.push({
          ico,
          company: obchodniJmeno,
          funkce: m.funkce,
          organ: m.organName,
          datumZapisu: m.datumZapisu ?? null,
          datumVymazu: m.datumVymazu ?? null,
        });
      } else if (m.pravnickaOsoba?.ico) {
        const key = `LEGAL|${m.pravnickaOsoba.ico}`;
        if (!legalMap.has(key)) {
          legalMap.set(key, {
            personKey: key,
            jmeno: memberDisplayName(m),
            memberships: [],
          });
        }
        legalMap.get(key)!.memberships.push({
          ico,
          company: obchodniJmeno,
          funkce: m.funkce,
          organ: m.organName,
          datumZapisu: m.datumZapisu ?? null,
          datumVymazu: m.datumVymazu ?? null,
        });
      }
    }
  }

  // Vlastnické hrany: pro každou firmu vytáhni vlastníky-PO (společníci s.r.o.
  // / akcionáři a.s.) a pokud je vlastník TAKÉ v dotazované sadě, přidej hranu
  // vlastník → vlastněná firma. Jen v rámci sady (hrany ven by visely).
  const setIcos = new Set(companies.map((c) => c.ico));
  const ownershipEdges: { from: string; to: string }[] = [];
  const seenEdge = new Set<string>();
  for (const { ico, vr } of companies) {
    for (const owner of extractOwnerIcos(vr, includeHistorical)) {
      if (owner === ico || !setIcos.has(owner)) continue;
      const k = `${owner}>${ico}`;
      if (seenEdge.has(k)) continue;
      seenEdge.add(k);
      ownershipEdges.push({ from: owner, to: ico });
    }
  }

  // Všechny osoby napříč firmami (aspoň jedna aktivní vazba) — pro expand
  // „Aktivních osob" v UI. Seřazené podle počtu unikátních firem.
  const activePersons = [...personMap.values(), ...legalMap.values()]
    .filter((p) => p.memberships.some((m) => !m.datumVymazu))
    .sort((a, b) => uniqueIcoCount(b.memberships) - uniqueIcoCount(a.memberships));

  // Sdílení = ti, kdo jsou ve ≥2 unikátních firmách (subset activePersons).
  const sharedPersons = activePersons.filter((p) => uniqueIcoCount(p.memberships) >= 2);

  return {
    companies: companyMeta,
    // Počítáme unikátní osoby/PO (deduplikace přes personKey), takže UI tile
    // a rozkliknutý seznam mají stejné číslo. Dřív se sčítaly raw rows ze
    // všech VR, což generovalo 32 vs 26 nekonzistenci u Agrofertu.
    totalActivePersons: activePersons.length,
    activePersons,
    sharedPersons,
    ownershipEdges,
    mermaid: renderMermaid(companyMeta, sharedPersons),
  };
}

/**
 * Vytáhne IČO vlastníků-právnických osob z VR. Pokrývá obě formy:
 *  - s.r.o. → blok `spolecnici` (plochý VrClenOrganu[], typovaný)
 *  - a.s.   → blok `akcionari` (vnořený, mimo typovaný model → assertion)
 * Vlastník = právnická osoba s IČO.
 */
function extractOwnerIcos(vr: VrOdpoved | null, includeHistorical: boolean): string[] {
  if (!vr) return [];
  const out = new Set<string>();
  const addIco = (ico?: string) => {
    if (ico && /^\d{7,8}$/.test(ico)) out.add(ico.padStart(8, "0"));
  };
  type AkcionarBlock = {
    datumVymazu?: string | null;
    clenoveOrganu?: Array<{ datumVymazu?: string | null; pravnickaOsoba?: { ico?: string } }>;
  };
  for (const zaznam of vr.zaznamy ?? []) {
    // s.r.o. — společníci (plochý seznam)
    for (const s of zaznam.spolecnici ?? []) {
      if (!includeHistorical && s.datumVymazu) continue;
      addIco(s.pravnickaOsoba?.ico);
    }
    // a.s. — akcionáři (vnořená struktura)
    for (const blok of (zaznam as { akcionari?: AkcionarBlock[] }).akcionari ?? []) {
      if (!includeHistorical && blok.datumVymazu) continue;
      for (const clen of blok.clenoveOrganu ?? []) {
        if (!includeHistorical && clen.datumVymazu) continue;
        addIco(clen.pravnickaOsoba?.ico);
      }
    }
  }
  return [...out];
}

function uniqueIcoCount(memberships: Membership[]): number {
  return new Set(memberships.map((m) => m.ico)).size;
}

function escapeMermaid(s: string): string {
  return s.replace(/"/g, "'").replace(/\n/g, " ");
}

function renderMermaid(
  companies: GraphResult["companies"],
  shared: SharedPerson[],
): string {
  const lines: string[] = ["graph LR"];
  for (const c of companies) {
    const label = escapeMermaid(`${c.obchodniJmeno ?? "(unknown)"}\\n${c.ico}`);
    lines.push(`  C_${c.ico}["${label}"]:::company`);
  }

  // Index of dashed edges — používáme `linkStyle N` na konci grafu pro
  // amber stroke + dasharray. Mermaid `-.-` syntax sám o sobě dělá tečkovaný
  // ale konzistence vzhledu chce vlastní stroke.
  const dashedEdgeIndices: number[] = [];
  let edgeIdx = -1;

  shared.forEach((p, idx) => {
    const pid = `P_${idx}`;
    const isLegal = p.personKey.startsWith("LEGAL|");
    const label = escapeMermaid(p.jmeno || "(unnamed)");
    const shape = isLegal ? `${pid}["${label}"]` : `${pid}(["${label}"])`;
    const cls = isLegal ? "legal" : "person";
    lines.push(`  ${shape}:::${cls}`);

    // Group memberships podle IČO — pro každý vztah osoba→firma chceme
    // jednu hranu reprezentující buď aktuální pozici (preferred), nebo
    // (pokud aktuální není) nejnovější historickou pozici.
    const byIco = new Map<string, typeof p.memberships>();
    for (const m of p.memberships) {
      const arr = byIco.get(m.ico);
      if (arr) arr.push(m);
      else byIco.set(m.ico, [m]);
    }

    for (const [ico, members] of byIco) {
      // Preferuj aktuální (datumVymazu=null), jinak nejnovější historickou.
      const active = members.find((m) => !m.datumVymazu);
      let funkce: string;
      let datumLabel: string;
      let isHistorical: boolean;
      if (active) {
        funkce = active.funkce ?? "člen";
        const startYear = active.datumZapisu?.slice(0, 4);
        datumLabel = startYear ? `od ${startYear}` : "aktivní";
        isHistorical = false;
      } else {
        // Sort by datumVymazu desc — pick the latest ended membership
        const latest = [...members].sort((a, b) =>
          (b.datumVymazu || "").localeCompare(a.datumVymazu || ""),
        )[0]!;
        funkce = latest.funkce ?? "člen";
        const sy = latest.datumZapisu?.slice(0, 4) || "?";
        const ey = latest.datumVymazu?.slice(0, 4) || "?";
        datumLabel = `${sy}–${ey}`;
        isHistorical = true;
      }
      const edgeLabel = escapeMermaid(`${funkce}\\n(${datumLabel})`);
      edgeIdx++;
      if (isHistorical) {
        // -.- = dashed in Mermaid; navíc přidáme linkStyle pro amber barvu
        lines.push(`  ${pid} -. "${edgeLabel}" .- C_${ico}`);
        dashedEdgeIndices.push(edgeIdx);
      } else {
        lines.push(`  ${pid} ---|"${edgeLabel}"| C_${ico}`);
      }
    }
  });

  // Důležité: explicit color: musí být v classDef, jinak Mermaid renderuje
  // foreignObject text se !important inline ze themeVariables (defaultně bílé
  // v dark mode → neviditelné na pastelovém fillu). Tmavý text na pastel
  // funguje vždy v obou režimech.
  lines.push("  classDef company fill:#e0f7fa,stroke:#006064,stroke-width:2px,color:#0f172a;");
  lines.push("  classDef person fill:#fff3e0,stroke:#bf360c,stroke-width:2px,color:#0f172a;");
  lines.push("  classDef legal fill:#f3e5f5,stroke:#4a148c,stroke-width:2px,color:#0f172a;");

  // Amber barva pro historické (dashed) hrany
  for (const i of dashedEdgeIndices) {
    lines.push(`  linkStyle ${i} stroke:#d97706,stroke-width:1.5px,stroke-dasharray: 5 4;`);
  }

  return lines.join("\n");
}
