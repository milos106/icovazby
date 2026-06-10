// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * AI auto-summary firmy přes Claude Haiku 4.5 (Anthropic).
 *
 * Workflow:
 *   1. Sebraj structured data o firmě ze všech našich zdrojů (ARES DD,
 *      Hlídač státu, ÚPV, holding/vazby)
 *   2. Zaserializuj do compact JSON (cca 2–4 kB)
 *   3. Pošli Claude Haiku s pevně definovaným system promptem
 *   4. Vrať structured output: summary, risks[], strengths[], recommendation
 *
 * Cost (Claude Haiku 4.5, 2026):
 *   - input $1 / 1M tokens, output $5 / 1M tokens
 *   - typický payload: ~3000 input + ~500 output tokens = ~$0.0055 per summary
 *   - 100 souhrnů/den × 30 dní × 0.0055 = ~$16.5/měs ≈ 400 Kč/měs
 *
 * Cache:
 *   - výsledek se ukládá do SQLite tabulky ai_summaries
 *   - TTL 7 dní (firma se v jednotkách dní rapidly nemění)
 *   - cache hit = okamžitá odpověď, žádné API volání
 *
 * Privacy:
 *   - data jdou na Anthropic (USA, EU-US Data Privacy Framework)
 *   - obsahují jen veřejně dostupná data z registrů (žádné citlivé osobní údaje)
 *   - PRIVACY.md §4 musí Anthropic explicitně uvádět
 */

import type { AresClient } from "../ares/client.js";
import { fetchOsobaDetail, searchOsoby } from "../hlidacstatu/client.js";
import { getDb } from "../persons_index/db.js";
import {
  fullDueDiligenceService,
  getDotaceService,
  getInsolvenceDetailService,
  getSmlouvyService,
  getUboService,
  type LookupCompanyResult,
} from "../services.js";
import { searchUpvByName } from "../upv/service.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, type LlmProvider, llmGenerate } from "./providers.js";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT = `Jsi senior compliance / KYC analytik specializovaný na české obchodní subjekty. Tvým úkolem je z poskytnutých strukturovaných dat o firmě (z veřejných registrů) vygenerovat stručný analytický souhrn pro nezávislého due diligence klienta.

PRAVIDLA:
- Píšeš česky, formálně ale srozumitelně, nepoužíváš zbytečné fráze
- Striktně se držíš faktů z dat — NEVYMÝŠLEJ čísla, jména, ani události
- Pokud v datech najdeš sekci "hsOsoby" s aktuálním PEP statusem (Hlídač státu, snapshot dnes), POVAŽUJ ji za GROUND TRUTH a přepiš si svoji tréninkovou znalost — ber realtime z hsOsoby jako autoritu, ne svoje cutoff vědění
- Identifikuj POZITIVA i NEGATIVA, ne jen jedno
- Pro PEP (Politically Exposed Person), EU sankce, insolvence VŽDY explicit varuj
- Pro firmy mladší 30 dnů automaticky red flag (možná shell company)
- Pro sdílené adresy se 50+ firmami varuj (možná virtuální office)
- Pro firmy s 0 živnostmi + 0 zaměstnanci + obrat > 1 mil. varuj
- Pro neplatné DPH / nespolehlivého plátce varuj
- Pro absenci dat (žádné DPH, žádné insolvence) NEVAR — to je normální
- Pokud nemáš jistotu o události po lednu 2025 (cutoff Haiku), buď opatrný — preferuj hsOsoby nebo neuvádět než halucinovat

OUTPUT FORMAT (přísně JSON, nic jiného):
{
  "summary": "5-10 vět executive souhrn firmy",
  "risks": ["red flag 1", "red flag 2", ...],
  "strengths": ["pozitivní signál 1", ...],
  "recommendation": "stručný next-step pro KYC v 1-2 větách",
  "confidence": 0.85
}

