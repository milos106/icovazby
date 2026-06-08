// SPDX-License-Identifier: AGPL-3.0-or-later
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
    activePersons: graph.activePersons.map((p) => ({
      jmeno: p.jmeno,
      datumNarozeni: p.datumNarozeni,
      isLegalEntity: p.personKey.startsWith("LEGAL|"),
      memberships: p.memberships,
    })),
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
  // OSVČ (107) a zahraniční fyzická osoba (108) statutární orgán ve VR mít
  // ze zákona nemůžou — nehlásit jako varování (false-positive žluté).
  const pf = String(subject.pravniForma ?? "");
  const isFyzickaOsoba = pf === "107" || pf === "108";
  if (statutariCount === 0 && !subject.datumZaniku && !isFyzickaOsoba) {
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

  // EU sanctions screening — statutární orgány + obchodní jméno proti konsolidovanému
  // sankčnímu listu. Resilientně: pokud EU feed selže, DD pokračuje bez tohoto signálu.
  try {
    const names: string[] = [];
    if (subject.obchodniJmeno) names.push(subject.obchodniJmeno);
    for (const m of members) {
      const name = memberDisplayName(m);
      if (name) names.push(name);
    }
    if (names.length > 0) {
      const screen = await screenEuSanctions(names);
      if (screen.hits.length > 0) {
        const persons = screen.hits.map((h) => h.query).filter((v, i, a) => a.indexOf(v) === i);
        findings.push({
          level: "red",
          message: `EU sankce: ${persons.length} osoba/firma v konsolidovaném sankčním listu (${screen.hits.map((h) => h.entity.programmes.join("+")).join(", ")}).`,
        });
      }
    }
  } catch {
    // EU feed nedostupný — nezahazujeme DD, jen vynecháme signál.
  }

  if (findings.length === 0) {
    findings.push({ level: "green", message: "Žádné varovné signály v ARES." });
  }

  const riskLevel = tally(findings);
  const obchodniJmeno = subject.obchodniJmeno ?? currentObchodniJmeno(pickPrimaryZaznam(vr));

  // Subjekt inventář: zaznamenat firmu, kterou uživatel viděl. Slouží
  // pro reverse holding discovery (najdi firmy kde parent je akcionář).
  upsertSubject(normalized, obchodniJmeno ?? null);

  // Hook do lokálního indexu osoba→firmy: vložíme všechny aktivní členy
  // statutárního orgánu ze ARES VR. Postupně se index plní s každým DD.
  for (const m of members) {
    const fo = m.fyzickaOsoba;
    if (!fo?.datumNarozeni || !fo.jmeno || !fo.prijmeni) continue;
    upsertMembership({
      jmeno: fo.jmeno,
      prijmeni: fo.prijmeni,
      titulPred: fo.titulPredJmenem ?? null,
      displayName: memberDisplayName(m),
      datumNarozeni: fo.datumNarozeni,
      ico: normalized,
      obchodniJmeno: obchodniJmeno ?? null,
      funkce: m.funkce ?? null,
      organ: m.organName ?? null,
      datumZapisu: m.datumZapisu ?? null,
      datumVymazu: null,
      source: "ARES_VR",
    });
  }

  // OSVČ self-membership: pokud je subjekt fyzická osoba podnikající,
  // RŽP záznam obsahuje osobaPodnikatel s datumNarozeni. Vložíme to
  // do indexu jako self-vazbu na stejné IČO — tím se pak při lookup
  // osoby (např. „Petr Dubický 1962-11-08") objeví její OSVČ záznam
  // vedle vazeb na firmy, kde sedí jako jednatel.
  const osvc = rzp?.zaznamy?.[0]?.osobaPodnikatel;
  if (osvc?.jmeno && osvc.prijmeni && osvc.datumNarozeni) {
    upsertMembership({
      jmeno: osvc.jmeno,
      prijmeni: osvc.prijmeni,
      titulPred: null,
      displayName: `${osvc.jmeno} ${osvc.prijmeni}`,
      datumNarozeni: osvc.datumNarozeni,
      ico: normalized,
      obchodniJmeno: obchodniJmeno ?? null,
      funkce: "Podnikatel (OSVČ)",
      organ: "RŽP",
      datumZapisu: osvc.platnostOd ?? subject.datumVzniku ?? null,
      datumVymazu: subject.datumZaniku ?? null,
      source: "ARES_VR",
    });
  }

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

// ─── ČNB denní kurzy ──────────────────────────────────────────────────────────
import { CNB_ATTRIBUTION, fetchDailyRates, rateFor } from "./cnb/client.js";

/** Vybrané "core" měny pro UI widget. EUR, USD, GBP, CHF, JPY, PLN. */
const CORE_CURRENCIES = ["EUR", "USD", "GBP", "CHF", "PLN", "JPY"];

export async function getCnbRatesService() {
  const data = await fetchDailyRates();
  const core: Record<string, { rate: number; country: string; currency: string }> = {};
  for (const code of CORE_CURRENCIES) {
    const r = data.rates.find((x) => x.currencyCode === code);
    if (r) {
      core[code] = {
        rate: r.rate / r.amount,
        country: r.country,
        currency: r.currency,
      };
    }
  }
  const validFor = data.rates[0]?.validFor ?? null;
  return {
    validFor,
    core,
    all: data.rates.map((r) => ({
      code: r.currencyCode,
      country: r.country,
      currency: r.currency,
      amount: r.amount,
      rate: r.rate,
      ratePerUnit: r.rate / r.amount,
    })),
    _attribution: CNB_ATTRIBUTION,
  };
}

/** Helper, který používáme v jiných službách k převodu z Kč na cizí měnu. */
export async function tryConvert(czkAmount: number, code: string): Promise<number | null> {
  try {
    const data = await fetchDailyRates();
    const r = rateFor(data, code);
    if (!r || r === 0) return null;
    return czkAmount / r;
  } catch {
    return null;
  }
}

// ─── Person vazby (HS osoby + ARES IČO resolve) ───────────────────────────────
export { getPersonVazbyService } from "./persons/service.js";

// ─── Holding discovery (BFS po jednatelích + akcionářích) ─────────────────────
export { discoverHolding } from "./holding/discover.js";

// ─── Local persistent index osoba → firmy + subjekt inventář ──────────────────
import { upsertMembership, upsertSubject } from "./persons_index/store.js";

// ─── Veřejný rejstřík (OR) přes verejnerejstriky.msp.gov.cz ───────────────────
import { VR_ATTRIBUTION, fetchVrDetailByIco } from "./justice_vr/client.js";

function vrAddressToText(a?: {
  ulice?: string;
  cisloPop?: string;
  cisloOr?: string;
  obec?: string;
  castObce?: string;
  psc?: string;
  mop?: string;
}): string | null {
  if (!a) return null;
  let cislo = "";
  if (a.cisloPop && a.cisloOr) cislo = `${a.cisloPop}/${a.cisloOr}`;
  else cislo = a.cisloPop || a.cisloOr || "";
  const street = [a.ulice, cislo].filter(Boolean).join(" ");
  const city = a.mop || a.obec || "";
  const cityWithPart = a.castObce && city && a.castObce !== city ? `${city}-${a.castObce}` : city;
  const where = [a.psc, cityWithPart].filter(Boolean).join(" ");
  return [street, where].filter(Boolean).join(", ") || null;
}

interface VrMember {
  jmeno: string;
  prijmeni: string;
  titulPred: string | null;
  datumNarozeni: string | null;
  funkce: string | null;
  vznikClenstvi: string | null;
  vznikFunkce: string | null;
  adresa: string | null;
  isLegalEntity: boolean;
  ico: string | null;
  fullName: string;
}

function normalizeMember(raw: {
  value?: {
    osoba?: {
      jmeno?: string;
      prijmeni?: string;
      titulPred?: string | null;
      datumNarozeni?: string;
      nazev?: string;
      ico?: string;
      adresa?: Parameters<typeof vrAddressToText>[0];
    };
    funkce?: { funkce?: string; vznikFunkce?: string };
    clenstvi?: { vznikClenstvi?: string };
  };
  hlavicka?: string;
}): VrMember | null {
  const o = raw.value?.osoba;
  if (!o) return null;
  const isLegal = Boolean(o.nazev && !o.jmeno);
  const jmeno = o.jmeno?.trim() ?? "";
  const prijmeni = o.prijmeni?.trim() ?? "";
  const fullName = isLegal
    ? (o.nazev ?? "")
    : [o.titulPred, jmeno, prijmeni].filter(Boolean).join(" ");
  return {
    jmeno,
    prijmeni,
    titulPred: o.titulPred ?? null,
    datumNarozeni: o.datumNarozeni ? o.datumNarozeni.slice(0, 10) : null,
    funkce: raw.value?.funkce?.funkce ?? raw.hlavicka ?? null,
    vznikClenstvi: raw.value?.clenstvi?.vznikClenstvi?.replace(/^PRESNY-/, "") ?? null,
    vznikFunkce: raw.value?.funkce?.vznikFunkce?.replace(/^PRESNY-/, "") ?? null,
    adresa: vrAddressToText(o.adresa),
    isLegalEntity: isLegal,
    ico: o.ico ?? null,
    fullName,
  };
}

export async function getVrDetailService(ico: string) {
  const v = validateIcoFn(ico);
  if (!v.valid) throw new InvalidInputError(v.reason ?? "Neplatné IČO.");
  const detail = await fetchVrDetailByIco(v.normalized);
  if (!detail) {
    return {
      ico: v.normalized,
      available: false,
      reason: "Subjekt nebyl v novém VR portálu nalezen (může to být v ověřovacím provozu mezera).",
      _attribution: VR_ATTRIBUTION,
    };
  }
  const stat = (detail.statutarniOrgan?.osoby ?? [])
    .map(normalizeMember)
    .filter((m): m is VrMember => m !== null);
  const dozorci = (detail.dozorciRada?.osoby ?? [])
    .map(normalizeMember)
    .filter((m): m is VrMember => m !== null);
  const akcionari = (detail.akcionar?.osoby ?? [])
    .map(normalizeMember)
    .filter((m): m is VrMember => m !== null);

  // Hook do lokálního indexu: OR má kompletnější data včetně dat zápisu
  // jednotlivých funkcí + dozorčí rady + akcionářů. Vkládáme všechny FO.
  const obchodniJmenoVr = detail.nazev?.value ?? null;

  // Subjekt inventář pro reverse holding discovery.
  upsertSubject(v.normalized, obchodniJmenoVr);
  const insertMember = (m: VrMember, source: "OR_VR" | "OR_DR" | "OR_AKC"): void => {
    if (m.isLegalEntity || !m.datumNarozeni || !m.jmeno || !m.prijmeni) return;
    upsertMembership({
      jmeno: m.jmeno,
      prijmeni: m.prijmeni,
      titulPred: m.titulPred,
      displayName: m.fullName,
      datumNarozeni: m.datumNarozeni,
      ico: v.normalized,
      obchodniJmeno: obchodniJmenoVr,
      funkce: m.funkce,
      organ: source === "OR_DR" ? "Dozorčí rada" : source === "OR_AKC" ? "Akcionář/společník" : null,
      datumZapisu: m.vznikClenstvi ?? m.vznikFunkce ?? null,
      datumVymazu: null,
      source,
    });
  };
  for (const m of stat) insertMember(m, "OR_VR");
  for (const m of dozorci) insertMember(m, "OR_DR");
  for (const m of akcionari) insertMember(m, "OR_AKC");

  const akcie = (detail.akcie ?? []).map((a) => ({
    typ: a.value?.typ ?? null,
    podoba: a.value?.podoba ?? null,
    pocet: a.value?.pocet ?? null,
    hodnotaCZK: a.value?.hodnota?.textValue?.replace(";00", "") ?? null,
    text: a.value?.text ?? null,
  }));

  const ostatniSkutecnosti = (detail.ostatniSkutecnosti?.skutecnosti ?? [])
    .filter((s) => !s.skryty)
    .map((s) => ({
      validFrom: s.validFrom ?? null,
      validTo: s.validTo ?? null,
      isActive: !s.validTo,
      value: s.value,
    }));

  const predmetCinnosti = (detail.predmetCinnosti ?? [])
    .filter((p) => !p.skryty && !p.validTo)
    .map((p) => p.value);
  const predmetPodnikani = (detail.predmetPodnikani ?? [])
    .filter((p) => !p.skryty && !p.validTo)
    .map((p) => p.value);
  const predmetPodnikaniHistoric = (detail.predmetPodnikani ?? [])
    .filter((p) => !p.skryty && p.validTo)
    .map((p) => ({ value: p.value, validFrom: p.validFrom ?? null, validTo: p.validTo ?? null }));

  // Základní kapitál může být buď prostá hodnota nebo objekt {vklad, splaceni}.
  // Pro UI sestavíme čitelný string a zároveň necháme strukturu pro tooltip.
  const kapitalRaw = detail.zakladniKapital?.value as
    | string
    | { vklad?: { typ?: string; textValue?: string }; splaceni?: { typ?: string; textValue?: string } }
    | undefined;
  let zakladniKapital: string | null = null;
  if (typeof kapitalRaw === "string") {
    zakladniKapital = kapitalRaw;
  } else if (kapitalRaw && typeof kapitalRaw === "object") {
    const v = kapitalRaw.vklad?.textValue?.replace(";00", "");
    const typ = kapitalRaw.vklad?.typ === "KORUNY" ? "Kč" : kapitalRaw.vklad?.typ ?? "";
    const sp = kapitalRaw.splaceni?.textValue;
    const formattedNum = v ? Number(v).toLocaleString("cs-CZ") : null;
    const main = formattedNum && typ ? `${formattedNum} ${typ}` : v ?? null;
    zakladniKapital = main && sp ? `${main} (splaceno ${sp} %)` : main;
  }

  return {
    ico: v.normalized,
    available: true,
    subjektId: detail.subjektId ?? null,
    datumZapisu: detail.datumZapisu ?? null,
    datumVygenerovani: detail.datumVygenerovani ?? null,
    nazev: detail.nazev?.value ?? null,
    pravniForma: detail.pravniForma?.value ?? null,
    sidlo: typeof detail.sidlo?.value === "string"
      ? detail.sidlo.value
      : vrAddressToText(detail.sidlo?.value as Parameters<typeof vrAddressToText>[0] | undefined),
    spisovaZnacka: detail.spisovaZnacka?.value ?? null,
    zakladniKapital,
    predmetCinnosti,
    predmetPodnikani,
    predmetPodnikaniHistoric,
    statutarniOrgan: {
      hlavicka: detail.statutarniOrgan?.hlavicka ?? null,
      pocet: stat.length,
      clenove: stat,
    },
    dozorciRada: {
      pocet: dozorci.length,
      clenove: dozorci,
    },
    akcionar: {
      pocet: akcionari.length,
      clenove: akcionari,
    },
    akcie,
    ostatniSkutecnosti,
    portalUrl: detail.subjektId
      ? `https://verejnerejstriky.msp.gov.cz/vypis/${detail.subjektId}`
      : null,
    _attribution: VR_ATTRIBUTION,
  };
}

// ─── EU consolidated financial sanctions list ─────────────────────────────────
import { EU_SANCTIONS_ATTRIBUTION, screenEuSanctions } from "./eu_sanctions/client.js";

export async function getEuSanctionsScreenService(names: string[]) {
  const r = await screenEuSanctions(names);
  return {
    queries: r.queries,
    hits: r.hits.map((h) => ({
      query: h.query,
      matchedAs: h.matchedAs,
      euReferenceNumber: h.entity.euReferenceNumber,
      subjectType: h.entity.subjectType,
      programmes: h.entity.programmes,
      birthYears: h.entity.birthYears,
      citizenships: h.entity.citizenships,
      publicationUrls: h.entity.publicationUrls,
      remark: h.entity.remark,
      logicalId: h.entity.logicalId,
    })),
    snapshot: {
      totalEntities: r.totalEntities,
      generationDate: r.generationDate,
      loadedAt: r.loadedAt,
    },
    _attribution: EU_SANCTIONS_ATTRIBUTION,
  };
}

// ─── JERRS (regulované subjekty ČNB, open-data) ───────────────────────────────
import { JERRS_ATTRIBUTION, lookupJerrsByIco } from "./jerrs/client.js";

export async function getJerrsService(ico: string) {
  const v = validateIcoFn(ico);
  if (!v.valid) throw new InvalidInputError(v.reason ?? "Neplatné IČO.");
  const r = await lookupJerrsByIco(v.normalized);
  return {
    ico: r.ico,
    isRegulated: r.isRegulated,
    memberships: r.memberships.map((m) => ({
      categoryCode: m.category.code,
      categoryLabel: m.category.label,
      categoryDescription: m.category.description,
      name: m.name,
      datumVzniku: m.datumVzniku,
      address: m.address,
      obec: m.obec,
      psc: m.psc,
      zeme: m.zeme,
    })),
    snapshot: {
      loadedAt: r.loadedAt,
      totalSubjects: r.totalSubjects,
    },
    _attribution: JERRS_ATTRIBUTION,
  };
}

// ─── ADIS DPH (nespolehlivý plátce + bankovní účty) ───────────────────────────
import { fetchPlatceStatus } from "./adis/client.js";
import {
  HlidacStatuMissingTokenError,
  fetchDotaceByIco,
  fetchInsolvenceAsDluznik,
  fetchSmlouvyByIco,
  fetchUboByIco,
  hasHlidacToken,
  type RawDotace,
  type RawInsolvenceRecord,
  type RawSmlouva,
  type RawSmlouvaParty,
  type RawUboRecord,
} from "./hlidacstatu/client.js";

export const HLIDAC_ATTRIBUTION = {
  source: "Hlídač státu, z.ú.",
  url: "https://www.hlidacstatu.cz",
  license: "CC BY 3.0 CZ",
  licenseUrl: "https://creativecommons.org/licenses/by/3.0/cz/",
  obligation:
    "Při dalším šíření je povinné uvést tento odkaz na hlidacstatu.cz a zachovat licenci CC BY 3.0 CZ.",
};

/**
 * Roztřídí UBO záznamy na aktivní (datum_vymaz == null) a historické a
 * z plochých atributů sestaví human-readable shape.
 */
function shapeUboRecord(r: RawUboRecord) {
  const name = [r.osoba_titul_pred, r.osoba_jmeno, r.osoba_prijmeni, r.osoba_titul_za]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");
  const birth =
    r.osoba_datum_narozeni && !r.osoba_datum_narozeni.startsWith("0001-")
      ? r.osoba_datum_narozeni.slice(0, 10)
      : null;
  return {
    jmeno: name || null,
    datumNarozeni: birth,
    udajTyp: r.udaj_typ_nazev ?? r.udaj_typ ?? null,
    postaveni: r.postaveni ?? null,
    podilProspech:
      r.podil_na_prospechu_hodnota != null
        ? `${r.podil_na_prospechu_hodnota}${r.podil_na_prospechu_typ === "PROCENTA" ? " %" : ""}`
        : null,
    podilHlasovani:
      r.podil_na_hlasovani_hodnota != null
        ? `${r.podil_na_hlasovani_hodnota}${r.podil_na_hlasovani_typ === "PROCENTA" ? " %" : ""}`
        : null,
    datumZapis: r.datum_zapis ? r.datum_zapis.slice(0, 10) : null,
    datumVymaz: r.datum_vymaz ? r.datum_vymaz.slice(0, 10) : null,
    adresa: r.adresa_text ?? null,
    slovniVyjadreni: r.slovni_vyjadreni ?? null,
  };
}

// ─── ISIR insolvenční detail (přes Hlídač státu) ──────────────────────────────
// Status hodnoty viděné v API (KSSEMOS a podobné soudy):
//   NEVYRIZENA, KONKURS, REORGANIZACE, ODDLUZENI = aktivní (probíhá)
//   VYRIZENA, PRAVOMOCNA, ZRUSENA, ZRUSEN_KONKURS, ODSKRTNUTA, ZAMITNUTA = uzavřeno
const ACTIVE_INSOLVENCE_STATES = new Set([
  "NEVYRIZENA",
  "KONKURS",
  "REORGANIZACE",
  "ODDLUZENI",
  "OPRAVNE_USNESENI",
]);

function isActiveInsolvence(stav: string | null | undefined): boolean {
  if (!stav) return false;
  return ACTIVE_INSOLVENCE_STATES.has(stav.toUpperCase());
}

function shapeInsolvenceRecord(r: RawInsolvenceRecord) {
  const sz = r.spisovaZnacka ?? null;
  const isirUrl = sz
    ? `https://isir.justice.cz/isir/ueas/ueas_detail.do?spisova_znacka=${encodeURIComponent(sz)}`
    : null;
  return {
    spisovaZnacka: sz,
    stav: r.stav ?? null,
    soud: r.soud ?? null,
    datumZalozeni: r.datumZalozeni ? r.datumZalozeni.slice(0, 10) : null,
    posledniZmena: r.posledniZmena ? r.posledniZmena.slice(0, 10) : null,
    isActive: isActiveInsolvence(r.stav),
    pocetVeritele: r.veritele?.length ?? 0,
    pocetDluznici: r.dluznici?.length ?? 0,
    spravci:
      r.spravci?.map((s) => ({
        jmeno: s.plneJmeno ?? null,
        ico: s.ico ?? null,
        mesto: s.mesto ?? null,
      })) ?? [],
    isirUrl,
    hlidacUrl: sz
      ? `https://www.hlidacstatu.cz/insolvencni-rejstrik/${encodeURIComponent(sz)}`
      : null,
  };
}

export async function getInsolvenceDetailService(icoInput: string) {
  if (!hasHlidacToken()) {
    return {
      ico: icoInput,
      available: false,
      reason: "HLIDAC_API_TOKEN není nastaven.",
      _attribution: HLIDAC_ATTRIBUTION,
    };
  }
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });
  try {
    const resp = await fetchInsolvenceAsDluznik(normalized);
    const top = resp.results.map(shapeInsolvenceRecord);
    const active = top.filter((r) => r.isActive);
    const recentClosed = top.filter((r) => !r.isActive).slice(0, 5);
    const mostRecent = top[0] ?? null;
    return {
      ico: normalized,
      available: true,
      totalAsDluznik: resp.total,
      activeCount: active.length,
      mostRecentRecord: mostRecent,
      activeRecords: active.slice(0, 5),
      recentClosedRecords: recentClosed,
      _attribution: HLIDAC_ATTRIBUTION,
      _legalNote:
        "ISIR (Insolvenční rejstřík) vede Ministerstvo spravedlnosti dle § 419 zákona č. 182/2006 Sb. o úpadku. Tento výpis ukazuje pouze řízení, kde firma figuruje jako DLUŽNÍK; být věřitelem v cizí insolvenci ≠ vlastní problém.",
    };
  } catch (err) {
    if (err instanceof HlidacStatuMissingTokenError) {
      return {
        ico: normalized,
        available: false,
        reason: err.message,
        _attribution: HLIDAC_ATTRIBUTION,
      };
    }
    throw err;
  }
}

