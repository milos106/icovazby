import pRetry, { AbortError } from "p-retry";
import { fetch as undiciFetch } from "undici";
import {
  type AresError,
  InvalidInputError,
  NetworkError,
  NotFoundError,
  RateLimitedError,
  UpstreamError,
  mapHttpStatusToAresError,
} from "../errors.js";
import type {
  CiselnikyOdpoved,
  EkonomickeSubjektySeznam,
  EkonomickySubjekt,
  ResOdpoved,
  RzpZaznam,
  StandardizovaneAdresyOdpoved,
  VrOdpoved,
} from "./types.js";

type FetchInit = Parameters<typeof undiciFetch>[1];
type FetchResponse = Awaited<ReturnType<typeof undiciFetch>>;

const DEFAULT_BASE_URL = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest";

interface TokenBucket {
  take(): Promise<void>;
}

function createTokenBucket(ratePerSecond: number): TokenBucket {
  let tokens = ratePerSecond;
  let last = Date.now();
  const refillMs = 1000 / ratePerSecond;

  return {
    async take() {
      const now = Date.now();
      tokens = Math.min(ratePerSecond, tokens + (now - last) / refillMs);
      last = now;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - tokens) * refillMs);
      await sleep(waitMs);
      tokens = 0;
    },
  };
}

export interface AresClientOptions {
  baseUrl?: string;
  ratePerSecond?: number;
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
}

export interface SearchCompaniesParams {
  obchodniJmeno?: string;
  ico?: string[];
  sidloKodObce?: number;
  sidloPsc?: string;
  /**
   * Free-form ARES `sidlo` filter. Most usefully `{ textovaAdresa: "..." }`
   * for natural-language address search; the spec also accepts numeric codes
   * (kodObce, kodUlice, cisloDomovni, …).
   */
  sidlo?: Record<string, unknown>;
  pravniForma?: string[];
  czNace?: string[];
  pocet?: number;
  start?: number;
}

export class AresClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly bucket: TokenBucket;
  private readonly userAgent: string;

  constructor(opts: AresClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.retries = opts.retries ?? 3;
    // MFČR documents a 500 requests/minute ceiling (≈8.3 req/s) above which they
    // reserve the right to block access. We default to 5 req/s for headroom.
    this.bucket = createTokenBucket(opts.ratePerSecond ?? 5);
    this.userAgent =
      opts.userAgent ?? "ares-mcp/0.1.0 (+https://github.com/milos106/ares-mcp)";
  }

  getEconomicSubject(ico: string): Promise<EkonomickySubjekt> {
    return this.get<EkonomickySubjekt>(`/ekonomicke-subjekty/${encodeURIComponent(ico)}`);
  }

  searchEconomicSubjects(params: SearchCompaniesParams): Promise<EkonomickeSubjektySeznam> {
    return this.post<EkonomickeSubjektySeznam>("/ekonomicke-subjekty/vyhledat", params);
  }

  getVrRecord(ico: string): Promise<VrOdpoved> {
    return this.get<VrOdpoved>(`/ekonomicke-subjekty-vr/${encodeURIComponent(ico)}`);
  }

  getRzpRecord(ico: string): Promise<RzpZaznam> {
    return this.get<RzpZaznam>(`/ekonomicke-subjekty-rzp/${encodeURIComponent(ico)}`);
  }

  getResRecord(ico: string): Promise<ResOdpoved> {
    return this.get<ResOdpoved>(`/ekonomicke-subjekty-res/${encodeURIComponent(ico)}`);
  }

  searchAddresses(query: {
    textovaAdresa?: string;
    kodObce?: number;
    psc?: number;
    pocet?: number;
  }): Promise<StandardizovaneAdresyOdpoved> {
    return this.post<StandardizovaneAdresyOdpoved>("/standardizovane-adresy/vyhledat", query);
  }

  searchCiselniky(query: {
    kodCiselniku?: string;
    kodPolozky?: string;
    nazev?: string;
    pocet?: number;
  }): Promise<CiselnikyOdpoved> {
    return this.post<CiselnikyOdpoved>("/ciselniky-nazevniky/vyhledat", query);
  }

  private async get<T>(path: string): Promise<T> {
    return this.execute<T>(this.buildUrl(path), { method: "GET" });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.execute<T>(this.buildUrl(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  private buildUrl(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async execute<T>(url: string, init: FetchInit): Promise<T> {
    return pRetry(async () => this.requestOnce<T>(url, init), {
      retries: this.retries,
      minTimeout: 1000,
      maxTimeout: 30000,
      factor: 2,
      onFailedAttempt: async (err) => {
        if (err instanceof RateLimitedError && err.retryAfterSeconds) {
          await sleep(Math.min(err.retryAfterSeconds * 1000, 30000));
        }
      },
    });
  }

  private async requestOnce<T>(url: string, init: FetchInit): Promise<T> {
    await this.bucket.take();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: FetchResponse;
    try {
      response = await undiciFetch(url, {
        ...init,
        headers: {
          accept: "application/json",
          "user-agent": this.userAgent,
          ...(init?.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        throw abort(new NetworkError("Request to ARES timed out."));
      }
      throw abort(
        new NetworkError(
          `Network error while contacting ARES: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    const body = await safeReadBody(response);
    const message = extractErrorMessage(response.status, body);

    if (response.status === 404) throw abort(new NotFoundError(message));
    if (response.status === 400 || response.status === 422) {
      throw abort(new InvalidInputError(message));
    }
    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      throw new RateLimitedError(message, retryAfter);
    }
    if (response.status >= 500) {
      throw new UpstreamError(message, response.status);
    }
    throw abort(mapHttpStatusToAresError(response.status, message));
  }
}

function abort(err: AresError): AbortError {
  return new AbortError(err);
}

async function safeReadBody(response: FetchResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function extractErrorMessage(status: number, body: string): string {
  if (body) {
    try {
      const parsed = JSON.parse(body) as { kod?: string; popis?: string };
      if (parsed.popis) return parsed.popis;
      if (parsed.kod) return `${parsed.kod} (HTTP ${status})`;
    } catch {
      // ignore
    }
  }
  return `ARES returned HTTP ${status}`;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const diff = Math.ceil((date - Date.now()) / 1000);
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
