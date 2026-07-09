// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fáze 2 — čísla z účetní závěrky BEZ LLM.
 *
 * Realita Sbírky listin: jedna „účetní závěrka [rok]" listina = obvykle VÍC
 * souborů (digitální podoba / rozvaha / výsledovka / příloha PDF / XML). Hlavní
 * PDF bývá jen příloha. Proto stáhneme VŠECHNY soubory listiny a parsujeme ten,
 * který obsahuje rozvahu (najdeme „Aktiva celkem" / IFRS ekvivalent).
 *
 * Extrakce textu: `pdftotext -layout` (poppler) — drží sloupce (běžné / minulé
 * období) zarovnané, takže z JEDNOHO PDF získáme dva roky. Skeny (PDF bez textu)
 * a strukturované XML „digitální podoby" zatím nepokrýváme (Fáze 2b: OCR / XML).
 */
import { fetch as undiciFetch } from "undici";
import { execFile } from "node:child_process";
import { writeFile, unlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join, basename } from "node:path";

const OR_BASE = (process.env.OR_JUSTICE_URL || "https://or.justice.cz").replace(/\/+$/, "");
const UA = "ares-web/0.2 (+https://github.com/milos106/ares-web)";
const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30 MB strop
const DL_TIMEOUT_MS = 25000;

// undici: set-cookie NELZE číst přes headers.get("set-cookie") (Fetch spec ho z
// get() filtruje → vrací null). Správně je getSetCookie(). Bereme první cookie
// (name=value) — u or.justice je to BIG-IP routing cookie NUTNÁ pro stažení PDF;
// bez ní backend u části souborů vrátí HTML místo PDF.
function firstSetCookie(h: { getSetCookie?: () => string[] }): string | undefined {
  const arr = h.getSetCookie?.() ?? [];
  return arr.length ? arr[0]!.split(";")[0] : undefined;
}

export interface ZaverkaCisla {
  obdobi: { bezne: number | null; minule: number | null };
  jednotka: "tis. Kč" | "Kč";
  aktivaCelkem: [number | null, number | null];
  vlastniKapital: [number | null, number | null];
  ciziZdroje: [number | null, number | null];
  vysledekHospodareni: [number | null, number | null];
  trzby: [number | null, number | null];
  confidence: "high" | "low";
  zdrojPdfUrl: string;
  source?: "text" | "ocr"; // ocr = čteno ze skenu přes tesseract (experimentální)
  precteno?: number; // kolik z 5 klíčových polí se podařilo přečíst
  chybi?: string[]; // názvy nepřečtených polí (pro „kompletnost" v UI)
}

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/** „203 562 776" / „-1 234" / „(1 234)" → number (záporné v závorkách/minusem). */
function toNum(s: string | undefined): number | null {
  if (!s) return null;
  const neg = /^[(-]/.test(s.trim());
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  return neg ? -Number(digits) : Number(digits);
}

// Číselný token: kompaktní běh číslic ("3182" u malých firem) NEBO skupiny 3 číslic
// oddělené JEDNOU mezerou (nbsp i obyč.) u velkých čísel ("3 182 456"). Volitelně
// minus / závorka. Víc-mezerový rozestup = oddělení sloupců.
// (\d+ místo \d{1,3} — jinak se 4místné číslo bez oddělovače rozseká na 3+1.)
const NUM_TOKEN = /[(-]?\d+(?:[  ]\d{3})*\)?/g;

/**
 * Vytáhne [běžné, minulé] hodnotu jednoho pole. Dvě strategie:
 *  1) podle POPISKU (specifické regexy) — primární,
 *  2) č.ř. KOTVA (univerzální dle vyhlášky 500/2002) — když popisek selže: na řádku
 *     s „crHint" (široké klíčové slovo, aby se ve spojeném textu nepletla pole se
 *     stejným č.ř., např. aktiva×tržby = č.ř. 1) vezmi řádek, kde VEDOUCÍ číslo = č.ř.
 *  Vždy bere POSLEDNÍ dva tokeny = Netto běžné + Netto minulé (plná rozvaha i IFRS).
 */
function valuesFor(
  text: string,
  opts: { labels: RegExp[]; cr?: number[]; crHint?: RegExp },
): [number | null, number | null] {
  const lines = text.split("\n");
  for (const line of lines) {
    for (const re of opts.labels) {
      if (re.test(line)) {
        const toks = line.replace(re, " ").match(NUM_TOKEN) || [];
        if (toks.length >= 2) return [toNum(toks[toks.length - 2]), toNum(toks[toks.length - 1])];
        if (toks.length === 1) return [toNum(toks[0]), null];
      }
    }
  }
  if (opts.cr?.length && opts.crHint) {
    for (const line of lines) {
      if (!opts.crHint.test(line)) continue;
      const toks = line.match(NUM_TOKEN) || [];
      if (toks.length >= 3 && opts.cr.includes(Number(toNum(toks[0])))) {
        return [toNum(toks[toks.length - 2]), toNum(toks[toks.length - 1])];
      }
    }
  }
  return [null, null];
}

const ZAV_POLE = ["Aktiva", "Vlastní kapitál", "Cizí zdroje", "Výsledek hosp.", "Tržby"] as const;

type Pair = [number | null, number | null];
interface Fields { aktiva: Pair; vk: Pair; cizi: Pair; vh: Pair; trzby: Pair }

/** Aktiva ≈ pasiva (VK + cizí) v rozumné toleranci — bilanční kontrola. */
const balances = (a: number | null, v: number | null, c: number | null): boolean =>
  a != null && v != null && c != null && a > 0 && Math.abs(v + c - a) / a < 0.02;

/** Vytáhne surová pole z JEDNOHO textu (bez confidence/balení). Sdílené single/multi. */
function extractFields(text: string): Fields {
  // „Vlastní kapitál a závazky" NEbrat jako kapitál ani cizí zdroje (= pasiva celkem).
  const aktiva = valuesFor(text, {
    labels: [/\bAKTIVA\s+CELKEM\b/i, /\bAktiva celkem\b/i, /Celková\s+aktiva/i, /Aktiva\s+celkem/i],
    cr: [1], crHint: /aktiv/i,
  });
  const vk = valuesFor(text, {
    labels: [/Vlastní kapitál\s+celkem(?!\s+a)/i, /Vlastní kapitál\b(?!\s+a\b)/i, /Vlastní jmění/i],
    crHint: /vlastní kapitál|vlastní jmění/i,
  });
  const cizi = valuesFor(text, {
    // „Vlastní kapitál a závazky celkem" = pasiva celkem (≈ aktiva) → NEbrat (lookbehind).
    labels: [/Cizí zdroje\b/i, /(?<!kapitál a )Závazky\s+celkem/i, /Cizí kapitál/i],
    crHint: /cizí zdroj|cizí kapitál/i,
  });
  const vh = valuesFor(text, {
    labels: [
      /Výsledek hospodaření za účetní období/i, /Výsledek hospodaření za běžné/i,
      /Výsledek hospodaření po zdanění/i, /Čistý zisk za období/i, /Zisk po zdanění/i,
      /Zisk za rok/i, /Čistý zisk\b/i, /Hospodářský výsledek za účetní/i,
    ],
    cr: [55, 53], crHint: /výsledek hospodaření za účetní|čistý zisk|po zdanění/i,
  });
  const trzby = valuesFor(text, {
    labels: [
      /Tržby z prodeje výrobků a služeb/i, // č.ř. 01 (vyhláška 500/2002 od 2016)
      /Tržby za prodej vlastních výrobků a služeb/i, // starší plná forma
      /Tržby za prodej vlastních výrobků/i,
      /Tržby za prodej zboží/i, // č.ř. 02 — obchodní firmy (dřív jen výrobky/služby)
      /Tržby z prodeje zboží/i,
      /Tržby celkem/i,
      /Tržby z prodeje vlastních/i,
      /\bVýkony\b/i, // předvyhláškový agregát tržeb (NE „Výkonová spotřeba" = náklad)
    ],
    cr: [1, 2], crHint: /tržby z prodeje|tržby za prod|\bvýkony\b/i,
  });

  // #3 Konzistenční gate per pole — radši mezeru než tiché špatné číslo:
  for (const col of [0, 1] as const) {
    // aktiva ≤ 0 je nereálné (každá firma má aktiva > 0) → zahoď
    if (aktiva[col] != null && (aktiva[col] as number) <= 0) aktiva[col] = null;
    // „Cizí zdroje" == aktiva = chytlo „Vlastní kapitál a závazky celkem" (pasiva celkem) → zahoď
    if (cizi[col] != null && aktiva[col] != null && cizi[col] === aktiva[col]) cizi[col] = null;
    // VK == aktiva = stejná záměna → zahoď
    if (vk[col] != null && aktiva[col] != null && vk[col] === aktiva[col]) vk[col] = null;
  }
  return { aktiva, vk, cizi, vh, trzby };
}

/** Zabalí pole do výsledku (precteno/chybi/jednotka/confidence). */
function packageResult(f: Fields, unitText: string, pdfUrl: string, rok: number | null): ZaverkaCisla | null {
  const fields = [f.aktiva, f.vk, f.cizi, f.vh, f.trzby];
  const precteno = fields.filter((v) => v[0] != null).length;
  if (precteno === 0) return null; // úplně nečitelné (sken / strukturovaný formát / netypická forma)
  const chybi = ZAV_POLE.filter((_, i) => fields[i]![0] == null) as unknown as string[];
  const jednotka: "tis. Kč" | "Kč" = /v\s+(?:tis(?:íc)?\.?|celých\s+tis)/i.test(unitText) ? "tis. Kč" : "Kč";
  const maxY = rok; // rok z metadat Sbírky listin (spolehlivé, neparsujeme z PDF)
  const confidence: "high" | "low" = balances(f.aktiva[0], f.vk[0], f.cizi[0]) ? "high" : "low";
  return {
    obdobi: { bezne: maxY, minule: maxY ? maxY - 1 : null },
    jednotka,
    aktivaCelkem: f.aktiva,
    vlastniKapital: f.vk,
    ciziZdroje: f.cizi,
    vysledekHospodareni: f.vh,
    trzby: f.trzby,
    confidence,
    zdrojPdfUrl: pdfUrl,
    precteno,
    chybi,
  };
}

/** Parsuje z JEDNOHO textu (zpětně kompatibilní — OCR cesta / fallback / testy). */
export function parseRozvaha(text: string, pdfUrl: string, rok: number | null): ZaverkaCisla | null {
  return packageResult(extractFields(text), text, pdfUrl, rok);
}

/**
 * Parsuje z VÍCE souborů jedné listiny. Řeší závěrky, kde je současně konsolidovaná
 * i nekonsolidovaná (individuální) rozvaha (AGROFERT ap.): parsování spojeného textu
 * bere první výskyt polí, takže se křížově pomíchají (aktiva z konsolidované, cizí
 * zdroje z jiného výkazu → aktiva ≠ pasiva). Vybere bilanční blok, který SEDÍ
 * (aktiva ≈ VK+cizí), s preferencí NEkonsolidované (konzistence napříč roky);
 * tržby/VH doplní z libovolného souboru. Když nic nesedí → fallback na spojený text.
 */
export function parseRozvahaMulti(texts: string[], pdfUrl: string, rok: number | null): ZaverkaCisla | null {
  const combined = texts.join("\n");
  const files = texts
    .filter((t) => t && t.replace(/\s/g, "").length >= 40)
    .map((t) => ({
      f: extractFields(t),
      // nekonsolidovaná = explicitní marker, nebo prostě text bez zmínky o konsolidaci
      nekon: /nekonsolidovan|sestaven[aá] jako nekonsolidovan/i.test(t) || !/konsolidovan/i.test(t),
    }));

  // bilanční bloky, které sedí; preferuj nekonsolidované, při shodě větší aktiva.
  const balancing = files
    .filter((x) => balances(x.f.aktiva[0], x.f.vk[0], x.f.cizi[0]))
    .sort((a, b) => (a.nekon === b.nekon ? (b.f.aktiva[0]! - a.f.aktiva[0]!) : a.nekon ? -1 : 1));

  const combinedFields = extractFields(combined);
  const bal = balancing[0]?.f;
  // tržby/VH: z vybraného bilančního bloku, jinak první dostupné napříč soubory, jinak spojený text
  const pick = (sel: (f: Fields) => Pair): Pair => {
    if (bal && sel(bal)[0] != null) return sel(bal);
    for (const x of files) if (sel(x.f)[0] != null) return sel(x.f);
    return sel(combinedFields);
  };
  const merged: Fields = bal
    ? { aktiva: bal.aktiva, vk: bal.vk, cizi: bal.cizi, vh: pick((f) => f.vh), trzby: pick((f) => f.trzby) }
    : combinedFields; // nic nesedí → staré chování (první výskyt ze spojeného textu)

  return packageResult(merged, combined, pdfUrl, rok);
}

const OCR_MAX_PAGES = 6; // strop (bound ~60s); u velkých závěrek je rozvaha za úvodem/auditem
const OCR_DPI = "400"; // nativní skeny ~150 DPI → 400 dá tesseractu dost pixelů

/**
 * Z tesseract TSV (slova + x-souřadnice) rekonstruuje layout-zarovnaný text:
 * v rámci čísla je mezi slovy malá mezera ("13 996"), mezi SLOUPCI velká → vloží
 * víc mezer. Tím dostaneme stejný tvar jako `pdftotext -layout` a můžeme použít
 * STEJNÝ parseRozvaha. (Klíčové: OCR jinak slije sloupcové mezery na jednu a
 * „13 996 4618" se spojí na „13 996 461"+„8".)
 */
function tsvToLayoutText(tsv: string): string {
  interface W { key: string; left: number; width: number; height: number; text: string }
  const words: W[] = [];
  for (const r of tsv.split("\n").slice(1)) {
    const c = r.split("\t");
    if (c.length < 12) continue;
    const conf = parseFloat(c[10]);
    const text = c[11];
    if (!(conf >= 0) || !text || !text.trim()) continue;
    words.push({ key: `${c[2]}-${c[3]}-${c[4]}`, left: +c[6], width: +c[8], height: +c[9], text });
  }
  const byLine = new Map<string, W[]>();
  for (const w of words) {
    const arr = byLine.get(w.key);
    if (arr) arr.push(w);
    else byLine.set(w.key, [w]);
  }
  const lines: string[] = [];
  for (const ws of byLine.values()) {
    ws.sort((a, b) => a.left - b.left);
    const heights = ws.map((w) => w.height).sort((a, b) => a - b);
    const medH = heights[Math.floor(heights.length / 2)] || 30;
    const thr = medH * 1.6; // x-mezera > ~1,6× výška písma = nový sloupec
    let line = ws[0].text;
    for (let i = 1; i < ws.length; i++) {
      const gap = ws[i].left - (ws[i - 1].left + ws[i - 1].width);
      line += (gap > thr ? "    " : " ") + ws[i].text;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** Sken → text: rasterizace pdftoppm + tesseract (cs, TSV→layout). Drahé (CPU),
 *  jen on-demand. Jede STRANU PO STRANĚ a zastaví se, jakmile najde rozvahu
 *  (aktiva+pasiva) — tím je levné pro běžné formy (1 str) a přitom dosáhne i na
 *  rozvahu schovanou za úvodem/auditem u velkých závěrek (strop OCR_MAX_PAGES). */
async function ocrPdfText(path: string): Promise<string> {
  const dir = tmpdir();
  let text = "";
  for (let pg = 1; pg <= OCR_MAX_PAGES; pg++) {
    const prefix = join(dir, `ocr-${randomBytes(12).toString("hex")}-p${pg}`);
    const base = basename(prefix);
    try {
      await run("pdftoppm", ["-png", "-r", OCR_DPI, "-f", String(pg), "-l", String(pg), path, prefix]);
    } catch {
      break; // strana nad rámec dokumentu / chyba
    }
    let img: string | null = null;
    try {
      const f = (await readdir(dir)).find((x) => x.startsWith(base) && x.endsWith(".png"));
      if (!f) break; // už nejsou další strany
      img = join(dir, f);
      // psm 4 + TSV → x-souřadnice slov → rekonstrukce sloupců (jinak OCR slije
      // sloupcové mezery a čísla se spojí).
      const tsv = await run("tesseract", [img, "stdout", "-l", "ces", "--psm", "4", "tsv"]);
      text += tsvToLayoutText(tsv) + "\n";
    } catch {
      /* strana selhala → zkus další */
    } finally {
      if (img) unlink(img).catch(() => {});
    }
    // našli jsme rozvahu (aktiva i pasiva) → dál už OCR nepotřebujeme
    if (/AKTIVA\s+CELKEM/i.test(text) && /(PASIVA\s+CELKEM|Vlastní kapitál)/i.test(text)) break;
  }
  return text;
}

// Stažení PDF. or.justice tokeny občas vrátí HTML místo PDF (session/rate) → posíláme
// JSESSIONID cookie z detail stránky a jednou zkusíme znovu (transient).
async function downloadToTmp(url: string, cookie?: string): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DL_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { "user-agent": UA };
      if (cookie) headers.cookie = cookie;
      const res = await undiciFetch(url, { headers, signal: controller.signal });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length <= MAX_PDF_BYTES && buf.length >= 100 && buf.subarray(0, 5).toString("latin1") === "%PDF-") {
          const path = join(tmpdir(), `zav-${randomBytes(12).toString("hex")}.pdf`);
          await writeFile(path, buf, { flag: "wx" }); // wx = selže přes pre-planted symlink (anti-race)
          return path;
        }
        // dostali jsme HTML/XML (ne PDF) → krátká pauza a retry s cookie
      }
    } catch {
      /* síťová chyba → retry */
    } finally {
      clearTimeout(timer);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 400 + attempt * 400));
  }
  return null;
}

