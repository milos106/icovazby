// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TMView (EUIPN) trademark search client.
 *
 * Bez oficiálního API tokenu — používáme stejné AJAX endpointy, jaké
 * volá web aplikace tmdn.org. Endpoint je public a tichá session cookie
 * (traefik_persistence + TS01919f74) je vydána každému návštěvníkovi
 * při prvním GET na /tmview/. Cookie cachujeme ~25 min.
 *
 * Žádný OAuth flow, žádné rate limity dokumentované — držíme se ale
 * pod 2 req/s pro slušnost.
 */

const TMVIEW_BASE = "https://www.tmdn.org/tmview";
const SESSION_TTL_MS = 25 * 60 * 1000;

interface CookieJar {
  cookies: string;
  expiresAt: number;
}

let cachedSession: CookieJar | null = null;
let sessionPromise: Promise<CookieJar> | null = null;

async function fetchSession(): Promise<CookieJar> {
  const res = await fetch(`${TMVIEW_BASE}/`, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) icovazby/0.5.x (+https://icovazby.cz)",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`TMView session init: HTTP ${res.status}`);
  const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
  // Sloučit pole Set-Cookie → name=value; name=value; ...
  const pairs = setCookieHeaders
    .map((sc) => sc.split(";")[0]?.trim())
    .filter((s): s is string => !!s);
  if (pairs.length === 0) throw new Error("TMView session init: žádná cookie");
  return {
    cookies: pairs.join("; "),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
}

async function getSession(): Promise<CookieJar> {
  if (cachedSession && cachedSession.expiresAt > Date.now()) return cachedSession;
  if (sessionPromise) return sessionPromise;
  sessionPromise = fetchSession()
    .then((s) => {
      cachedSession = s;
      sessionPromise = null;
      return s;
    })
    .catch((e) => {
      sessionPromise = null;
      throw e;
    });
  return sessionPromise;
}

export interface TmViewTradeMark {
  ST13: string;
  tmName: string;
  /** 2-letter office code: CZ, EM (EU), WO, SK, ... */
  tmOffice: string;
  applicationNumber: string;
  /** Localized status: "Registered" / "Expired" / "Filed" / "Ended". */
  tradeMarkStatus: string;
  applicantName: string[];
  applicationDate?: string;
  niceClass?: number[];
  markImageURI?: string;
  detailImageURI?: string;
}

export interface TmViewSearchResponse {
  tradeMarks: TmViewTradeMark[];
  page: number;
  totalPages: number;
  totalResults: number;
}

/**
 * Volá `POST /tmview/api/search/results?translate=true` s payloadem
 * shodným s tím, co posílá frontend (Network tab DevTools).
 */
export async function searchTrademarks(opts: {
  query: string;
  /** 'C' = contains, 'E' = exact, 'S' = starts with. Default 'C'. */
  criteria?: "C" | "E" | "S";
  page?: number;
  pageSize?: number;
  /** Filtr na 2-letter office codes. Pro CZ: ['CZ', 'EM', 'WO']. */
  offices?: string[];
}): Promise<TmViewSearchResponse> {
  const session = await getSession();
  const body = {
    page: String(opts.page ?? 1),
    pageSize: String(opts.pageSize ?? 30),
    criteria: opts.criteria ?? "C",
    basicSearch: opts.query,
    fields: [
      "ST13",
      "markImageURI",
      "tmName",
      "tmOffice",
      "applicationNumber",
      "applicationDate",
      "applicantName",
      "tradeMarkStatus",
      "niceClass",
    ],
    newPage: true,
    ...(opts.offices && opts.offices.length > 0 ? { fOffices: opts.offices } : {}),
  };
  const res = await fetch(`${TMVIEW_BASE}/api/search/results?translate=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      Accept: "application/json",
      Origin: "https://www.tmdn.org",
      Referer: `${TMVIEW_BASE}/`,
      Cookie: session.cookies,
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) icovazby/0.5.x (+https://icovazby.cz)",
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    // session expired — fresh + retry once
    cachedSession = null;
    const fresh = await getSession();
    const retry = await fetch(`${TMVIEW_BASE}/api/search/results?translate=true`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        Accept: "application/json",
        Origin: "https://www.tmdn.org",
        Referer: `${TMVIEW_BASE}/`,
        Cookie: fresh.cookies,
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) icovazby/0.5.x (+https://icovazby.cz)",
      },
      body: JSON.stringify(body),
    });
    if (!retry.ok) throw new Error(`TMView search retry: HTTP ${retry.status}`);
    return await retry.json();
  }
  if (!res.ok) throw new Error(`TMView search: HTTP ${res.status}`);
  return await res.json();
}
