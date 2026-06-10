// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ares-web — Fastify HTTP server exposing a Czech business-registry due-
 * diligence web app. Serves a static SPA from public/ and a small REST API
 * backed by the public ARES endpoints.
 *
 * Run: `npm run dev` (watch) or `npm run start` (built).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { AresClient } from "./ares/client.js";
import { cached, cacheStats } from "./cache.js";
import { AresError, toToolErrorPayload } from "./errors.js";
import { HlidacStatuMissingTokenError, HlidacStatuRateLimitedError } from "./hlidacstatu/client.js";
import { VrAccessBlockedError } from "./justice_vr/client.js";
import { LlmNotConfiguredError, generateAiSummary } from "./llm/service.js";
import { LlmApiError } from "./llm/providers.js";
import { hsTokenContext } from "./hlidacstatu/token_context.js";
import { indexStats } from "./persons_index/store.js";
import {
  crossCompanyPersonsService,
  discoverHolding,
  exportForInvoicingService,
  fullDueDiligenceService,
  getAdisVatStatusService,
  getCnbRatesService,
  getDotaceService,
  getEuSanctionsScreenService,
  getInsolvenceDetailService,
  getJerrsService,
  getPersonVazbyService,
  getResClassificationService,
  getSmlouvyService,
  getVrDetailService,
  getTradeLicensesService,
  getUboService,
  type InvoiceTarget,
  lookupCompanyService,
  searchByAddressService,
  searchCompaniesService,
  validateIcoService,
} from "./services.js";
import { buildTimeline } from "./timeline/service.js";
import { getTrademarksByCompany } from "./tmview/service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");

// Single source of truth pro verzi: package.json. Použito pro /healthz
// a pro injekci cache-busteru do index.html ({{VERSION}} placeholder).
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

// Render index.html jednou při startu, replace {{VERSION}} → PKG_VERSION.
// Server pak vrací předgenerovaný string z /  — žádné per-request I/O.
const INDEX_HTML = (() => {
  try {
    return readFileSync(join(PUBLIC_DIR, "index.html"), "utf8")
      .replaceAll("{{VERSION}}", PKG_VERSION);
  } catch {
    return "";
  }
})();

function parseEnvNumber(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const PORT = parseEnvNumber(process.env.PORT, 3000);
const HOST = process.env.HOST ?? "127.0.0.1";

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? "info" },
  trustProxy: true,
});

await app.register(fastifyRateLimit, {
  max: parseEnvNumber(process.env.RATE_LIMIT_PER_MIN, 60),
  timeWindow: "1 minute",
  keyGenerator: (req) =>
    (req.headers["cf-connecting-ip"] as string) ||
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.ip,
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: 429,
    error: "RATE_LIMITED",
    message: `Příliš mnoho dotazů, zkuste to za ${Math.ceil(ctx.ttl / 1000)} s.`,
  }),
});

await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: "/",
  // Auto-index VYPNUT — vlastní handler `/` níže injektuje {{VERSION}}
  // z package.json. fastify-static jinak servíruje statiku z /js, /css, /data.
  index: false,
});

// Vlastní `/` (a /index.html) handler — injektuje verzi z package.json
// do cache-busteru `<script src=".../app.js?v=X.Y.Z">` + footer.
// `cache-control: no-cache` aby browser vždy revalidoval HTML; statika
// pak má vlastní long max-age + verze v query stringu = busted při releasu.
const INDEX_ETAG = `W/"icovazby-${PKG_VERSION}"`;
const serveIndex = async (req: FastifyRequest, reply: FastifyReply) => {
  // Verze v ETagu — stejná verze vrátí 304 (browser použije cache), nová
  // verze invaliduje. `no-store` navíc zakáže bfcache, aby user po deployi
  // VŽDY dostal nové HTML (které nese cache-buster query pro app.js).
  if (req.headers["if-none-match"] === INDEX_ETAG) {
    return reply.status(304).send();
  }
  reply.header("etag", INDEX_ETAG);
  reply.header("cache-control", "no-store, must-revalidate");
  reply.header("content-type", "text/html; charset=utf-8");
  return INDEX_HTML;
};
app.get("/", serveIndex);
app.get("/index.html", serveIndex);

