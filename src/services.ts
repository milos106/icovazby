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

// ─── Trade licenses (RŽP) ─────────────────────────────────────────────────────
function normalizeObory(value: unknown): string[] {
  if (!value || !Array.isArray(value)) return [];
  return value
    .map((v) => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && "nazev" in v) {
        const nazev = (v as { nazev?: string }).nazev;
        return typeof nazev === "string" ? nazev : undefined;
      }
      return undefined;
    })
    .filter((v): v is string => typeof v === "string");
}

export async function getTradeLicensesService(client: AresClient, icoInput: string) {
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });
  const rzp = await client.getRzpRecord(normalized);
  const opravneni = (rzp.zivnostenskeOpravneni ?? []).map((z) => ({
    predmetPodnikani: z.predmetPodnikani,
    druh: z.druh,
    datumVzniku: z.datumVzniku,
    datumZaniku: z.datumZaniku ?? null,
    stav: z.stav,
    oboryCinnosti: normalizeObory(z.oboryCinnosti),
  }));
  const active = opravneni.filter((o) => !o.datumZaniku);
  return {
    ico: normalized,
    pocetCelkem: opravneni.length,
    pocetAktivnich: active.length,
    zivnostenskaOpravneni: opravneni,
    _attribution: ARES_ATTRIBUTION,
  };
}

// ─── RES classification ───────────────────────────────────────────────────────
const HEADCOUNT_BRACKET: Record<string, string> = {
  "100": "Nezjištěno",
  "110": "0 zaměstnanců",
  "120": "1–5 zaměstnanců",
  "130": "6–9 zaměstnanců",
  "140": "10–19 zaměstnanců",
  "210": "20–24 zaměstnanců",
  "220": "25–49 zaměstnanců",
  "310": "50–99 zaměstnanců",
  "320": "100–199 zaměstnanců",
  "330": "200–249 zaměstnanců",
  "340": "250–499 zaměstnanců",
  "410": "200–249 zaměstnanců (legacy)",
  "420": "250–499 zaměstnanců (legacy)",
  "510": "500–999 zaměstnanců",
  "520": "1 000–1 499 zaměstnanců",
  "530": "1 500–1 999 zaměstnanců",
  "610": "2 000–2 499 zaměstnanců",
  "620": "2 500–2 999 zaměstnanců",
  "630": "3 000–3 999 zaměstnanců",
  "640": "4 000–4 999 zaměstnanců",
  "710": "5 000–9 999 zaměstnanců",
  "720": "10 000+ zaměstnanců",
  "999": "Nezjištěno",
};

function smeClass(code: string | undefined | null): "micro" | "small" | "medium" | "large" | "unknown" {
  if (!code) return "unknown";
  if (["110", "120", "130"].includes(code)) return "micro";
  if (["140", "210", "220"].includes(code)) return "small";
  if (["310", "320", "330", "410"].includes(code)) return "medium";
  if (code === "340" || (/^[4-7]/.test(code) && code !== "410")) return "large";
  return "unknown";
}

const SECTOR_GROUP: Record<string, string> = {
  "11001": "Veřejné nefinanční korporace",
  "11002": "Soukromé nefinanční korporace",
  "11003": "Nefinanční korporace pod zahraniční kontrolou",
  "12101": "Centrální banka",
  "12201": "Depozitní instituce",
  "13": "Vládní instituce",
  "14": "Domácnosti",
  "15": "Neziskové instituce",
};

export async function getResClassificationService(client: AresClient, icoInput: string) {
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });
  const res = await client.getResRecord(normalized);
  const primary =
    res.zaznamy?.find((z) => z.primarniZaznam) ?? res.zaznamy?.[0] ?? null;
  if (!primary) {
    throw new InvalidInputError(`Žádný RES záznam pro IČO ${normalized}.`);
  }
  const bracketCode = primary.statistickeUdaje?.kategoriePoctuPracovniku ?? null;
  const sectorCode = primary.statistickeUdaje?.institucionalniSektor2010 ?? null;
  return {
    ico: normalized,
    obchodniJmeno: primary.obchodniJmeno,
    pravniForma: primary.pravniForma,
    financniUrad: primary.financniUrad,
    okresNutsLau: primary.okresNutsLau ?? null,
    sidlo: primary.sidlo?.textovaAdresa,
    czNacePrevazujici: primary.czNacePrevazujici2008 ?? primary.czNacePrevazujici ?? null,
    czNace: primary.czNace2008 ?? primary.czNace ?? [],
    kategoriePoctuPracovniku: {
      code: bracketCode,
      label: bracketCode ? (HEADCOUNT_BRACKET[bracketCode] ?? "Neznámý kód") : null,
      smeClass: smeClass(bracketCode),
    },
    institucionalniSektor2010: {
      code: sectorCode,
      label: sectorCode
        ? (SECTOR_GROUP[sectorCode] ?? SECTOR_GROUP[sectorCode.slice(0, 2)] ?? "Neznámý kód")
        : null,
    },
    datumVzniku: primary.datumVzniku,
    datumAktualizace: primary.datumAktualizace,
    _attribution: ARES_ATTRIBUTION,
  };
}