// ─── Dotace (přes Hlídač státu) ──────────────────────────────────────────────
function dotacePaidAmount(d: RawDotace): number | null {
  if (typeof d.payedAmount === "number" && d.payedAmount > 0) return d.payedAmount;
  if (typeof d.subsidyAmount === "number" && d.subsidyAmount > 0) return d.subsidyAmount;
  if (typeof d.assumedAmount === "number" && d.assumedAmount > 0) return d.assumedAmount;
  return null;
}

export async function getDotaceService(icoInput: string) {
  if (!hasHlidacToken()) {
    return {
      ico: icoInput,
      available: false,
      reason: "HLIDAC_API_TOKEN není nastaven.",
      _attribution: HLIDAC_ATTRIBUTION,
    };
  }
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });
  try {
    const resp = await fetchDotaceByIco(normalized);
    const top = resp.results;
    let topPayed = 0;
    let topPricedCount = 0;
    let topReturned = 0;
    const providers = new Map<
      string,
      { name: string; ico?: string; sum: number; count: number }
    >();
    let minYear: number | null = null;
    let maxYear: number | null = null;

    for (const d of top) {
      const paid = dotacePaidAmount(d);
      if (paid !== null) {
        topPayed += paid;
        topPricedCount += 1;
      }
      if (typeof d.returnedAmount === "number" && d.returnedAmount > 0) {
        topReturned += d.returnedAmount;
      }
      if (typeof d.approvedYear === "number") {
        if (minYear === null || d.approvedYear < minYear) minYear = d.approvedYear;
        if (maxYear === null || d.approvedYear > maxYear) maxYear = d.approvedYear;
      }
      const provName = (d.subsidyProvider ?? "(neznámý poskytovatel)").trim() || "(neznámý)";
      const provIco = d.subsidyProviderIco ?? undefined;
      const k = `${provIco ?? provName}`;
      const existing = providers.get(k) ?? {
        name: provName,
        ico: provIco,
        sum: 0,
        count: 0,
      };
      existing.sum += paid ?? 0;
      existing.count += 1;
      providers.set(k, existing);
    }

    const topProviders = [...providers.values()]
      .sort((a, b) => b.sum - a.sum || b.count - a.count)
      .slice(0, 5);

    const topDotace = top.slice(0, 10).map((d) => ({
      id: d.id,
      projectName: d.projectName ?? d.displayProject ?? d.projectCode ?? null,
      projectCode: d.projectCode ?? null,
      programName: d.programName ?? null,
      payedAmount: dotacePaidAmount(d),
      returnedAmount: typeof d.returnedAmount === "number" ? d.returnedAmount : null,
      approvedYear: d.approvedYear ?? null,
      subsidyProvider: d.subsidyProvider ?? null,
      subsidyProviderIco: d.subsidyProviderIco ?? null,
      primaryDataSource: d.primaryDataSource ?? null,
      odkaz: d.id ? `https://www.hlidacstatu.cz/dotace/${encodeURIComponent(d.id)}` : null,
    }));

    return {
      ico: normalized,
      available: true,
      totalDotaci: resp.total,
      shown: top.length,
      topPayedCZK: topPayed,
      topPricedCount,
      topReturnedCZK: topReturned,
      yearRange: minYear !== null && maxYear !== null ? { from: minYear, to: maxYear } : null,
      topProviders,
      topDotace,
      _attribution: HLIDAC_ATTRIBUTION,
      _legalNote:
        "Dotace agregované z CEDR (centrální evidence rozpočtových dotací), MMR, MPSV, MŠMT, Státní zemědělský intervenční fond, EU strukturální fondy. Uvedené částky jsou většinou skutečně vyplacené (payedAmount).",
    };
  } catch (err) {
    if (err instanceof HlidacStatuMissingTokenError) {
      return {
        ico: normalized,
        available: false,
        reason: err.message,
        _attribution: HLIDAC_ATTRIBUTION,
      };
    }
    throw err;
  }
}