// Per-request HS token: pokud klient pošle hlavičku X-Hlidac-Token,
// uložíme ji do AsyncLocalStorage. hlidacstatu/client.getToken() pak ji
// použije přednostně před env tokenem. Tím se rozdělí rate limit na
// per-uživatele a admin token serveru funguje jen jako fallback (např.
// pro dev nebo pro DD endpointy bez UI).
app.addHook("onRequest", async (req) => {
  const raw = req.headers["x-hlidac-token"];
  const token = typeof raw === "string" ? raw.trim() : Array.isArray(raw) ? raw[0]?.trim() : "";
  if (token) hsTokenContext.enterWith(token);
});

// R16: audit log pro AML compliance. Logujeme DD lookupy + holding discovery
// + cross-persons. Statické soubory a /healthz nelogujeme (low signal).
import { dbAudit } from "./persons_index/db.js";
app.addHook("onRequest", async (req) => {
  const url = req.url;
  if (!url.startsWith("/api/")) return;
  if (url.startsWith("/api/features") || url.startsWith("/api/validate")) return;
  const m = url.match(/^\/api\/(dd|holding\/discover|cross-persons|trademarks|timeline|vr|ubo|dotace|smlouvy|adis|isir|jerrs|sanctions|zivno|res-classification|search|address|person-vazby)(?:\/([^?]+))?/);
  if (!m) return;
  const action = m[1];
  const targetIco = m[2] ?? null;
  const ip =
    (req.headers["cf-connecting-ip"] as string) ||
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.ip ||
    null;
  const userAgent = (req.headers["user-agent"] as string) ?? null;
  try {
    dbAudit({
      ip: ip || null,
      action,
      targetIco: targetIco?.replace(/[^0-9]/g, "").slice(0, 8) || null,
      userAgent,
    });
  } catch {
    /* never fail request because of audit log */
  }
});

// AGPL evidence: X-Powered-By na každý response. Pomáhá identifikovat
// instance, které tento kód provozují — důkazní materiál pokud někdo
// porušuje §13 (povinné publikování modifikovaného zdroje).
app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("X-Powered-By", "icovazby/0.4.0 (AGPL-3.0)");
  return payload;
});

const client = new AresClient({
  baseUrl: process.env.ARES_BASE_URL,
  ratePerSecond: parseEnvNumber(process.env.ARES_RATE_PER_SECOND, 5),
  timeoutMs: parseEnvNumber(process.env.ARES_TIMEOUT_MS, 15000),
  retries: parseEnvNumber(process.env.ARES_RETRIES, 3),
});

// ─── Error handler ────────────────────────────────────────────────────────────
function sendError(reply: FastifyReply, err: unknown): void {
  if (err instanceof HlidacStatuMissingTokenError) {
    reply.status(503).send({
      error: "MISSING_TOKEN",
      message:
        "Hlídač státu není nakonfigurován (HLIDAC_API_TOKEN chybí v .env nebo serveru). Tato funkce vyžaduje token.",
    });
    return;
  }
  if (err instanceof LlmNotConfiguredError) {
    reply.status(503).send({
      error: "LLM_NOT_CONFIGURED",
      message:
        "AI souhrn není nakonfigurován. Vlož svůj API klíč v Settings (Anthropic Claude nebo Google Gemini).",
    });
    return;
  }
  if (err instanceof LlmApiError) {
    // Propaguj LLM provider chybu (401, 400, 429, ...) jako klientskou chybu
    // s konkrétní zprávou. User obvykle uvidí "API key not valid" → ví že
    // má vrátit klíč nebo zkusit jiný.
    reply.status(err.statusCode === 401 || err.statusCode === 403 ? 401 : 400).send({
      error: "LLM_API_ERROR",
      message: err.message,
    });
    return;
  }
  // Graceful degradation pro upstream blokace — vrátíme 200 + ok:false, ať se
  // DD aggregator a frontend nezacyklí v retry. UI ukáže fallback hlášku.
  if (err instanceof VrAccessBlockedError) {
    reply.status(200).send({
      ok: false,
      reason: "vr_blocked",
      message:
        "Veřejný rejstřík momentálně blokuje IP našeho serveru. Data vyhledej přímo na verejnerejstriky.msp.gov.cz.",
    });
    return;
  }
  if (err instanceof HlidacStatuRateLimitedError) {
    reply.status(200).send({
      ok: false,
      reason: "hs_rate_limited",
      message:
        "Vyčerpán denní limit požadavků na Hlídač státu. Zkus za chvíli, nebo si v Nastavení nastav vlastní token.",
    });
    return;
  }
  if (err instanceof AresError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "INVALID_INPUT" ? 400 : 502;
    reply.status(status).send(toToolErrorPayload(err));
    return;
  }
  app.log.error(err as Error);
  reply.status(500).send({ error: "INTERNAL", message: "Interní chyba serveru." });
}

