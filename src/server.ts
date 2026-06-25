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
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { AresClient } from "./ares/client.js";
import { cached, cacheStats } from "./cache.js";
import { AresError, toToolErrorPayload } from "./errors.js";
import { HlidacStatuMissingTokenError, HlidacStatuRateLimitedError, HlidacStatuUnavailableError } from "./hlidacstatu/client.js";
import { VrAccessBlockedError } from "./justice_vr/client.js";
import { LlmNotConfiguredError, generateAiSummary } from "./llm/service.js";
import { LlmApiError } from "./llm/providers.js";
import { hsTokenContext } from "./hlidacstatu/token_context.js";
import {
  getChildrenByParent,
  getSubjectName,
  indexStats,
  listSubjects,
} from "./persons_index/store.js";
import { firmaPath, renderCompanyPage } from "./seo/companyPage.js";
import { renderDirectoryPage } from "./seo/directoryPage.js";
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
  getSbirkaListinService,
  getZaverkaCislaService,
  getZaverkaOcrService,
  getZaverkaVyvojService,
  getForensikaService,
  getPepSankceService,
  getCrossBorderService,
  getSmlouvyService,
  getVrDetailService,
  getTradeLicensesService,
  getUboService,
  groupFundingService,
  ownershipVerdictService,
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
  // #1: NEdůvěřuj všem proxy. Node poslouchá jen na loopbacku → veškerý provoz
  // jde přes Caddy (127.0.0.1). Caddy je nakonfigurovaný s Cloudflare
  // trusted_proxies + client_ip_headers, takže X-Forwarded-For, který nám
  // pošle, nese REÁLNOU klientskou IP (spoofnuté CF-Connecting-IP/XFF od
  // přímého útočníka na origin Caddy zahodí). req.ip pak = skutečný klient.
  trustProxy: process.env.TRUST_PROXY ?? "loopback",
});

// Interní volající na loopbacku (ares-mcp → 127.0.0.1:3000, BEZ X-Forwarded-For)
// se nepočítá do rate-limitu. Bezpečné: web traffic jde přes Caddy s XFF +
// trustProxy="loopback", takže req.ip externího klienta NIKDY není loopback;
// app navíc bindí jen 127.0.0.1, takže zvenčí se přímo doloopbacku nedostaneš.
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const isLoopbackReq = (req: { ip?: string }): boolean =>
  typeof req.ip === "string" && LOOPBACK_IPS.has(req.ip);

await app.register(fastifyRateLimit, {
  // 200/min/IP: jeden DD profil + graf + plné plátno snadno vystřelí 30-60 dotazů
  // v dávce (risk engine + lazy karty + holding/cross-persons), takže 60 bylo pro
  // legitimní power-user workflow moc málo. Scraping dál cení Cloudflare edge
  // rate-limit + per-IP keying; tohle je sekundární backstop. Laditelné přes env.
  max: parseEnvNumber(process.env.RATE_LIMIT_PER_MIN, 200),
  timeWindow: "1 minute",
  allowList: (req) => isLoopbackReq(req),
  // #1: jen req.ip (důvěryhodně spočtené z X-Forwarded-For od Caddy na loopbacku).
  // Klientem zaslané hlavičky už NEčteme — daly se podvrhnout a obejít limit.
  keyGenerator: (req) => req.ip,
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: 429,
    error: "RATE_LIMITED",
    message: `Příliš mnoho dotazů, zkuste to za ${Math.ceil(ctx.ttl / 1000)} s.`,
  }),
});

// Bezpečnostní hlavičky. CSP je nutně permisivní na skriptech (Tailwind CDN +
// Alpine vyžadují unsafe-inline/eval, app má i inline onclick), ale drží klíčové
// restrikce: connect-src jen self+Umami (brzdí exfiltraci při XSS), object-src
// none, base-uri self, frame-ancestors none (clickjacking). COEP/CORP vypnuté,
// ať se nerozbije načítání z CDN ani embed.js na cizích webech.
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.tailwindcss.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://stats.icovazby.cz"],
      "script-src-attr": ["'unsafe-inline'"], // inline onclick v HTML
      "style-src": ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com", "https://fonts.googleapis.com"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "img-src": ["'self'", "data:", "blob:"],
      "connect-src": ["'self'", "https://stats.icovazby.cz"],
      "frame-ancestors": ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
  hsts: { maxAge: 15552000, includeSubDomains: false }, // ať neovlivní subdomény
});