// ─── Smlouvy ze Registru smluv (přes Hlídač státu) ───────────────────────────
function partyName(p: RawSmlouvaParty | null | undefined): string {
  if (!p) return "(neznámý)";
  return (p.nazev ?? p.jmeno ?? "").trim() || "(neznámý)";
}

function partyAsArray(p: RawSmlouva["prijemce"]): RawSmlouvaParty[] {
  if (!p) return [];
  return Array.isArray(p) ? p : [p];
}

function smlouvaPrice(s: RawSmlouva): number | null {
  if (typeof s.calculatedPriceWithVATinCZK === "number" && s.calculatedPriceWithVATinCZK > 0) {
    return s.calculatedPriceWithVATinCZK;
  }
  if (typeof s.hodnotaVcetneDph === "number" && s.hodnotaVcetneDph > 0) {
    return s.hodnotaVcetneDph;
  }
  if (typeof s.hodnotaBezDph === "number" && s.hodnotaBezDph > 0) {
    return s.hodnotaBezDph * 1.21;
  }
  return null;
}

export async function getSmlouvyService(icoInput: string) {
  if (!hasHlidacToken()) {
    return {
      ico: icoInput,
      available: false,
      reason: "HLIDAC_API_TOKEN není nastaven.",
      _attribution: HLIDAC_ATTRIBUTION,
    };
  }
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });
  try {
    const resp = await fetchSmlouvyByIco(normalized);

    // Sample-level aggregations on the top page (sorted by price desc).
    // Pro úplný součet by bylo třeba probrat všechny strany, ale top-25
    // typicky obsahuje 90 %+ hodnoty (Pareto). Pro accuracy v UI je
    // zřetelně vyznačeno "v top 25".
    const top = resp.results;
    let topSum = 0;
    let topPriced = 0;
    const counterpartyTotals = new Map<string, { name: string; ico?: string; sum: number; count: number }>();

    for (const s of top) {
      const price = smlouvaPrice(s);
      if (price !== null) {
        topSum += price;
        topPriced += 1;
      }
      // Jednou ze stran je tato firma (filter byl ico:NORMALIZED), protistrana = ta druhá.
      const parties: { p: RawSmlouvaParty; role: "platce" | "prijemce" }[] = [];
      if (s.platce) parties.push({ p: s.platce, role: "platce" });
      for (const p of partyAsArray(s.prijemce)) parties.push({ p, role: "prijemce" });
      for (const { p } of parties) {
        if (!p.ico || p.ico === normalized) continue;
        const key = p.ico;
        const existing = counterpartyTotals.get(key) ?? {
          name: partyName(p),
          ico: p.ico,
          sum: 0,
          count: 0,
        };
        existing.sum += price ?? 0;
        existing.count += 1;
        counterpartyTotals.set(key, existing);
      }
    }

    const topCounterparties = [...counterpartyTotals.values()]
      .sort((a, b) => b.sum - a.sum || b.count - a.count)
      .slice(0, 5);

    const recentContracts = top
      .slice(0, 10)
      .map((s) => {
        const price = smlouvaPrice(s);
        const platce = s.platce ? partyName(s.platce) : null;
        const platceIco = s.platce?.ico ?? null;
        const prijemci = partyAsArray(s.prijemce).map((p) => ({
          name: partyName(p),
          ico: p.ico ?? null,
        }));
        return {
          id: s.identifikator?.idSmlouvy ?? s.id,
          predmet: s.predmet ?? null,
          datumUzavreni: s.datumUzavreni ? s.datumUzavreni.slice(0, 10) : null,
          casZverejneni: s.casZverejneni ? s.casZverejneni.slice(0, 10) : null,
          price,
          priceFallbackReason: price === null ? (s.cenaNeuvedenaDuvod ?? "neuvedena") : null,
          platce,
          platceIco,
          prijemci,
          odkaz:
            s.identifikator?.idSmlouvy && s.identifikator?.idVerze
              ? `https://www.hlidacstatu.cz/Detail/${s.identifikator.idSmlouvy}`
              : (s.odkaz ?? null),
          vazbaNaPolitiky: Boolean(s.sVazbouNaPolitikyAktualni),
        };
      });

    return {
      ico: normalized,
      available: true,
      totalContracts: resp.total,
      shown: top.length,
      topSumCZK: topSum,
      topPricedCount: topPriced,
      topCounterparties,
      recentContracts,
      _attribution: HLIDAC_ATTRIBUTION,
      _legalNote:
        "Smlouvy zveřejněné v Registru smluv dle z. č. 340/2015 Sb. (povinné pro stát, kraje, obce a další veřejné instituce, hodnota nad 50 tis. Kč bez DPH).",
      _commercialNote:
        "Veřejné zakázky (výběrová řízení) jsou v Hlídači státu na komerční licenci. Smlouvy = uzavřené konečné dohody.",
    };
  } catch (err) {
    if (err instanceof HlidacStatuMissingTokenError) {
      return {
        ico: normalized,
        available: false,
        reason: err.message,
        _attribution: HLIDAC_ATTRIBUTION,
      };
    }
    throw err;
  }
}

