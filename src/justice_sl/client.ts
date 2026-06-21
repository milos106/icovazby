/**
 * Sbírka listin (or.justice.cz) — Fáze 1: jen METADATA listin (typ + roky +
 * data podání), žádné PDF, žádná čísla z výkazů.
 *
 * Zdroj: https://or.justice.cz/ias/ui/vypis-sl-firma?subjektId=<id>  (HTML).
 * subjektId získáváme z VR klienta (findSubjektIdByIco). or.justice.cz JE z
 * ivz1 dostupný (na rozdíl od verejnerejstriky.msp.gov.cz JSON API, který cloud
 * IP blokuje), takže tady proxy netřeba.
 *
 * Licence: veřejný rejstřík dle z. 304/2013 Sb. (veřejná data). Čteme jen
 * metadata, cache + lazy + poctivý user-agent.
 */
import { fetch as undiciFetch } from "undici";

const OR_BASE = (process.env.OR_JUSTICE_URL || "https://or.justice.cz").replace(/\/+$/, "");
const TIMEOUT_MS = 12000;
const UA = "ares-web/0.2 (+https://github.com/milos106/ares-web)";

export interface SlListina {
  /** Spisová značka listiny, např. "B 6626/SL276/MSPH". */
  ref: string;
  /** Typy listiny (text spanů), např. ["účetní závěrka [2024]", "výroční zpráva [2024]"]. */
  typy: string[];
  /** Roky odvozené z [RRRR] u typů. */
  roky: number[];
  /** Datum vzniku listiny (u závěrky obvykle konec období, 31.12.RRRR). */
  vznik: string | null;
  /** Datum doručení na soud. */
  doruceno: string | null;
  /** Datum uložení do sbírky (zveřejnění). */
  ulozeno: string | null;
  /** Je mezi typy účetní závěrka / rozvaha / výkaz z+z? */
  jeZaverka: boolean;
  konsolidovana: boolean;
  pocetStran: number | null;
  detailUrl: string | null;
}

const DATE_RE = /(\d{1,2}\.\d{1,2}\.\d{4})/g;
const ZAVERKA_RE = /účetní\s+závěrka|rozvaha|výkaz\s+zisku|přehled\s+o\s+(?:změnách|peněžních)/i;

function parseCzDate(s: string | null): { iso: string; year: number } | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return { iso: `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`, year: Number(y) };
}

/** Vytáhne řádky tabulky Sbírky listin z HTML. Bez DOM knihovny — řádky jsou
 *  konzistentní `<tr>` obsahující odkaz na `vypis-sl-detail`. */
function parseListiny(html: string): SlListina[] {
  const out: SlListina[] = [];
  // Rozsekej na <tr>…</tr> a ber jen ty s odkazem na detail listiny.
  const rows = html.split(/<tr[\s>]/i).slice(1);
  for (const raw of rows) {
    const row = raw.slice(0, raw.search(/<\/tr>/i) >= 0 ? raw.search(/<\/tr>/i) : raw.length);
    if (!/vypis-sl-detail/i.test(row)) continue;

    const dokM = row.match(/vypis-sl-detail\?dokument=(\d+)[^"']*/i);
    const detailUrl = dokM ? `${OR_BASE}/ias/ui/${dokM[0].replace(/&amp;/g, "&")}` : null;
    // ref = první <span> v prvním <td> (odkaz)
    const refM = row.match(/vypis-sl-detail[^>]*>\s*<span>([^<]+)<\/span>/i);
    const ref = (refM ? refM[1] : "").replace(/&nbsp;/g, " ").trim();

    const typy: string[] = [];
    const roky = new Set<number>();
    let m: RegExpExecArray | null;
    const symRe = /<span\s+class="symbol">([^<]+)<\/span>/gi;
    while ((m = symRe.exec(row))) {
      const t = m[1].replace(/&nbsp;/g, " ").trim();
      typy.push(t);
      const yr = t.match(/\[(\d{4})\]/);
      if (yr) roky.add(Number(yr[1]));
    }
    if (typy.length === 0) continue; // řádek bez typů (hlavička apod.)

    const dates = (row.replace(/<[^>]+>/g, " ").match(DATE_RE) || []).map((s) => s.trim());
    const [vznik = null, doruceno = null, ulozeno = null] = dates;
    const stranM = row.match(/<td[^>]*class="center"[^>]*>\s*(\d+)\s*<\/td>/i);

    out.push({
      ref,
      typy,
      roky: [...roky].sort((a, b) => b - a),
      vznik,
      doruceno,
      ulozeno,
      jeZaverka: typy.some((t) => ZAVERKA_RE.test(t)),
      konsolidovana: /konsolidovan/i.test(row),
      pocetStran: stranM ? Number(stranM[1]) : null,
      detailUrl,
    });
    if (out.length >= 80) break; // pojistka
  }
  return out;
}

export async function fetchSbirkaListin(subjektId: number): Promise<SlListina[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await undiciFetch(
      `${OR_BASE}/ias/ui/vypis-sl-firma?subjektId=${subjektId}`,
      { headers: { "user-agent": UA, accept: "text/html" }, signal: controller.signal },
    );
    if (!res.ok) throw new Error(`Sbírka listin HTTP ${res.status}`);
    const html = await res.text();
    return parseListiny(html);
  } finally {
    clearTimeout(timer);
  }
}

export { parseCzDate };

export const SL_ATTRIBUTION = {
  zdroj: "Sbírka listin (Veřejný rejstřík)",
  url: "https://or.justice.cz",
  licence: "Veřejná data dle zák. 304/2013 Sb.",
  pozn: "Fáze 1 — pouze metadata listin (typ a data podání), čísla z výkazů zatím nečteme.",
};
