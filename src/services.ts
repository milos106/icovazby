/**
 * Pure service layer — takes an AresClient + input args, returns structured
 * JSON ready for the HTTP layer. No framework dependencies, no MCP. Mirrors
 * the business logic from ares-mcp's tools so the two projects stay in sync,
 * but the response shapes are tuned for direct browser display (not MCP).
 */

import type { AresClient } from "./ares/client.js";
import {
  normalizeDic,
  validateIco as validateIcoFn,
} from "./ares/normalize.js";
import type { EkonomickySubjekt, RzpZaznam, VrOdpoved } from "./ares/types.js";
import {
  currentObchodniJmeno,
  flattenMembers,
  memberDisplayName,
  pickPrimaryZaznam,
} from "./ares/vr.js";
import { InvalidInputError, NotFoundError } from "./errors.js";
import {
  type CompanyInput,
  buildCrossCompanyGraph,
} from "./graph/crossCompanyPersons.js";

export const ARES_ATTRIBUTION = {
  source: "ARES — Administrativní registr ekonomických subjektů",
  publisher: "Ministerstvo financí ČR",
  license: "CC BY 4.0",
  url: "https://ares.gov.cz/",
  notAffiliated:
    "ares-web is an independent open-source project and is not affiliated with, endorsed by, or sponsored by MFČR or the ARES operator.",
};

function isActiveRegistration(value: string | null | undefined): boolean {
  return value === "AKTIVNI";
}

function statusOf(value: string | null | undefined): "ACTIVE" | "ENDED" | "NONE" {
  if (value === "AKTIVNI") return "ACTIVE";
  if (value === "ZANIKLY") return "ENDED";
  return "NONE";
}

// ─── Validate IČO ──────────────────────────────────────────────────────────────
export function validateIcoService(input: string) {
  const result = validateIcoFn(input);
  return {
    input,
    normalized: result.normalized,
    valid: result.valid,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

// ─── Lookup company profile ───────────────────────────────────────────────────
export async function lookupCompanyService(client: AresClient, icoInput: string) {
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });
  const subject = await client.getEconomicSubject(normalized);
  const reg = subject.seznamRegistraci ?? {};
  const dphActive = isActiveRegistration(reg.stavZdrojeDph);
  const czNace =
    (subject as { czNace2008?: string[] }).czNace2008 ?? subject.czNace ?? [];
  return {
    ico: normalized,
    obchodniJmeno: subject.obchodniJmeno,
    pravniForma: subject.pravniForma,
    datumVzniku: subject.datumVzniku,
    datumZaniku: subject.datumZaniku ?? null,
    dic: subject.dic ?? null,
    platceDph: dphActive,
    icDph: dphActive ? (subject.dic ?? null) : null,
    sidlo: subject.sidlo,
    sidloText: subject.sidlo?.textovaAdresa,
    seznamRegistraci: subject.seznamRegistraci,
    czNace,
    datumAktualizace: subject.datumAktualizace,
    _attribution: ARES_ATTRIBUTION,
  };
}

// ─── Search companies (by name) ───────────────────────────────────────────────
export async function searchCompaniesService(
  client: AresClient,
  args: { obchodniJmeno?: string; sidloPsc?: string; limit?: number; offset?: number },
) {
  if (!args.obchodniJmeno && !args.sidloPsc) {
    throw new InvalidInputError("Provide obchodniJmeno or sidloPsc.");
  }
  const sidlo: Record<string, unknown> = {};
  if (args.sidloPsc) {
    const psc = Number(args.sidloPsc.replace(/\s/g, ""));
    if (Number.isFinite(psc)) sidlo.psc = psc;
  }
  const result = await client.searchEconomicSubjects({
    obchodniJmeno: args.obchodniJmeno,
    sidlo: Object.keys(sidlo).length > 0 ? sidlo : undefined,
    pocet: Math.min(args.limit ?? 25, 100),
    start: args.offset ?? 0,
  });
  return {
    celkemNalezeno: result.pocetCelkem ?? 0,
    vraceno: result.ekonomickeSubjekty?.length ?? 0,
    vysledky:
      result.ekonomickeSubjekty?.map((s) => ({
        ico: s.ico,
        obchodniJmeno: s.obchodniJmeno,
        sidlo: s.sidlo?.textovaAdresa,
        pravniForma: s.pravniForma,
        datumVzniku: s.datumVzniku,
        datumZaniku: s.datumZaniku ?? null,
      })) ?? [],
    _attribution: ARES_ATTRIBUTION,
  };
}

