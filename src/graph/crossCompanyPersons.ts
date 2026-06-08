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
  let totalActive = 0;

  for (const { ico, vr } of companies) {
    const primary = pickPrimaryZaznam(vr);
    const obchodniJmeno = currentObchodniJmeno(primary);
    companyMeta.push({ ico, obchodniJmeno, vrFound: vr !== null && (vr.zaznamy?.length ?? 0) > 0 });

    const members = flattenMembers(vr, { activeOnly: !includeHistorical });
    // totalActivePersons remains "active only" so the headline stays comparable
    // across includeHistorical=true/false runs.
    totalActive += members.filter((m) => !m.datumVymazu).length;

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

  // Všechny osoby napříč firmami (aspoň jedna aktivní vazba) — pro expand
  // „Aktivních osob" v UI. Seřazené podle počtu unikátních firem.
  const activePersons = [...personMap.values(), ...legalMap.values()]
    .filter((p) => p.memberships.some((m) => !m.datumVymazu))
    .sort((a, b) => uniqueIcoCount(b.memberships) - uniqueIcoCount(a.memberships));

  // Sdílení = ti, kdo jsou ve ≥2 unikátních firmách (subset activePersons).
  const sharedPersons = activePersons.filter((p) => uniqueIcoCount(p.memberships) >= 2);

  return {
    companies: companyMeta,
    totalActivePersons: totalActive,
    activePersons,
    sharedPersons,
    mermaid: renderMermaid(companyMeta, sharedPersons),
  };
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
  shared.forEach((p, idx) => {
    const pid = `P_${idx}`;
    const isLegal = p.personKey.startsWith("LEGAL|");
    const label = escapeMermaid(p.jmeno || "(unnamed)");
    const shape = isLegal ? `${pid}["${label}"]` : `${pid}(["${label}"])`;
    const cls = isLegal ? "legal" : "person";
    lines.push(`  ${shape}:::${cls}`);
    const seen = new Set<string>();
    for (const m of p.memberships) {
      if (seen.has(m.ico)) continue;
      seen.add(m.ico);
      const label = escapeMermaid(m.funkce ?? "člen");
      lines.push(`  ${pid} ---|"${label}"| C_${m.ico}`);
    }
  });
  // Důležité: explicit color: musí být v classDef, jinak Mermaid renderuje
  // foreignObject text se !important inline ze themeVariables (defaultně bílé
  // v dark mode → neviditelné na pastelovém fillu). Tmavý text na pastel
  // funguje vždy v obou režimech.
  lines.push("  classDef company fill:#e0f7fa,stroke:#006064,stroke-width:2px,color:#0f172a;");
  lines.push("  classDef person fill:#fff3e0,stroke:#bf360c,stroke-width:2px,color:#0f172a;");
  lines.push("  classDef legal fill:#f3e5f5,stroke:#4a148c,stroke-width:2px,color:#0f172a;");
  return lines.join("\n");
}