// ─── Health ───────────────────────────────────────────────────────────────────
// R16: Audit log export (admin only — chráněno přes ADMIN_TOKEN env var).
// CSV download s timestamp, IP, action, target IČO, user agent.
app.get("/api/audit-log", async (req: FastifyRequest, reply) => {
  const adminToken = process.env.ADMIN_TOKEN?.trim();
  if (!adminToken) {
    return reply.status(503).send({ error: "ADMIN_NOT_CONFIGURED", message: "ADMIN_TOKEN není nastaven v .env." });
  }
  const provided = (req.headers["x-admin-token"] as string)?.trim();
  if (provided !== adminToken) {
    return reply.status(401).send({ error: "UNAUTHORIZED" });
  }
  const sinceParam = (req.query as { since?: string }).since;
  const since = sinceParam ? Number(sinceParam) : Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 dní
  const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 10000), 50000);
  const { dbAuditQuery } = await import("./persons_index/db.js");
  const rows = dbAuditQuery({ since, limit });
  const header = "id,timestamp_iso,ip,action,target_ico,user_agent";
  const csv = [
    header,
    ...rows.map((r) =>
      [
        r.id,
        new Date(r.ts).toISOString(),
        r.ip ?? "",
        r.action,
        r.target_ico ?? "",
        `"${(r.user_agent ?? "").replace(/"/g, '""')}"`,
      ].join(","),
    ),
  ].join("\n");
  reply.header("Content-Type", "text/csv; charset=utf-8");
  reply.header("Content-Disposition", `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  reply.send("﻿" + csv);
});

app.get("/healthz", async () => ({
  ok: true,
  version: PKG_VERSION,
  uptimeSeconds: Math.floor(process.uptime()),
  cache: cacheStats(),
  integrations: {
    ares: true,
    adis: true,
    cnb: true,
    jerrs: true,
    euSanctions: true,
    vr: true,
    hlidacstatu: Boolean(process.env.HLIDAC_API_TOKEN?.trim()),
  },
}));

// ─── Feature flags ────────────────────────────────────────────────────────────
// Browser reads this on init to know which optional integrations are active.
// Footer attribution for Hlídač státu (CC BY 3.0 — mandatory link) only shows
// when its token is present.
app.get("/api/features", async () => ({
  // Server má fallback (sdílený admin) token? UI ho neukazuje, jen
  // ví, že může dělat HS dotazy i bez user-token. Při multi-user
  // nasazení by tato hodnota měla být false a každý user si nasadí
  // svůj.
  hlidacstatuFallback: Boolean(process.env.HLIDAC_API_TOKEN?.trim()),
  hlidacstatu: Boolean(process.env.HLIDAC_API_TOKEN?.trim()),
  hsTokenRegistrationUrl: "https://www.hlidacstatu.cz/api",
}));

// ─── Validate IČO (pure) ──────────────────────────────────────────────────────
app.get("/api/validate/:ico", async (req: FastifyRequest, reply) => {
  const ico = (req.params as { ico: string }).ico;
  reply.send(validateIcoService(ico));
});

// ─── Company profile ──────────────────────────────────────────────────────────
app.get("/api/company/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await lookupCompanyService(client, ico));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Due diligence ────────────────────────────────────────────────────────────
// Demo endpointy — cached snapshoty pre-selected firem (Agrofert, ČEZ).
// Nevolají Hlídač státu (nevyžadují token), takže fungují pro každého
// kdo přistoupí na landing /demo/26185610. 24h cache.
const DEMO_ICOS = new Set(["26185610", "45274649"]);
const demoCache = new Map<string, { ts: number; data: unknown }>();
const DEMO_TTL_MS = 24 * 60 * 60 * 1000;

app.get("/demo/:ico", async (req: FastifyRequest, reply) => {
  const ico = (req.params as { ico: string }).ico;
  if (!DEMO_ICOS.has(ico)) {
    reply.status(404).send({ error: "DEMO_NOT_AVAILABLE", message: "Demo je dostupné jen pro IČO: " + [...DEMO_ICOS].join(", ") });
    return;
  }
  const cached = demoCache.get(ico);
  if (cached && Date.now() - cached.ts < DEMO_TTL_MS) {
    reply.send(cached.data);
    return;
  }
  try {
    const data = await fullDueDiligenceService(client, ico);
    demoCache.set(ico, { ts: Date.now(), data });
    reply.send(data);
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── E-mail alerts (subscribe / verify / unsubscribe) ────────────────────────
import { subscribe, verify, unsubscribe } from "./alerts/store.js";
import { sendMail } from "./alerts/mailer.js";
import { startScheduler } from "./alerts/checker.js";
import { preseedTopCompanies } from "./seed/preseed.js";

const subscribeSchema = z.object({
  email: z.string().email(),
  ico: z.string().regex(/^\d{7,8}$/),
});

app.post("/api/alerts/subscribe", async (req: FastifyRequest, reply) => {
  try {
    const body = subscribeSchema.parse(req.body);
    const sub = await subscribe(body.email, body.ico);
    if (!sub.verifiedAt) {
      const base = process.env.PUBLIC_BASE_URL ?? `http://${HOST}:${PORT}`;
      const link = `${base}/api/alerts/verify/${sub.verificationToken}`;
      await sendMail({
        to: sub.email,
        subject: "IČO vazby: potvrď odběr alertů",
        text: `Pro aktivaci alertů pro IČO ${sub.ico} klikni: ${link}\n\nPokud jsi o odběr nežádal, zprávu ignoruj.`,
      });
    }
    reply.send({ ok: true, pendingVerification: !sub.verifiedAt });
  } catch (e) {
    if (e instanceof z.ZodError) {
      reply.status(400).send({ error: "INVALID_INPUT", issues: e.issues });
      return;
    }
    sendError(reply, e);
  }
});

