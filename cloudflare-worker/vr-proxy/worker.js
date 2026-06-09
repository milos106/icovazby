// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cloudflare Worker — proxy pro Veřejný rejstřík (verejnerejstriky.msp.gov.cz).
 *
 * Důvod: MSP ČR blokuje IP rozsahy cloudových providerů (Hetzner) s HTTP 403.
 * Cloudflare edge má vlastní outbound IP (AS13335), kterou MSP nezablokoval.
 * icovazby backend volá tento Worker místo VR API přímo — odpověď je tatáž,
 * jen cestou přes CF edge.
 *
 * Bezpečnost:
 *  - Whitelist cest: pouze /api/rejstriky/* (proxy nesmí být open relay).
 *  - Shared secret: header `X-Proxy-Token` musí matchovat `PROXY_TOKEN` env
 *    var, jinak 401. Předejde tomu, aby kdokoli zneužil Worker pro vlastní
 *    scraping na quotu vlastníka.
 *
 * Performance:
 *  - CF edge cache 5 min (`cf: { cacheTtl: 300 }`) — opakované dotazy na
 *    stejné IČO se vrací z CF cache, šetří MSP server.
 *  - Žádný JSON parse — body se streamuje 1:1, latence ≈ 1 hop k MSP.
 *
 * Deploy: vyžaduje účet Cloudflare + variabilní `PROXY_TOKEN` (Secret).
 * Návod: viz `cloudflare-worker/vr-proxy/README.md`.
 */

const UPSTREAM = "https://verejnerejstriky.msp.gov.cz";
const ALLOWED_PATH_PREFIX = "/api/rejstriky/";

export default {
  async fetch(request, env) {
    // 1. Method check — pro VR potřebujeme jen GET.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 2. Shared-secret auth. PROXY_TOKEN je Secret nastavený v Workers UI.
    const expected = (env.PROXY_TOKEN || "").trim();
    const provided = (request.headers.get("x-proxy-token") || "").trim();
    if (!expected) {
      return new Response("Worker not configured: PROXY_TOKEN missing", { status: 500 });
    }
    if (provided !== expected) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 3. Path whitelist — pouze /api/rejstriky/*.
    const url = new URL(request.url);
    if (!url.pathname.startsWith(ALLOWED_PATH_PREFIX)) {
      return new Response("Path not allowed", { status: 403 });
    }

    // 4. Proxy request s edge cache.
    const target = UPSTREAM + url.pathname + url.search;
    const upstreamReq = new Request(target, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "icovazby-vr-proxy/1.0 (+https://icovazby.cz)",
      },
      // CF edge cache 5 min. MSP data se v jednotkách hodin nemění.
      cf: { cacheTtl: 300, cacheEverything: true },
    });

    const upstreamRes = await fetch(upstreamReq);

    // 5. Pass-through response + CORS pro případ browser-side fetch.
    const headers = new Headers();
    headers.set("content-type", upstreamRes.headers.get("content-type") || "application/json");
    headers.set("access-control-allow-origin", "*");
    headers.set("cache-control", "public, max-age=300");
    headers.set("x-proxy-upstream-status", String(upstreamRes.status));
    // Diagnostic: ze kterého CF datacentra Worker běží (request.cf.colo = IATA
    // kód letiště, např. PRG / FRA / HAM). Pomáhá zjistit, jestli MSP blokuje
    // konkrétní geo edge — pak je možné v dashboardu zapnout Smart Placement.
    if (request.cf?.colo) headers.set("x-proxy-colo", request.cf.colo);

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers,
    });
  },
};