export async function getUboService(icoInput: string) {
  if (!hasHlidacToken()) {
    return {
      ico: icoInput,
      available: false,
      reason: "HLIDAC_API_TOKEN není nastaven — UBO data nejsou dostupná.",
      _attribution: HLIDAC_ATTRIBUTION,
    };
  }
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });
  try {
    const resp = await fetchUboByIco(normalized);
    const result = resp.results[0];
    if (!result) {
      return {
        ico: normalized,
        available: true,
        nazev_subjektu: null,
        active: [],
        historical: [],
        message: "Žádný záznam v evidenci skutečných majitelů.",
        _attribution: HLIDAC_ATTRIBUTION,
      };
    }
    const shaped = result.skutecni_majitele.map(shapeUboRecord);
    const active = shaped.filter((s) => !s.datumVymaz);
    const historical = shaped.filter((s) => s.datumVymaz);
    return {
      ico: normalized,
      available: true,
      nazev_subjektu: result.nazev_subjektu ?? null,
      activeCount: active.length,
      historicalCount: historical.length,
      active,
      historical,
      _attribution: HLIDAC_ATTRIBUTION,
      _legalNote:
        "Evidence skutečných majitelů vedena dle zákona č. 37/2021 Sb. UBO = ten, kdo má fakticky nebo právně možnost vykonávat rozhodující vliv (přímý/nepřímý podíl > 25 %, hlasovací práva, jiná kontrola).",
    };
  } catch (err) {
    if (err instanceof HlidacStatuMissingTokenError) {
      return {
        ico: normalized,
        available: false,
        reason: err.message,
        _attribution: HLIDAC_ATTRIBUTION,
      };
    }
    throw err;
  }
}