// Per-route limit pro DRAHÉ endpointy (HS sekvenčně / hodně ARES volání /
// uncached render). Vyšší než profilové procházení i dávka, ale brání
// amplifikaci scrapingem přes různá IČO (obejde cache). Laditelné přes env.
const EXPENSIVE_LIMIT = parseEnvNumber(process.env.RATE_LIMIT_EXPENSIVE_PER_MIN, 60);
const expensiveCfg = {
  config: {
    rateLimit: { max: EXPENSIVE_LIMIT, timeWindow: "1 minute", allowList: isLoopbackReq },
  },
};

// Predikát kompletnosti pro cache (viz cached() v cache.ts). HS-backed služby vrací
// `{ available: false }` JEN při selhání tokenu/upstreamu — úspěch i bez záznamů =
// `available:true`. Takže available===false = degradace → krátké TTL, nepersistovat
// (jinak přechodný výpadek Hlídače zamrzne na 24 h). NEPOUŽÍVAT na VR (tam je
// available:false i genuine „není v rejstříku").
const hsComplete = (v: unknown): boolean => (v as { available?: unknown } | null | undefined)?.available !== false;
// DD agregát: jediná HS-závislá sekce je insolvenci → kompletní, když ta neselhala.
const ddComplete = (v: unknown): boolean =>
  ((v as { insolvenci?: { available?: unknown } } | null | undefined)?.insolvenci?.available) !== false;

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

// Klasický (starší) layout — přesunut na /klasik. Vlastní handler kvůli
// {{VERSION}} cache-busteru (fastify-static má index:false). Hlavní app
// (workspace) je teď INDEX_HTML na `/` (viz serveIndex výše).
const KLASIK_HTML = (() => {
  try {
    return readFileSync(join(PUBLIC_DIR, "klasik", "index.html"), "utf8")
      .replaceAll("{{VERSION}}", PKG_VERSION);
  } catch {
    return "";
  }
})();
const serveKlasik = async (_req: FastifyRequest, reply: FastifyReply) => {
  reply.header("cache-control", "no-store, must-revalidate");
  reply.type("text/html; charset=utf-8");
  return reply.send(KLASIK_HTML);
};
// `/` = hlavní app (workspace). Klasický layout na `/klasik`.
app.get("/", serveIndex);
app.get("/index.html", serveIndex);
// Legacy: dřívější `/v2` alias → 301 na `/` (zachová query, např. ?v=<id>, ?ico=).
app.get("/v2", async (req: FastifyRequest, reply: FastifyReply) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  return reply.status(301).header("location", "/" + qs).send();
});
app.get("/klasik", serveKlasik);
app.get("/klasik/index.html", serveKlasik);

