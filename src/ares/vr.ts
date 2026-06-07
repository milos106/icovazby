import type {
  VrClenOrganu,
  VrFyzickaOsoba,
  VrOdpoved,
  VrPravnickaOsoba,
  VrZaznam,
} from "./types.js";

export interface FlattenedMember {
  organName?: string;
  funkce?: string;
  typAngazma?: string;
  datumZapisu?: string;
  datumVymazu?: string;
  fyzickaOsoba?: VrFyzickaOsoba;
  pravnickaOsoba?: VrPravnickaOsoba;
}

/**
 * Pick the most relevant VrZaznam from a wrapper response. ARES often returns
 * one AKTIVNI record and one or more HISTORICKY records (only the AKTIVNI one
 * has populated `statutarniOrgany`). We prefer AKTIVNI; if none, fall back to
 * the first record so callers always get something to inspect.
 */
export function pickPrimaryZaznam(vr: VrOdpoved | null | undefined): VrZaznam | null {
  const zaznamy = vr?.zaznamy ?? [];
  if (zaznamy.length === 0) return null;
  return zaznamy.find((z) => z.stavSubjektu === "AKTIVNI") ?? zaznamy[0] ?? null;
}

/**
 * Current trading name from a VrZaznam. ARES stores obchodniJmeno as a history
 * array; the current name is the entry with no datumVymazu (or the last one).
 */
export function currentObchodniJmeno(zaznam: VrZaznam | null | undefined): string | undefined {
  const list = zaznam?.obchodniJmeno ?? [];
  if (list.length === 0) return undefined;
  const active = list.find((n) => !n.datumVymazu);
  return active?.hodnota ?? list[list.length - 1]?.hodnota;
}

/**
 * Flatten all members of all statutory organs across all VR records, optionally
 * filtering to currently-active ones (those with no datumVymazu).
 */
export function flattenMembers(
  vr: VrOdpoved | null | undefined,
  opts: { activeOnly?: boolean } = {},
): FlattenedMember[] {
  const activeOnly = opts.activeOnly ?? true;
  const result: FlattenedMember[] = [];
  for (const zaznam of vr?.zaznamy ?? []) {
    for (const organ of zaznam.statutarniOrgany ?? []) {
      for (const m of organ.clenoveOrganu ?? []) {
        if (activeOnly && m.datumVymazu) continue;
        result.push({
          organName: organ.nazevOrganu,
          funkce: m.clenstvi?.funkce?.nazev ?? m.nazevAngazma,
          typAngazma: m.typAngazma,
          datumZapisu: m.datumZapisu,
          datumVymazu: m.datumVymazu,
          fyzickaOsoba: m.fyzickaOsoba,
          pravnickaOsoba: m.pravnickaOsoba,
        });
      }
    }
  }
  return result;
}

/**
 * Stable identity key for a physical person, based on name + birth date. ARES
 * does not expose rodné číslo via the public API, so this is the best available
 * proxy. We uppercase and trim to coalesce minor formatting differences.
 */
export function personKey(p: VrFyzickaOsoba | undefined): string | null {
  if (!p) return null;
  const last = (p.prijmeni ?? "").trim().toUpperCase();
  const first = (p.jmeno ?? "").trim().toUpperCase();
  const dob = (p.datumNarozeni ?? "").trim();
  if (!last && !first) return null;
  return `${last}|${first}|${dob}`;
}

export function formatPersonName(p: VrFyzickaOsoba | undefined): string {
  if (!p) return "";
  const parts = [p.titulPredJmenem, p.jmeno, p.prijmeni, p.titulZaJmenem]
    .map((s) => (s ?? "").trim())
    .filter(Boolean);
  return parts.join(" ") || (p.textOsoba ?? "").trim();
}

export function memberDisplayName(m: VrClenOrganu | FlattenedMember): string {
  if (m.fyzickaOsoba) return formatPersonName(m.fyzickaOsoba);
  if (m.pravnickaOsoba)
    return `${m.pravnickaOsoba.obchodniJmeno ?? ""}${m.pravnickaOsoba.ico ? ` (IČO ${m.pravnickaOsoba.ico})` : ""}`.trim();
  return "(unknown)";
}
