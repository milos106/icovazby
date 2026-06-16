// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * LLM provider abstraction — Anthropic Claude + Google Gemini.
 *
 * User si v Settings vybere provider + model + vloží svůj API klíč.
 * Backend přijme hlavičky X-LLM-Provider, X-LLM-Model, X-LLM-Key a
 * zavolá správný SDK / REST API.
 *
 * Modely k dispozici (2026-06):
 *   anthropic:
 *     - claude-haiku-4-5-20251001  → ~18 hal/souhrn, cutoff ~01/2025
 *     - claude-sonnet-4-6          → ~70 hal/souhrn, cutoff ~08/2025
 *     - claude-opus-4-7            → ~400 hal/souhrn, cutoff 01/2026 ✓ aktuální
 *   google:
 *     - gemini-2.0-flash           → ~2 hal/souhrn, cutoff ~2024
 *     - gemini-2.0-pro             → ~100 hal/souhrn
 */

import Anthropic from "@anthropic-ai/sdk";

export type LlmProvider = "anthropic" | "google";

/** Strukturovaná chyba z LLM providera — server ji vrátí jako 400 s message. */
export class LlmApiError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = "LlmApiError";
  }
}

export const DEFAULT_PROVIDER: LlmProvider = "anthropic";
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export interface LlmGenerateOpts {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens: number;
}

export async function llmGenerate(opts: LlmGenerateOpts): Promise<string> {
  if (opts.provider === "anthropic") return generateAnthropic(opts);
  if (opts.provider === "google") return generateGoogle(opts);
  throw new Error(`Unknown LLM provider: ${opts.provider}`);
}

async function generateAnthropic(opts: LlmGenerateOpts): Promise<string> {
  const client = new Anthropic({ apiKey: opts.apiKey });
  const msg = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens,
    system: opts.systemPrompt,
    messages: [{ role: "user", content: opts.userMessage }],
  });
  const text = msg.content[0]?.type === "text" ? msg.content[0].text : "";
  if (!text) throw new Error("Claude vrátil prázdnou odpověď.");
  return text;
}

async function generateGoogle(opts: LlmGenerateOpts): Promise<string> {
  // Gemini REST API — žádný SDK install potřeba.
  // Doc: https://ai.google.dev/api/rest/v1beta/models/generateContent
  // #9: klíč v hlavičce x-goog-api-key (ne v query stringu — ten končí v access logách Googlu).
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: opts.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: opts.userMessage }] }],
    generationConfig: {
      maxOutputTokens: opts.maxTokens,
      // JSON mode — Gemini vrátí pure JSON bez markdown wrapperu.
      responseMimeType: "application/json",
      // Lehce kreativní pro češtinu, ale ne hallucinationy.
      temperature: 0.4,
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    // Strip JSON formatting noise pro lepší UI message.
    let msg = errText.slice(0, 200);
    try {
      const parsed = JSON.parse(errText) as { error?: { message?: string } };
      if (parsed?.error?.message) msg = parsed.error.message;
    } catch { /* keep raw */ }
    throw new LlmApiError(`Google Gemini: ${msg}`, res.status);
  }
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
  };
  const candidate = json.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Google Gemini vrátil prázdnou odpověď (finishReason=${candidate?.finishReason ?? "?"}).`);
  return text;
}