// #8: časově konstantní porovnání admin tokenu (proti timing útoku).
function adminTokenOk(provided: string | undefined | null): boolean {
  const expected = process.env.ADMIN_TOKEN?.trim();
  if (!expected || !provided) return false;
  // Hash na pevnou délku (32 B) → timingSafeEqual neprozradí délku tokenu
  // a odpadá délkový early-return.
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
// #5: CSV buňka odolná proti formula-injection (Excel/Sheets vyhodnotí =,+,-,@,tab).
function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

// Per-request HS token: pokud klient pošle hlavičku X-Hlidac-Token,
// uložíme ji do AsyncLocalStorage. hlidacstatu/client.getToken() pak ji
// použije přednostně před env tokenem. Tím se rozdělí rate limit na
// per-uživatele a admin token serveru funguje jen jako fallback (např.
// pro dev nebo pro DD endpointy bez UI).
app.addHook("onRequest", async (req) => {
  const raw = req.headers["x-hlidac-token"];
  const token = typeof raw === "string" ? raw.trim() : Array.isArray(raw) ? raw[0]?.trim() : "";
  // #3: VŽDY nastav store (i prázdný) — jinak by token usera A bez clearu přetekl
  // do následujícího requestu usera B (enterWith footgun na sdíleném kontextu).
  hsTokenContext.enterWith(token || undefined);
});

// R16: audit log pro AML compliance. Logujeme DD lookupy + holding discovery
// + cross-persons. Statické soubory a /healthz nelogujeme (low signal).
import { dbAudit, dbGetResponseCache, dbSetResponseCache } from "./persons_index/db.js";
import { screenExtraSanctions } from "./sanctions/client.js";
app.addHook("onRequest", async (req) => {
  const url = req.url;
  if (!url.startsWith("/api/")) return;
  if (url.startsWith("/api/features") || url.startsWith("/api/validate")) return;
  const m = url.match(/^\/api\/(dd|holding\/discover|cross-persons|trademarks|timeline|vr|ubo|dotace|smlouvy|adis|isir|jerrs|sanctions|pep-sankce|cross-border|zivno|res-classification|search|address|person-vazby)(?:\/([^?]+))?/);
  if (!m) return;
  const action = m[1];
  const targetIco = m[2] ?? null;
  const ip = req.ip || null; // #1: req.ip je teď důvěryhodný (loopback trust + Caddy/CF)
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
  if (err instanceof HlidacStatuUnavailableError) {
    // HS vrátil ne-JSON (HTML výpadek/údržba) nebo 4xx/5xx. 503 + čistá hláška,
    // ať per-blok UI ukáže „dočasně nedostupné" + tlačítko Zkusit znovu místo
    // generické „Interní chyba serveru" (500).
    reply.status(503).send({
      error: "HS_UNAVAILABLE",
      message:
        "Hlídač státu teď vrátil neočekávanou odpověď (nejspíš dočasný výpadek nebo údržba). Zkus to za chvíli znovu.",
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
  if (!adminTokenOk(provided)) {
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
        csvCell(r.id),
        csvCell(new Date(r.ts).toISOString()),
        csvCell(r.ip ?? ""),
        csvCell(r.action),
        csvCell(r.target_ico ?? ""),
        csvCell(r.user_agent ?? ""),
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

app.post("/api/alerts/subscribe", {
  // Posílá e-mail → přísnější limit proti bombingu (vedle anti-abuse ve store).
  config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
}, async (req: FastifyRequest, reply) => {
  try {
    const body = subscribeSchema.parse(req.body);
    const { sub, action } = await subscribe(body.email, body.ico);
    if (action === "send") {
      const base = process.env.PUBLIC_BASE_URL ?? "https://icovazby.cz";
      const link = `${base}/api/alerts/verify/${sub.verificationToken}`;
      await sendMail({
        to: sub.email,
        subject: "IČO vazby: potvrď odběr alertů",
        text: `Pro aktivaci alertů pro IČO ${sub.ico} klikni: ${link}\n\nPokud jsi o odběr nežádal, zprávu ignoruj.`,
      });
    }
    // Generická odpověď — neprozrazuje skip/blocked (zamezí enumeraci a sondování).
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

// Klikací odhlášení z e-mailu (GET — odkaz v těle zprávy).
app.get("/api/alerts/unsubscribe/:id", async (req: FastifyRequest, reply) => {
  const id = (req.params as { id: string }).id;
  const ok = await unsubscribe(id);
  reply.type("text/html").send(
    ok
      ? '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px"><h2 style="color:#059669">✓ Odhlášeno</h2><p>Už ti nebudeme posílat alerty pro tuto firmu.</p><p><a href="/">Zpět na IČO vazby</a></p></body></html>'
      : '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#dc2626">Odběr nenalezen (možná už byl zrušen).</body></html>',
  );
});

// Printable HTML report — uživatel ho otevře v novém tabu, browser
// auto-invokuje window.print() → uloží jako PDF.
app.get("/report/:ico", expensiveCfg, async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    // Cache renderovaného HTML — bez ní běžel full DD na KAŽDÝ request (DoS amplifikace).
    const html = await cached(
      `report:${ico}`,
      async () => {
        const report = await fullDueDiligenceService(client, ico);
        const { renderDdReportHtml } = await import("./report/html.js");
        return renderDdReportHtml(report as never);
      },
      { persist: true },
    );
    reply.type("text/html").send(html);
  } catch (e) {
    sendError(reply, e);
  }
});

// SEO (Etapa 1+2): server-rendered, indexovatelná stránka per firma se slug URL
// a interním prolinkováním na propojené firmy (z lokálního ownership indexu —
// levné, bez ARES volání). Globální rate-limit ať Googlebot crawluje; cache persist.
const firmaHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    const html = await cached(
      // -v2: slug canonical + interní prolinkování (Etapa 2); ignoruje Etapa-1 cache.
      `firma-seo-v2:${ico}`,
      async () => {
        const report = await fullDueDiligenceService(client, ico);
        // Interní odkazy: dceřinky/propojené firmy z indexu (O(1), bez upstream).
        const related = getChildrenByParent((report as { ico: string }).ico)
          .slice(0, 30)
          .map((childIco) => ({ ico: childIco, name: getSubjectName(childIco) }));
        return renderCompanyPage(report as never, related);
      },
      { persist: true },
    );
    reply.header("cache-control", "public, max-age=86400").type("text/html").send(html);
  } catch (e) {
    sendError(reply, e);
  }
};
app.get("/firma/:ico", firmaHandler);
app.get("/firma/:ico/:slug", firmaHandler); // slug je kosmetický; klíč je IČO, canonical → slug URL

// SEO (Etapa 3a): procházecí adresář firem — dává crawl cesty z indexovaných
// stránek na /firma (řeší orphan / "objeveno, ale neindexováno"). Stránkováno.
const DIR_PAGE_SIZE = 100;
const directoryHandler = async (req: FastifyRequest, reply: FastifyReply) => {
  const all = listSubjects();
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / DIR_PAGE_SIZE));
  const raw = Number((req.params as { n?: string }).n ?? 1);
  const page = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), totalPages) : 1;
  const items = all
    .slice((page - 1) * DIR_PAGE_SIZE, page * DIR_PAGE_SIZE)
    .map((s) => ({ ico: s.ico, name: s.obchodniJmeno }));
  reply
    .header("cache-control", "public, max-age=3600")
    .type("text/html")
    .send(renderDirectoryPage(items, page, totalPages, total));
};
app.get("/firmy", directoryHandler);
app.get("/firmy/strana/:n", directoryHandler);

// SEO: sitemap firemních stránek z inventáře (persons_index). Druhý sitemap
// vedle statického /sitemap.xml; oba jsou v robots.txt.
app.get("/sitemap-firmy.xml", async (_req: FastifyRequest, reply) => {
  const base = process.env.PUBLIC_BASE_URL ?? "https://icovazby.cz";
  const MAX = 50000; // limit URL na jeden sitemap soubor (sitemaps.org)
  const urls = listSubjects()
    .slice(0, MAX)
    .map(
      (s) =>
        `  <url><loc>${base}${firmaPath(s.ico, s.obchodniJmeno)}</loc><changefreq>monthly</changefreq></url>`,
    )
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;
  reply.header("cache-control", "public, max-age=3600").type("application/xml").send(xml);
});

app.get("/api/dd/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    const data = await cached(`dd:${ico}`, () => fullDueDiligenceService(client, ico), { persist: true, isComplete: ddComplete });
    reply.send(data);
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Fáze D: uložit / sdílet vyšetřovací plátno ────────────────────────────────
// POST uloží JSON stav grafu → vrátí krátké id; GET ho načte; /v/:id servíruje
// SPA (frontend si stav dotáhne přes /api/investigations/:id a obnoví plátno).
// #7: whitelist schéma stavu plátna — ukládáme JEN známá pole (.strict() odmítne
// cokoli navíc), ne libovolný user JSON → obrana proti junk/future stored-XSS.
const investigationStateSchema = z
  .object({
    v: z.number().int().optional(),
    icos: z.array(z.string().max(20)).max(50).optional(),
    egoPersons: z
      .array(z.object({ key: z.string().max(300), label: z.string().max(300), dob: z.string().max(20).optional() }).strict())
      .max(60)
      .optional(),
    primaryKey: z.string().max(300).nullable().optional(),
    graphLayer: z.enum(["both", "persons", "ownership"]).optional(),
    intersectMode: z.boolean().optional(),
    renderMode: z.enum(["interactive", "mermaid"]).optional(),
    includeHistorical: z.boolean().optional(),
  })
  .strict();

app.post("/api/investigations", async (req: FastifyRequest, reply) => {
  try {
    const body = req.body as { state?: unknown } | undefined;
    const parsed = investigationStateSchema.safeParse(body?.state);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Neplatný stav vyšetřování." });
    }
    const json = JSON.stringify(parsed.data);
    if (json.length > 100_000) {
      return reply.status(413).send({ error: "Stav vyšetřování je příliš velký." });
    }
    const { dbSaveInvestigation } = await import("./persons_index/db.js");
    const id = randomBytes(6).toString("base64url"); // ~8 znaků, URL-safe
    dbSaveInvestigation(id, parsed.data);
    return { id };
  } catch (e) {
    sendError(reply, e);
  }
});

app.get("/api/investigations/:id", async (req: FastifyRequest, reply) => {
  try {
    const { id } = req.params as { id: string };
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      return reply.status(400).send({ error: "Neplatné ID." });
    }
    const { dbLoadInvestigation } = await import("./persons_index/db.js");
    const inv = dbLoadInvestigation(id);
    if (!inv) return reply.status(404).send({ error: "Vyšetřování nenalezeno." });
    return { state: inv.state, createdAt: inv.createdAt };
  } catch (e) {
    sendError(reply, e);
  }
});

// Read-only sdílené plátno — servíruje stejné SPA, frontend pozná /v/:id v cestě.
app.get("/v/:id", serveIndex);

// ─── Timeline — chronologická historie firmy ─────────────────────────────────
app.get("/api/timeline/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    const data = await cached(`timeline:${ico}`, () => buildTimeline(client, ico), { persist: true });
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
// ─── Datová schránka — lookup ID podle IČO ────────────────────────────────
// Experimental scraping seznamu na mojedatovaschranka.cz (§ 14a z. 300/2008).
// Pro PO funguje, pro OSVČ/FO od 1.2.2024 vymazané = NULL.
import { getDsByIco } from "./datova_schranka/service.js";
app.get("/api/ds/:ico", async (req: FastifyRequest, reply) => {
  try {
    const { ico } = req.params as { ico: string };
    reply.send(await getDsByIco(ico));
  } catch (e) {
    sendError(reply, e);
  }
});

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
    // #2: env klíč jen pro admina; veřejný request bez BYO klíče dostane „nakonfiguruj klíč".
    const allowServerKey = adminTokenOk(headerStr("x-admin-token"));
    const result = await generateAiSummary(client, ico, { force, userApiKey, provider, model, allowServerKey });
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
    const data = await cached(`vr:${ico}`, () => getVrDetailService(ico), { persist: true });
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
    reply.send(await cached(`isir:${ico}`, () => getInsolvenceDetailService(ico), { persist: true, isComplete: hsComplete }));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Dotace (via Hlídač státu) ────────────────────────────────────────────────
app.get("/api/dotace/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await cached(`dotace:${ico}`, () => getDotaceService(ico), { persist: true, isComplete: hsComplete }));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Sbírka listin (or.justice.cz) — Fáze 1: metadata účetních závěrek ────────
app.get("/api/sbirka-listin/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await cached(`sl:${ico}`, () => getSbirkaListinService(ico), { persist: true }));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Čísla z poslední závěrky (Fáze 2: PDF → pdftotext, bez LLM) — lazy/cache ──
app.get("/api/zaverka-cisla/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await cached(`zavcisla:${ico}`, () => getZaverkaCislaService(ico), { persist: true }));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── OCR skenu (Fáze 2b: pdftoppm+tesseract) — BĚŽÍ NA POZADÍ + polling ─────────
// OCR může trvat >100 s (velká firma, víc skenů) → proxy (Cloudflare ~100 s) by
// request zabila. Proto request startne job na pozadí a vrátí {running:true};
// frontend pollne. Semafor max 1 OCR (chrání 2vCPU). Úspěch se cachuje (30 d),
// chyba krátce v paměti (ať polling nerestartuje a uživatel může zkusit znovu).
const ocrRunning = new Set<string>();
const ocrErrors = new Map<string, { error: string; ts: number }>();
app.get("/api/zaverka-ocr/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    const key = `zavocr:${ico}`;
    const hit = dbGetResponseCache(key, 30 * 24 * 60 * 60 * 1000) as { cisla?: unknown } | undefined;
    if (hit && hit.cisla) { reply.send(hit); return; } // hotovo (úspěch)
    if (ocrRunning.has(ico)) { reply.send({ applicable: true, running: true }); return; } // běží
    const err = ocrErrors.get(ico);
    if (err && Date.now() - err.ts < 3 * 60 * 1000) { reply.send({ applicable: true, error: err.error }); return; } // nedávno selhalo
    if (ocrRunning.size >= 1) { reply.send({ applicable: true, running: true, queued: true }); return; } // jiný OCR jede → ber jako běží
    // start na pozadí
    ocrRunning.add(ico);
    ocrErrors.delete(ico);
    void (async () => {
      try {
        const res = (await getZaverkaOcrService(ico)) as { cisla?: unknown; error?: string };
        if (res && res.cisla) dbSetResponseCache(key, res);
        else ocrErrors.set(ico, { error: res?.error || "OCR nic nepřečetlo.", ts: Date.now() });
      } catch (e) {
        ocrErrors.set(ico, { error: (e as Error).message, ts: Date.now() });
      } finally {
        ocrRunning.delete(ico);
      }
    })();
    reply.send({ applicable: true, running: true });
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Forenzní indikátory (Fáze 1: sídlo, bílý kůň, kruhové vlastnictví) — lazy ──
app.get("/api/forensika/:ico", expensiveCfg, async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    const adresa = (req.query as { adresa?: string })?.adresa;
    const key = `forensika:${ico}:${adresa ? "a" : "n"}`;
    reply.send(await cached(key, () => getForensikaService(client, ico, adresa), { persist: true }));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── PEP + sankce (Hodnota #2: řídicí osoby × PEP/EU sankce) — lazy/cache ───────
app.get("/api/pep-sankce/:ico", expensiveCfg, async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await cached(`pepsankce:${ico}`, () => getPepSankceService(client, ico), { persist: true, isComplete: (v) => !(v as { pepTokenMissing?: unknown } | null | undefined)?.pepTokenMissing }));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Přeshraniční vlastnictví (Hodnota #4: GLEIF LEI mateřská/dceřiné) — lazy ───
app.get("/api/cross-border/:ico", expensiveCfg, async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await cached(`crossborder:${ico}`, () => getCrossBorderService(ico), { persist: true }));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Víceletý vývoj financí (Přístup 2: řada + metriky + trendy) — lazy/cache ──
app.get("/api/zaverka-vyvoj/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await cached(`zavvyvoj:${ico}`, () => getZaverkaVyvojService(ico), { persist: true }));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Smlouvy ze Registru smluv (via Hlídač státu) ─────────────────────────────
app.get("/api/smlouvy/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await cached(`smlouvy:${ico}`, () => getSmlouvyService(ico), { persist: true, isComplete: hsComplete }));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── A2: Hlídač státu přes vlastnickou skupinu (dotace+zakázky za holding) ─────
app.get("/api/group-funding/:ico", expensiveCfg, async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await cached(`groupfunding:${ico}`, () => groupFundingService(client, ico), { persist: true }));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── UBO (skuteční majitelé via Hlídač státu) ─────────────────────────────────
app.get("/api/ubo/:ico", expensiveCfg, async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await cached(`ubo:${ico}`, () => getUboService(ico), { persist: true, isComplete: hsComplete }));
  } catch (e) {
    sendError(reply, e);
  }
});

// ─── Ownership verdikt (A1) — popisná syntéza „kdo vlastní" ────────────────────
app.get("/api/ownership-verdict/:ico", expensiveCfg, async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    // BEZ vlastní cache: syntéza je levná a čte z cachovaných sub-dat (vr:/ubo:/
    // crossborder:). Tím se verdikt self-healuje — nezůstane „nejasné" zapsané,
    // když UBO (Hlídač) zrovna selhal při prvním výpočtu.
    reply.send(await ownershipVerdictService(client, ico));
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
  config: { rateLimit: { max: HEAVY_LIMIT, timeWindow: "1 minute", allowList: isLoopbackReq } },
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
  config: { rateLimit: { max: HEAVY_LIMIT, timeWindow: "1 minute", allowList: isLoopbackReq } },
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
    (async () => {
      const t = Date.now();
      try {
        // OFAC/UN/UK snapshot (~17 s, 24 h cache) — ať první PEP/sankce screening uživatele není pomalý.
        await screenExtraSanctions(["__warmup probe__"]);
        return { name: "extra-sanctions", ok: true, ms: Date.now() - t };
      } catch (e) {
        return { name: "extra-sanctions", ok: false, ms: Date.now() - t, err: String(e) };
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

  // #6: úklid expirovaných řádků (response_cache + staré investigations) při
  // startu a pak každých 6 h, ať úložiště neroste donekonečna.
  void (async () => {
    try {
      const { dbEvictExpired } = await import("./persons_index/db.js");
      const run = () => {
        try {
          const r = dbEvictExpired();
          if (r.responseCache || r.investigations) app.log.info(`evict: -${r.responseCache} cache, -${r.investigations} investigations`);
        } catch (e) { app.log.warn({ err: e }, "evict failed"); }
      };
      run();
      setInterval(run, 6 * 60 * 60 * 1000).unref();
    } catch { /* ignore */ }
  })();

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