/** Projde detail stránky, sebere file-id a JEDNU session cookie (BIG-IP routing).
 *  Některé detaily cookie nenastaví → sdílíme tu, co dá kterýkoli detail, jinak by
 *  stažení takových souborů občas vrátilo HTML místo PDF. */
async function collectFileUrls(detailUrls: string[]): Promise<{ urls: string[]; cookie?: string }> {
  let cookie: string | undefined;
  // Prime session přes výpis firmy — spolehlivě nastaví BIG-IP cookie (routing na
  // správný backend), takže následné stažení nevrací HTML místo PDF. (Jako `curl -c jar`.)
  // Prime opakuj — or.justice cookie občas nevrátí hned; bez ní část souborů
  // (typicky nekonsolidovaná závěrka) vrací HTML místo PDF.
  const subj = detailUrls[0]?.match(/subjektId=(\d+)/)?.[1];
  for (let a = 0; subj && a < 3 && !cookie; a++) {
    try {
      const res = await undiciFetch(`${OR_BASE}/ias/ui/vypis-sl-firma?subjektId=${subj}`, { headers: { "user-agent": UA, accept: "text/html" } });
      cookie = firstSetCookie(res.headers);
      await res.text();
    } catch {
      /* prime selhal → zkus znovu */
    }
    if (!cookie) await new Promise((r) => setTimeout(r, 400));
  }
  const urls: string[] = [];
  for (const du of detailUrls) {
    try {
      const res = await undiciFetch(du, { headers: { "user-agent": UA, accept: "text/html", ...(cookie ? { cookie } : {}) } });
      if (!res.ok) continue;
      if (!cookie) cookie = firstSetCookie(res.headers);
      const html = await res.text();
      for (const m of html.matchAll(/\/ias\/content\/download\?id=([a-f0-9]+)/gi)) {
        urls.push(`${OR_BASE}/ias/content/download?id=${m[1]}`);
      }
    } catch {
      /* detail nedostupný → další */
    }
    if (urls.length >= 8) break;
  }
  return { urls: [...new Set(urls)].slice(0, 8), cookie };
}

