/**
 * ares-web — Fastify HTTP server exposing a Czech business-registry due-
 * diligence web app. Serves a static SPA from public/ and a small REST API
 * backed by the public ARES endpoints.
 *
 * Run: `npm run dev` (watch) or `npm run start` (built).
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { AresClient } from "./ares/client.js";
import { AresError, toToolErrorPayload } from "./errors.js";
import {
  crossCompanyPersonsService,
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

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");

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
  errorResponseBuilder: () => ({
    error: "RATE_LIMITED",
    message: "Příliš mnoho dotazů, zkuste to za chvíli.",
  }),
});

await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  prefix: "/",
  index: ["index.html"],
});

const client = new AresClient({
  baseUrl: process.env.ARES_BASE_URL,
  ratePerSecond: parseEnvNumber(process.env.ARES_RATE_PER_SECOND, 5),
  timeoutMs: parseEnvNumber(process.env.ARES_TIMEOUT_MS, 15000),
  retries: parseEnvNumber(process.env.ARES_RETRIES, 3),
});

// ─── Error handler ────────────────────────────────────────────────────────────
function sendError(reply: FastifyReply, err: unknown): void {
  if (err instanceof AresError) {
    const status = err.code === "NOT_FOUND" ? 404 : err.code === "INVALID_INPUT" ? 400 : 502;
    reply.status(status).send(toToolErrorPayload(err));
    return;
  }
  app.log.error(err as Error);
  reply.status(500).send({ error: "INTERNAL", message: "Interní chyba serveru." });
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/healthz", async () => ({
  ok: true,
  version: "0.1.0",
  uptimeSeconds: Math.floor(process.uptime()),
}));

// ─── Feature flags ────────────────────────────────────────────────────────────
// Browser reads this on init to know which optional integrations are active.
// Footer attribution for Hlídač státu (CC BY 3.0 — mandatory link) only shows
// when its token is present.
app.get("/api/features", async () => ({
  hlidacstatu: Boolean(process.env.HLIDAC_API_TOKEN),
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
app.get("/api/dd/:ico", async (req: FastifyRequest, reply) => {
  try {
    const ico = (req.params as { ico: string }).ico;
    reply.send(await fullDueDiligenceService(client, ico));
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
    reply.send(await getVrDetailService(ico));
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

// ─── Cross-company persons ────────────────────────────────────────────────────
const crossSchema = z.object({
  icos: z.array(z.string()).min(2).max(50),
  includeHistorical: z.boolean().optional(),
  emitMermaid: z.boolean().optional(),
});
app.post("/api/cross-persons", async (req: FastifyRequest, reply) => {
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

// ─── Boot ─────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`ares-web ready on http://${HOST}:${PORT}`);
  void warmup();
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