// ─── Search by address (shell detection) ──────────────────────────────────────
export async function searchByAddressService(
  client: AresClient,
  args: { adresa: string; limit?: number; offset?: number },
) {
  if (!args.adresa || args.adresa.length < 3) {
    throw new InvalidInputError("Address must be at least 3 characters.");
  }
  const result = await client.searchEconomicSubjects({
    sidlo: { textovaAdresa: args.adresa } as Record<string, unknown>,
    pocet: Math.min(args.limit ?? 50, 100),
    start: args.offset ?? 0,
  });
  const total = result.pocetCelkem ?? 0;
  let shellLevel: "low" | "medium" | "high" = "low";
  if (total > 500) shellLevel = "high";
  else if (total > 50) shellLevel = "medium";
  return {
    adresa: args.adresa,
    celkemNalezeno: total,
    vraceno: result.ekonomickeSubjekty?.length ?? 0,
    shellLevel,
    vysledky:
      result.ekonomickeSubjekty?.map((s) => ({
        ico: s.ico,
        obchodniJmeno: s.obchodniJmeno,
        sidlo: s.sidlo?.textovaAdresa,
        pravniForma: s.pravniForma,
        datumVzniku: s.datumVzniku,
        datumZaniku: s.datumZaniku ?? null,
      })) ?? [],
    _attribution: ARES_ATTRIBUTION,
  };
}

// ─── Cross-company persons ────────────────────────────────────────────────────
export async function crossCompanyPersonsService(
  client: AresClient,
  args: { icos: string[]; includeHistorical?: boolean; emitMermaid?: boolean },
) {
  const normalizedIcos: string[] = [];
  for (const raw of args.icos) {
    const { valid, normalized, reason } = validateIcoFn(raw);
    if (!valid || !normalized) {
      throw new InvalidInputError(`Invalid IČO in input: '${raw}'`, { reason });
    }
    normalizedIcos.push(normalized);
  }
  const uniqueIcos = [...new Set(normalizedIcos)];
  if (uniqueIcos.length < 2) {
    throw new InvalidInputError("At least two distinct IČOs are required.");
  }
  if (uniqueIcos.length > 50) {
    throw new InvalidInputError("Maximum 50 IČOs per request.");
  }

  const companies: CompanyInput[] = [];
  const skipped: { ico: string; reason: string }[] = [];

  for (const ico of uniqueIcos) {
    try {
      const vr: VrOdpoved = await client.getVrRecord(ico);
      companies.push({ ico, vr });
    } catch (err) {
      if (err instanceof NotFoundError) {
        skipped.push({ ico, reason: "Not present in VR." });
        companies.push({ ico, vr: null });
      } else {
        throw err;
      }
    }
  }

  const graph = buildCrossCompanyGraph(companies, {
    includeHistorical: args.includeHistorical ?? false,
  });

  return {
    zpracovanoIco: uniqueIcos.length,
    includeHistorical: args.includeHistorical ?? false,
    companies: graph.companies,
    totalActivePersons: graph.totalActivePersons,
    sharedCount: graph.sharedPersons.length,
    sharedPersons: graph.sharedPersons.map((p) => ({
      jmeno: p.jmeno,
      datumNarozeni: p.datumNarozeni,
      isLegalEntity: p.personKey.startsWith("LEGAL|"),
      memberships: p.memberships,
    })),
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(args.emitMermaid !== false ? { mermaid: graph.mermaid } : {}),
    _attribution: ARES_ATTRIBUTION,
  };
}

// ─── Full Due Diligence ───────────────────────────────────────────────────────
type RiskLevel = "green" | "yellow" | "red";
interface RiskFinding {
  level: RiskLevel;
  message: string;
}
function tally(findings: RiskFinding[]): RiskLevel {
  if (findings.some((f) => f.level === "red")) return "red";
  if (findings.some((f) => f.level === "yellow")) return "yellow";
  return "green";
}