// ─── Export for invoicing ─────────────────────────────────────────────────────
type InvoiceTarget = "fakturoid" | "idoklad" | "pohoda";

function streetLine(a: EkonomickySubjekt["sidlo"]): string | undefined {
  if (!a) return undefined;
  const street = a.nazevUlice ?? "";
  const domovni = a.cisloDomovni;
  const orient = a.cisloOrientacni;
  const orientPismeno = a.cisloOrientacniPismeno ?? "";
  if (!street && !domovni) return a.textovaAdresa;
  const num =
    domovni && orient
      ? `${domovni}/${orient}${orientPismeno}`
      : (domovni ?? orient ?? "").toString();
  return [street, num].filter(Boolean).join(" ").trim() || undefined;
}

export async function exportForInvoicingService(
  client: AresClient,
  icoInput: string,
  target: InvoiceTarget,
) {
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });
  const subject = await client.getEconomicSubject(normalized);
  const reg = subject.seznamRegistraci ?? {};
  const dphActive = isActiveRegistration(reg.stavZdrojeDph);
  const sidlo = subject.sidlo;
  const common = {
    ico: normalized,
    obchodniJmeno: subject.obchodniJmeno ?? "",
    dic: subject.dic ?? null,
    platceDph: dphActive,
    ulice: streetLine(sidlo),
    obec: sidlo?.nazevObce,
    psc: sidlo?.psc !== undefined ? String(sidlo.psc) : undefined,
    zeme: (sidlo?.nazevStatu ?? sidlo?.kodStatu) as string | undefined,
  };

  let payload: Record<string, unknown>;
  let endpointHint: string;
  let format: "json" | "xml-hint";
  switch (target) {
    case "fakturoid":
      payload = {
        custom_id: common.ico,
        name: common.obchodniJmeno,
        registration_no: common.ico,
        vat_no: common.dic ?? undefined,
        type: "supplier_customer",
        enabled_reminders: true,
        street: common.ulice,
        city: common.obec,
        zip: common.psc,
        country: common.zeme === "Česká republika" ? "CZ" : common.zeme,
      };
      endpointHint = "POST https://app.fakturoid.cz/api/v3/{slug}/subjects.json";
      format = "json";
      break;
    case "idoklad":
      payload = {
        CompanyName: common.obchodniJmeno,
        IdentificationNumber: common.ico,
        VatIdentificationNumber: common.dic ?? undefined,
        Street: common.ulice,
        City: common.obec,
        PostalCode: common.psc,
        Country: common.zeme,
        IsRegisteredForVatOss: false,
      };
      endpointHint = "POST https://api.idoklad.cz/v3/Contacts";
      format = "json";
      break;
    case "pohoda":
      payload = {
        "adb:identity": {
          "adb:address": {
            "adb:company": common.obchodniJmeno,
            "adb:ico": common.ico,
            "adb:dic": common.dic ?? undefined,
            "adb:street": common.ulice,
            "adb:city": common.obec,
            "adb:zip": common.psc,
            "adb:country": common.zeme,
          },
        },
      };
      endpointHint = "Wrap in <dat:dataPack> for Pohoda mServer / XML import";
      format = "xml-hint";
      break;
  }
  return {
    ico: normalized,
    obchodniJmeno: common.obchodniJmeno,
    target,
    format,
    payload,
    endpointHint,
    _attribution: ARES_ATTRIBUTION,
  };
}

// Expose helpers for tests / other consumers
export { isActiveRegistration, statusOf, tally };
export type { InvoiceTarget, RiskFinding, RiskLevel };
// Re-export deprecated wrapper for completeness if some caller needs the dic helper
export { normalizeDic };