export const ADIS_ATTRIBUTION = {
  source: "MFČR ADIS — registr plátců DPH",
  publisher: "Generální finanční ředitelství / Finanční správa ČR",
  legalBasis: "§ 96a zákona č. 235/2004 Sb., o DPH",
  url: "https://adisspr.mfcr.cz/",
};

export async function getAdisVatStatusService(icoInput: string) {
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });
  const r = await fetchPlatceStatus(normalized);
  if (!r.info) {
    return {
      dic: normalized,
      isVatPayer: false,
      isUnreliable: null,
      bankAccounts: [],
      message: r.statusText ?? "Subjekt nenalezen v registru DPH (pravděpodobně neplátce DPH).",
      _attribution: ADIS_ATTRIBUTION,
    };
  }
  return {
    dic: r.info.dic,
    isVatPayer: true,
    isUnreliable: r.info.nespolehlivyPlatce === "ANO",
    nespolehlivyPlatceRaw: r.info.nespolehlivyPlatce,
    cisloFu: r.info.cisloFu,
    odpovedGenerovana: r.odpovedGenerovana,
    bankAccounts: r.info.zverejneneUcty.map((u) => ({
      formatted: u.cisloUctuFormatted,
      type: u.type,
      datumZverejneni: u.datumZverejneni,
    })),
    _attribution: ADIS_ATTRIBUTION,
    _legalNote:
      "Pokud plátce přijme platbu na účet jiný než zveřejněný a hodnota plnění přesáhne 540 000 Kč, podle § 109a zákona o DPH ručí příjemce za DPH dodavatele.",
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