app.get("/api/alerts/verify/:token", async (req: FastifyRequest, reply) => {
  const token = (req.params as { token: string }).token;
  const sub = await verify(token);
  if (!sub) {
    reply.status(404).type("text/html").send(
      '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#dc2626">Neplatný nebo už použitý odkaz.</body></html>',
    );
    return;
  }
  reply.type("text/html").send(
    `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px"><h2 style="color:#059669">✓ Odběr aktivován</h2><p>Budeme tě informovat o změnách u IČO ${sub.ico}.</p><p><a href="/">Zpět na IČO vazby</a></p></body></html>`,
  );
});

app.delete("/api/alerts/:id", async (req: FastifyRequest, reply) => {
  const id = (req.params as { id: string }).id;
  const ok = await unsubscribe(id);
  reply.send({ ok });
});

// Printable HTML report — uživatel ho otevře v novém tabu, browser
// auto-invokuje window.print() → uloží jako PDF.
app.get("/report/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    const report = await fullDueDiligenceService(client, ico);
    const { renderDdReportHtml } = await import("./report/html.js");
    reply.type("text/html").send(renderDdReportHtml(report as never));
  } catch (e) {
    sendError(reply, e);
  }
});

app.get("/api/dd/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    const data = await cached(`dd:${ico}`, () => fullDueDiligenceService(client, ico));
    reply.send(data);
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Timeline — chronologická historie firmy ─────────────────────────────────
app.get("/api/timeline/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    const data = await cached(`timeline:${ico}`, () => buildTimeline(client, ico));
    reply.send(data);
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── TMView trademarks — ochranné známky podle IČO ────────────────────────────
// Aktuálně VYPNUTO. TMView (tmdn.org) má F5 bot detection, která blokuje
// požadavky z datacenter IP rozsahů (jako Hetzner). Server-side fetch =
// ECONNRESET. Cross-origin browser fetch = CORS blok. Funkční integrace
// vyžaduje EUIPO Cobranding partnership s oficiálním OAuth tokenem.
//
// Kód v `src/tmview/` je zachován pro pozdější use jakmile bude k dispozici
// partnership. Endpoint zatím vrací 503 s explicitním důvodem.
app.get("/api/trademarks/:ico", async (_req: FastifyRequest, reply) => {
  reply.status(503).send({
    error: "UPSTREAM_BLOCKED",
    message: "TMView endpoint blokuje data-center IP (F5 bot detection). Vyžaduje EUIPO Cobranding partnership.",
    primarySource: "https://www.tmdn.org/tmview/",
    partnershipInfo: "https://www.tmdn.org/network/working-areas/tmview-cobranding",
  });
});
// Reference pro budoucí použití (jakmile bude API key):
// const data = await cached(`tm:${ico}`, () => getTrademarksByCompany(client, ico));
void getTrademarksByCompany;

// ─── ÚPV ochranné známky — lokální index (ST.96 open data) ──────────────────
// Backend pro DD kartu „Ochranné známky": fuzzy lookup podle obchodního
// jména v lokálním SQLite (300k záznamů, ÚPV otevřená data 10-02-2026 +
// denní DIFF). Není to per-IČO (ÚPV IČO neposkytuje), ale per-name match.
import { searchUpvByName } from "./upv/service.js";
app.get("/api/upv/by-name", async (req: FastifyRequest, reply) => {
  try {
    const { name, city } = req.query as { name?: string; city?: string };
    if (!name || name.trim().length < 2) {
      return reply.status(400).send({ error: "INVALID_INPUT", message: "Parametr 'name' je povinný (min 2 znaky)." });
    }
    reply.send(searchUpvByName(name.trim(), city?.trim()));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── LLM auto-summary (Claude Haiku 4.5) ──────────────────────────────────
// AI-generated executive souhrn firmy. Volá se on-demand z UI tlačítkem.
// Cache 7 dní per IČO, výsledek strukturovaný JSON (risks, strengths, recommendation).
// Rate limit 5 req/min/IP přes globální handler nastavený u serveru.
app.post("/api/llm/summary/:ico", async (req: FastifyRequest, reply) => {
  try {
    const { ico } = req.params as { ico: string };
    const force = (req.query as { force?: string }).force === "1";
    // BYO klíč + provider/model selection z headerů. Backward compat:
    // stará hlavička X-Anthropic-Key zachována, ale X-LLM-Key má přednost.
    const headerStr = (name: string): string => {
      const v = req.headers[name.toLowerCase()];
      return typeof v === "string" ? v.trim() : Array.isArray(v) ? v[0]?.trim() ?? "" : "";
    };
    const userApiKey = headerStr("x-llm-key") || headerStr("x-anthropic-key");
    const provider = (headerStr("x-llm-provider") || "anthropic") as "anthropic" | "google";
    const model = headerStr("x-llm-model") || undefined;
    const result = await generateAiSummary(client, ico, { force, userApiKey, provider, model });
    reply.send(result);
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Search companies by name + optional PSČ ─────────────────────────────────
const searchSchema = z.object({
  obchodniJmeno: z.string().min(1).optional(),
  sidloPsc: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
app.get("/api/search/companies", async (req: FastifyRequest, reply) => {
  try {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_INPUT", message: parsed.error.message });
    }
    reply.send(await searchCompaniesService(client, parsed.data));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Search by address ────────────────────────────────────────────────────────
const addressSchema = z.object({
  adresa: z.string().min(3),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
app.get("/api/search/address", async (req: FastifyRequest, reply) => {
  try {
    const parsed = addressSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_INPUT", message: parsed.error.message });
    }
    reply.send(await searchByAddressService(client, parsed.data));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── ČNB denní kurzy ──────────────────────────────────────────────────────────
app.get("/api/cnb/rates", async (_req: FastifyRequest, reply) => {
  try {
    reply.send(await getCnbRatesService());
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Veřejný rejstřík (OR) přes verejnerejstriky.msp.gov.cz ──────────────────
app.get("/api/vr/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    const data = await cached(`vr:${ico}`, () => getVrDetailService(ico));
    reply.send(data);
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── JERRS — regulované subjekty ČNB (open-data) ──────────────────────────────
app.get("/api/jerrs/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await getJerrsService(ico));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Lokální index osoba→firma — stats ────────────────────────────────────────
app.get("/api/persons/index-stats", async () => indexStats());

// ─── Person vazby (Hlídač státu osoby + ARES IČO resolve) ─────────────────────
const personVazbySchema = z.object({
  jmeno: z.string().min(1),
  prijmeni: z.string().optional(),
  datumNarozeni: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  includeHistorical: z.boolean().optional(),
  resolveIco: z.boolean().optional(),
});
app.post("/api/persons/vazby", async (req: FastifyRequest, reply) => {
  try {
    const parsed = personVazbySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_INPUT", message: parsed.error.message });
    }
    reply.send(await getPersonVazbyService(client, parsed.data));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── EU consolidated financial sanctions — name screening ─────────────────────
const euSanctionsSchema = z.object({
  names: z.array(z.string().min(1)).min(1).max(200),
});
app.post("/api/eu-sanctions/screen", async (req: FastifyRequest, reply) => {
  try {
    const parsed = euSanctionsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_INPUT", message: parsed.error.message });
    }
    reply.send(await getEuSanctionsScreenService(parsed.data.names));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── ISIR detail (via Hlídač státu) ───────────────────────────────────────────
app.get("/api/isir/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await getInsolvenceDetailService(ico));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Dotace (via Hlídač státu) ────────────────────────────────────────────────
app.get("/api/dotace/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await getDotaceService(ico));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Smlouvy ze Registru smluv (via Hlídač státu) ─────────────────────────────
app.get("/api/smlouvy/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await getSmlouvyService(ico));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── UBO (skuteční majitelé via Hlídač státu) ─────────────────────────────────
app.get("/api/ubo/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await getUboService(ico));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── ADIS VAT (nespolehlivý plátce + bankovní účty) ───────────────────────────
app.get("/api/adis/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await getAdisVatStatusService(ico));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Trade licenses (RŽP) ─────────────────────────────────────────────────────
app.get("/api/licenses/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await getTradeLicensesService(client, ico));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── RES classification ───────────────────────────────────────────────────────
app.get("/api/res/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await getResClassificationService(client, ico));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Export for invoicing ─────────────────────────────────────────────────────
const ALLOWED_INVOICE_TARGETS: ReadonlyArray<InvoiceTarget> = ["fakturoid", "idoklad", "pohoda"];
app.get("/api/export/:ico/:target", async (req: FastifyRequest, reply) => {
  try {
    const { ico, target } = req.params as { ico: string; target: string };
    if (!ALLOWED_INVOICE_TARGETS.includes(target as InvoiceTarget)) {
      return reply.status(400).send({
        error: "INVALID_INPUT",
        message: `Unknown target '${target}'. Use one of: ${ALLOWED_INVOICE_TARGETS.join(", ")}.`,
      });
    }
    reply.send(await exportForInvoicingService(client, ico, target as InvoiceTarget));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Holding discovery — BFS po jednatelích + akcionářích, depth 1-3 ─────────
const holdingSchema = z.object({
  ico: z.string().min(7).max(8),
  depth: z.coerce.number().int().min(1).max(3).optional(),
  maxIcos: z.coerce.number().int().min(5).max(200).optional(),
  includeHistorical: z.boolean().optional(),
});
// Tighter limit pro heavy endpoint — discover dělá až 50× ARES calls.
// Default 10/min, override přes RATE_LIMIT_HEAVY_PER_MIN.
const HEAVY_LIMIT = parseEnvNumber(process.env.RATE_LIMIT_HEAVY_PER_MIN, 10);

app.post("/api/holding/discover", {
  config: { rateLimit: { max: HEAVY_LIMIT, timeWindow: "1 minute" } },
}, async (req: FastifyRequest, reply) => {
  try {
    const parsed = holdingSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_INPUT", message: parsed.error.message });
    }
    const { ico, depth = 2, maxIcos = 50, includeHistorical = false } = parsed.data;
    reply.send(await discoverHolding(client, ico, depth, maxIcos, includeHistorical));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Cross-company persons ────────────────────────────────────────────────────
const crossSchema = z.object({
  // Min 1: 1-IČO request triggeruje auto-expand v service přes persons_index.
  // Service vyhodí InvalidInputError pokud expanze nenajde žádné sousedy.
  icos: z.array(z.string()).min(1).max(50),
  includeHistorical: z.boolean().optional(),
  emitMermaid: z.boolean().optional(),
});
app.post("/api/cross-persons", {
  config: { rateLimit: { max: HEAVY_LIMIT, timeWindow: "1 minute" } },
}, async (req: FastifyRequest, reply) => {
  try {
    const parsed = crossSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "INVALID_INPUT", message: parsed.error.message });
    }
    reply.send(await crossCompanyPersonsService(client, parsed.data));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Warm-up ──────────────────────────────────────────────────────────────────
// Fire-and-forget: po startu servery na pozadí natáhneme datasety, které
// jinak první uživatel platí latencí (EU sankce ~6 s na první load, JERRS
// ~600 ms, ČNB kurzy ~150 ms). Selhání je pouze WARN, server běží dál.
// Vypnout: WARMUP=0
async function warmup() {
  if (process.env.WARMUP === "0") {
    app.log.info("warmup disabled (WARMUP=0)");
    return;
  }
  app.log.info("warmup starting…");
  const t0 = Date.now();
  const tasks: Array<Promise<{ name: string; ok: boolean; ms: number; err?: string }>> = [
    (async () => {
      const t = Date.now();
      try {
        await getCnbRatesService();
        return { name: "cnb-rates", ok: true, ms: Date.now() - t };
      } catch (e) {
        return { name: "cnb-rates", ok: false, ms: Date.now() - t, err: String(e) };
      }
    })(),
    (async () => {
      const t = Date.now();
      try {
        // Probe s reálným IČO (Air Bank — banka, vždy v seznamu) jen pro warming;
        // cache je sdílená, takže jakýkoli platný lookup natáhne celý index.
        await getJerrsService("29045371");
        return { name: "jerrs", ok: true, ms: Date.now() - t };
      } catch (e) {
        return { name: "jerrs", ok: false, ms: Date.now() - t, err: String(e) };
      }
    })(),
    (async () => {
      const t = Date.now();
      try {
        await getEuSanctionsScreenService(["__warmup probe__"]);
        return { name: "eu-sanctions", ok: true, ms: Date.now() - t };
      } catch (e) {
        return { name: "eu-sanctions", ok: false, ms: Date.now() - t, err: String(e) };
      }
    })(),
  ];
  const results = await Promise.all(tasks);
  for (const r of results) {
    if (r.ok) app.log.info(`warmup ${r.name}: ok (${r.ms}ms)`);
    else app.log.warn(`warmup ${r.name}: failed (${r.ms}ms) — ${r.err}`);
  }
  app.log.info(`warmup done in ${Date.now() - t0}ms`);
}

// ─── Startup banner ───────────────────────────────────────────────────────────
// Logujeme stav každého konektoru hned po startu. Pomáhá uživateli rychle
// vidět co je aktivní bez nutnosti grepovat .env nebo hledat v logech.
function logStartupBanner(): void {
  const hsToken = process.env.HLIDAC_API_TOKEN?.trim();
  const lines = [
    "════════════════════════════════════════",
    `  ares-web ready on http://${HOST}:${PORT}`,
    "  Konektory:",
    "   ✓ ARES (vždy aktivní)",
    "   ✓ ADIS DPH (veřejná data, vždy aktivní)",
    "   ✓ ČNB denní kurzy + JERRS (veřejná data)",
    "   ✓ EU sankční list (veřejná data)",
    "   ✓ Veřejný rejstřík OR (verejnerejstriky.msp.gov.cz)",
    hsToken
      ? `   ✓ Hlídač státu (HLIDAC_API_TOKEN nastaven, ${hsToken.length} znaků)`
      : "   ✗ Hlídač státu (HLIDAC_API_TOKEN chybí — UBO, dotace, smlouvy, ISIR detail, vazby osob vypnuté)",
    "════════════════════════════════════════",
  ];
  for (const line of lines) app.log.info(line);
  if (!hsToken) {
    app.log.warn(
      "Hlídač státu integrace neaktivní. Token získáš na https://www.hlidacstatu.cz/api a vložíš jako HLIDAC_API_TOKEN do .env, pak restartuj.",
    );
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: HOST });
  logStartupBanner();
  void warmup();
  startScheduler(client);

  // Pre-seed lokálního subjects inventory s top českými firmami — bez tohoto
  // by `agrofer` nenašel Agrofert na čerstvé instanci (lokální fallback je
  // jediná cesta, ARES dělá whole-word match).
  if (process.env.PRESEED_TOP_CZ !== "0") {
    preseedTopCompanies(client)
      .then(({ added, skipped, total, memberships }) =>
        app.log.info(
          `preseed: ${added}/${total} firem + ${memberships} jednatelů nahráno (${skipped} skip)`,
        ),
      )
      .catch((e) => app.log.warn({ err: e }, "preseed failed"));
  }
} catch (err) {
  app.log.error(err as Error);
  process.exit(1);
}

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error(err as Error);
    process.exit(1);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