export async function fullDueDiligenceService(client: AresClient, icoInput: string) {
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });

  const [subjectRes, vrRes, rzpRes] = await Promise.allSettled([
    client.getEconomicSubject(normalized),
    client.getVrRecord(normalized),
    client.getRzpRecord(normalized),
  ]);

  if (subjectRes.status === "rejected") throw subjectRes.reason;
  const subject: EkonomickySubjekt = subjectRes.value;
  const vr: VrOdpoved | null = vrRes.status === "fulfilled" ? vrRes.value : null;
  const rzp: RzpZaznam | null = rzpRes.status === "fulfilled" ? rzpRes.value : null;

  const reg = subject.seznamRegistraci ?? {};
  const ir = statusOf(reg.stavZdrojeIr);
  const ceu = statusOf(reg.stavZdrojeCeu);
  const isInsolvent = ir === "ACTIVE" || ceu === "ACTIVE";
  const hadInsolvencyHistory = ir === "ENDED" || ceu === "ENDED";

  const members = flattenMembers(vr, { activeOnly: true });
  const statutariCount = members.length;
  const allLicenses = rzp?.zivnostenskeOpravneni ?? [];
  const activeLicenses = allLicenses.filter((l) => !l.datumZaniku);
  const dphActive = isActiveRegistration(reg.stavZdrojeDph);
  const dic = subject.dic ?? null;
  const czNace =
    (subject as { czNace2008?: string[] }).czNace2008 ?? subject.czNace ?? [];

  const findings: RiskFinding[] = [];
  if (isInsolvent) findings.push({ level: "red", message: "Aktivní insolvenční řízení nebo úpadek." });
  if (subject.datumZaniku) {
    findings.push({ level: "red", message: `Subjekt zanikl ${subject.datumZaniku}.` });
  }
  if (statutariCount === 0 && !subject.datumZaniku) {
    findings.push({
      level: "yellow",
      message: "Žádný aktivní statutární orgán ve VR — před podpisem ověř.",
    });
  }
  if (hadInsolvencyHistory && !isInsolvent) {
    findings.push({ level: "yellow", message: "V minulosti probíhalo insolvenční řízení." });
  }
  if (!dphActive && dic) {
    findings.push({
      level: "yellow",
      message: "DIČ existuje, ale registrace k DPH není aktivní.",
    });
  }
  if (rzp && allLicenses.length > 0 && activeLicenses.length === 0) {
    findings.push({ level: "yellow", message: "Všechna živnostenská oprávnění ukončena." });
  }
  if (findings.length === 0) {
    findings.push({ level: "green", message: "Žádné varovné signály v ARES." });
  }

  const riskLevel = tally(findings);
  const obchodniJmeno = subject.obchodniJmeno ?? currentObchodniJmeno(pickPrimaryZaznam(vr));

  return {
    ico: normalized,
    obchodniJmeno,
    risk: { level: riskLevel, findings },
    identification: {
      pravniForma: subject.pravniForma,
      datumVzniku: subject.datumVzniku,
      datumZaniku: subject.datumZaniku ?? null,
      sidlo: subject.sidlo,
      sidloText: subject.sidlo?.textovaAdresa,
      czNace,
    },
    vat: {
      platceDph: dphActive,
      dic,
      icDph: dphActive ? dic : null,
      stavZdrojeDph: reg.stavZdrojeDph ?? null,
    },
    statutary: {
      aktivniCount: statutariCount,
      clenove: members.map((m) => ({
        organ: m.organName,
        funkce: m.funkce,
        jmeno: m.fyzickaOsoba ? memberDisplayName(m) : m.pravnickaOsoba?.obchodniJmeno,
        datumNarozeni: m.fyzickaOsoba?.datumNarozeni,
        datumZapisu: m.datumZapisu,
      })),
    },
    trade_licenses: {
      total: allLicenses.length,
      aktivni: activeLicenses.length,
      predmety: activeLicenses.map((l) => l.predmetPodnikani).filter(Boolean),
    },
    insolvenci: {
      isInsolvent,
      hadHistory: hadInsolvencyHistory,
      insolvencniRejstrik: ir,
      centralniEvidenceUpadcu: ceu,
    },
    _attribution: ARES_ATTRIBUTION,
  };
}

// Expose helpers for tests / other consumers
export { isActiveRegistration, statusOf, tally };
export type { RiskFinding, RiskLevel };
// Re-export deprecated wrapper for completeness if some caller needs the dic helper
export { normalizeDic };