confidence (0-1) = jak jistě jsi udělal hodnocení podle dostupných dat:
- 0.9+ pokud máš plné DD data včetně UBO + ÚPV + sankce + hsOsoby pro PEP
- 0.7-0.9 pokud chybí 1-2 zdroje (např. VR blokovaný)
- < 0.7 pokud chybí víc dat — pak to uveď v recommendation`;

export interface AiSummary {
  ico: string;
  obchodniJmeno: string;
  summary: string;
  risks: string[];
  strengths: string[];
  recommendation: string;
  confidence: number;
  generatedAt: number;
  model: string;
  source: { provider: string; note: string };
}

/**
 * Pro každého statutára / UBO s datumem narození zjistíme aktuální Hlídač
 * státu profil. Slouží jako "ground truth" pro PEP / politické funkce
 * nezávisle na LLM knowledge cutoff. Quietly skipuje osoby bez datumu
 * narození nebo bez HS shody.
 *
 * Performance: paralelní lookup max 8 osob (statutáři + UBO). Pro typický
 * profil firmy ~5 osob = ~1-2 s extra latence. Pro shell company 1 osoba.
 * Pro velký holding (Agrofert: 12+ statutárů) limitujeme na top 6.
 */
async function enrichWithHsOsoby(
  dd: { statutary?: { clenove?: Array<{ jmeno?: string; datumNarozeni?: string }> } },
  ubo: { ubo?: Array<{ jmeno?: string; datumNarozeni?: string }> } | null,
): Promise<Array<{ jmeno: string; prijmeni: string; narozeni: string; politickaStrana?: unknown; udalosti?: unknown[]; profile?: string }>> {
  const seen = new Set<string>();
  const candidates: Array<{ jmeno: string; prijmeni: string; datumNarozeni: string }> = [];

  function splitName(fullName: string): { jmeno: string; prijmeni: string } | null {
    const parts = fullName.trim().replace(/^(ing|mgr|jud|mudr|phdr|bc)\.?\s*/i, "").split(/\s+/);
    if (parts.length < 2) return null;
    return { jmeno: parts[0], prijmeni: parts[parts.length - 1] };
  }

  for (const m of dd.statutary?.clenove ?? []) {
    if (!m.jmeno || !m.datumNarozeni) continue;
    const split = splitName(m.jmeno);
    if (!split) continue;
    const key = `${split.jmeno}|${split.prijmeni}|${m.datumNarozeni.slice(0, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...split, datumNarozeni: m.datumNarozeni.slice(0, 10) });
  }
  for (const u of ubo?.ubo ?? []) {
    if (!u.jmeno || !u.datumNarozeni) continue;
    const split = splitName(u.jmeno);
    if (!split) continue;
    const key = `${split.jmeno}|${split.prijmeni}|${u.datumNarozeni.slice(0, 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...split, datumNarozeni: u.datumNarozeni.slice(0, 10) });
  }

  // Limit: 6 osob max — drahé na HS quotu a LLM context size
  const limited = candidates.slice(0, 6);

  const results = await Promise.all(
    limited.map(async (c) => {
      try {
        const matches = await searchOsoby(c.jmeno, c.prijmeni, c.datumNarozeni);
        if (!matches || matches.length === 0) return null;
        // První shoda — HS typicky vrací jednu osobu pro unikátní jméno+datum
        const detail = await fetchOsobaDetail(matches[0].nameId);
        return {
          jmeno: c.jmeno,
          prijmeni: c.prijmeni,
          narozeni: c.datumNarozeni,
          politickaStrana: detail.politickaStrana,
          udalosti: detail.udalosti?.slice(0, 10), // top 10 nejnovějších událostí
          profile: detail.profile,
        };
      } catch {
        return null; // 404 / 403 / chybí token — tichý skip
      }
    }),
  );
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

function buildContextFromDD(
  dd: LookupCompanyResult & Record<string, unknown>,
  extras: Record<string, unknown>,
): string {
  // Strip _attribution from each subcomponent — neslouží LLM analýze.
  const stripped = JSON.parse(JSON.stringify({ dd, ...extras }));
  function strip(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map(strip);
    if (obj && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      delete o._attribution;
      for (const k of Object.keys(o)) o[k] = strip(o[k]);
      return o;
    }
    return obj;
  }
  return JSON.stringify(strip(stripped), null, 2);
}

function parseStructured(raw: string): {
  summary: string;
  risks: string[];
  strengths: string[];
  recommendation: string;
  confidence: number;
} {
  // Claude občas obalí JSON markdown ```json wrapperem, nebo přidá komentář
  // za uzavírací }. Robustně extrahuj substring od první { do poslední } a
  // ten parsuj.
  let cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  try {
    const parsed = JSON.parse(cleaned);
    return {
      summary: String(parsed.summary ?? ""),
      risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
      recommendation: String(parsed.recommendation ?? ""),
      confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    };
  } catch (e) {
    throw new Error(`LLM vrátil nečitelný JSON: ${(e as Error).message}. Raw: ${cleaned.slice(0, 300)}`);
  }
}