/** Z listin(y) jednoho roku stáhne PDF a vrátí čísla. Rozvahu (aktiva/VK/cizí) a
 *  výsledovku (tržby/VH) firmy podávají často jako SAMOSTATNÉ listiny → bereme víc
 *  detailUrls, text spojíme a parsujeme dohromady (jinak chytneme jen jednu a aktiva
 *  chybí). opts.ocr: u skenů zkusí OCR (tesseract) — DRAHÉ, jen on-demand. */
export async function extractZaverkaCisla(
  detailUrl: string | string[],
  rok: number | null = null,
  opts: { ocr?: boolean } = {},
): Promise<ZaverkaCisla | { error: string }> {
  const detailUrls = (Array.isArray(detailUrl) ? detailUrl : [detailUrl]).filter(Boolean).slice(0, 4);
  if (detailUrls.length === 0) return { error: "Chybí odkaz na listinu." };

  const { urls: fileUrls, cookie } = await collectFileUrls(detailUrls);
  const files: Array<{ path: string; url: string }> = [];
  for (const url of fileUrls) {
    const path = await downloadToTmp(url, cookie); // sdílená cookie napříč soubory
    if (path) files.push({ path, url });
  }
  if (files.length === 0) return { error: "Soubory listiny se nepodařilo stáhnout (token vypršel / sken / formát)." };

  const texts: string[] = []; // text PER SOUBOR → parseRozvahaMulti vybere konzistentní bilanci
  const ocrTodo: Array<{ path: string; url: string }> = [];
  const firstUrl = files[0]!.url;
  for (const { path, url } of files) {
    let keep = false;
    try {
      const text = await run("pdftotext", ["-layout", path, "-"]);
      texts.push(text);
      if (opts.ocr && text.replace(/\s/g, "").length < 200) {
        ocrTodo.push({ path, url });
        keep = true; // sken → necháme soubor pro OCR
      }
    } catch {
      if (opts.ocr) { ocrTodo.push({ path, url }); keep = true; }
    } finally {
      if (!keep) unlink(path).catch(() => {});
    }
  }

  let parsed = parseRozvahaMulti(texts, firstUrl, rok);
  if (parsed) return parsed;

  // OCR fallback (drahé) — jen na žádost a jen u skenů; OCR text přidáme jako další soubor.
  if (opts.ocr && ocrTodo.length) {
    for (const { path } of ocrTodo) {
      try {
        texts.push(await ocrPdfText(path));
      } catch {
        /* OCR strany selhal */
      } finally {
        unlink(path).catch(() => {});
      }
    }
    parsed = parseRozvahaMulti(texts, firstUrl, rok);
    if (parsed) {
      parsed.source = "ocr";
      parsed.confidence = "low"; // OCR je vždy nejistý (záměny 0/O, 5/S, 8/B)
      return parsed;
    }
  }
  return opts.ocr
    ? { error: "Ani OCR čísla nepřečetl — sken je nečitelný nebo netypická forma. Otevři PDF ručně." }
    : { error: "Čísla z výkazů se nepodařilo přečíst (sken nebo strukturovaný formát) — otevři PDF ručně." };
}