function getCached(ico: string): AiSummary | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM ai_summaries WHERE ico = ?").get(ico) as
    | { ico: string; payload: string; generated_at: number; model: string }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.generated_at > CACHE_TTL_MS) return null;
  try {
    return JSON.parse(row.payload) as AiSummary;
  } catch {
    return null;
  }
}

function setCached(summary: AiSummary): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO ai_summaries (ico, payload, generated_at, model)
    VALUES (@ico, @payload, @generated_at, @model)
    ON CONFLICT(ico) DO UPDATE SET
      payload = excluded.payload,
      generated_at = excluded.generated_at,
      model = excluded.model
  `).run({
    ico: summary.ico,
    payload: JSON.stringify(summary),
    generated_at: summary.generatedAt,
    model: summary.model,
  });
}

function providerLabel(provider: LlmProvider, model: string): string {
  if (provider === "anthropic") {
    if (model.includes("opus")) return "Anthropic Claude Opus 4.7";
    if (model.includes("sonnet")) return "Anthropic Claude Sonnet 4.6";
    return "Anthropic Claude Haiku 4.5";
  }
  if (provider === "google") {
    if (model.includes("pro")) return "Google Gemini Pro 2.0";
    return "Google Gemini Flash 2.0";
  }
  return `${provider}/${model}`;
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super("ANTHROPIC_API_KEY není nakonfigurován — AI souhrn nedostupný.");
    this.name = "LlmNotConfiguredError";
  }
}

export async function generateAiSummary(
  client: AresClient,
  ico: string,
  options?: { force?: boolean; userApiKey?: string; provider?: LlmProvider; model?: string },
): Promise<AiSummary> {
  if (!options?.force) {
    const cached = getCached(ico);
    if (cached) return cached;
  }

  // Provider + model = user volba z Settings popoveru. Fallback na Anthropic
  // Haiku 4.5 pokud user neposlal hlavičky (= default klient).
  const provider: LlmProvider = options?.provider ?? DEFAULT_PROVIDER;
  const model = options?.model ?? DEFAULT_MODEL;

  // Priority: per-request user API key (BYO) > env admin key (fallback pro
  // testování). Fáze 1 monetizace: server-side env je zachovaný jen pro
  // admina, public visitor bez vlastního klíče v UI nesmí vidět tlačítko
  // takže k tomuto fallbacku se nedostane.
  const apiKey = options?.userApiKey?.trim() || process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new LlmNotConfiguredError();

  // 1. Sebraj data — DD + UBO + dotace + smlouvy + insolvence + ÚPV.
  //    Každý sub-call wrapnutý v catch, abychom nezablokovali kvůli jednomu
  //    nedostupnému zdroji (např. VR proxy padne, ostatní data postačí).
  const dd = await fullDueDiligenceService(client, ico);
  const [ubo, dotace, smlouvy, isir] = await Promise.all([
    getUboService(ico).catch(() => null),
    getDotaceService(ico).catch(() => null),
    getSmlouvyService(ico).catch(() => null),
    getInsolvenceDetailService(ico).catch(() => null),
  ]);
  const upv = dd.obchodniJmeno
    ? searchUpvByName(dd.obchodniJmeno, dd.identification?.sidlo?.nazevObce)
    : null;

  // HS osoby — real-time PEP / politická pozice. Řeší LLM knowledge cutoff:
  // pro každého statutára/UBO s datem narození zjistíme aktuální pol. funkce
  // přímo z Hlídače státu. LLM má ground truth nezávisle na svém cutoffu.
  const hsOsoby = await enrichWithHsOsoby(dd, ubo);

  const context = buildContextFromDD(dd as never, { ubo, dotace, smlouvy, isir, upv, hsOsoby });

  // 2. Volej LLM přes provider abstraction.
  // 2500 tokens = bezpečně i pro velké holdingy s 12+ statutáři + hsOsoby.
  const text = await llmGenerate({
    provider,
    model,
    apiKey,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: `Vyhodnoť následující data o firmě a vygeneruj strukturovaný JSON souhrn dle pravidel.\n\nDATA:\n${context}`,
    maxTokens: 2500,
  });
  const parsed = parseStructured(text);

  const result: AiSummary = {
    ico,
    obchodniJmeno: dd.obchodniJmeno ?? "",
    ...parsed,
    generatedAt: Date.now(),
    model: `${provider}/${model}`,
    source: {
      provider: providerLabel(provider, model),
      note: "AI souhrn je informativní — nenahrazuje právní due diligence ani AML/KYC povinnosti.",
    },
  };

  setCached(result);
  return result;
}
