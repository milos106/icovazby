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
import { join, basename } from "node:path";

const OR_BASE = (process.env.OR_JUSTICE_URL || "https://or.justice.cz").replace(/\/+$/, "");
const UA = "ares-web/0.2 (+https://github.com/milos106/ares-web)";
const MAX_PDF_BYTES = 30 * 1024 * 1024; // 30 MB strop
const DL_TIMEOUT_MS = 25000;

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

function valuesForLabel(text: string, labels: RegExp[]): [number | null, number | null] {
  for (const line of text.split("\n")) {
    for (const re of labels) {
      if (re.test(line)) {
        const after = line.replace(re, " ");
        const toks = after.match(NUM_TOKEN) || [];
        if (toks.length >= 2) {
          // Bereme POSLEDNÍ dva tokeny = Netto běžné + Netto minulé. Funguje pro
          // standardní rozvahu (č.ř./Brutto/Korekce/Netto/MinuléNetto) i IFRS
          // (jen 2 sloupce). První tokeny u standardní rozvahy = č.ř./Brutto.
          return [toNum(toks[toks.length - 2]), toNum(toks[toks.length - 1])];
        }
        if (toks.length === 1) return [toNum(toks[0]), null];
      }
    }
  }
  return [null, null];
}

/** Parsuje rozvahu/výsledovku z layout textu. Vrátí null, když to není rozvaha. */
function parseRozvaha(text: string, pdfUrl: string, rok: number | null): ZaverkaCisla | null {
  const aktiva = valuesForLabel(text, [/\bAKTIVA\s+CELKEM\b/i, /\bAktiva celkem\b/i]);
  if (aktiva[0] == null) return null; // bez „Aktiva celkem" to není rozvaha

  // „Vlastní kapitál a závazky" NEbrat jako kapitál ani cizí zdroje (= pasiva celkem).
  const vk = valuesForLabel(text, [/Vlastní kapitál\s+celkem(?!\s+a)/i, /Vlastní kapitál\b(?!\s+a\b)/i]);
  const cizi = valuesForLabel(text, [/Cizí zdroje\b/i]);
  const vh = valuesForLabel(text, [
    /Výsledek hospodaření za účetní období/i, /Výsledek hospodaření za běžné/i,
    /Výsledek hospodaření po zdanění/i, /Čistý zisk za období/i, /Zisk po zdanění/i, /Zisk za rok/i,
  ]);
  const trzby = valuesForLabel(text, [/Tržby z prodeje výrobků a služeb/i, /Tržby za prodej vlastních výrobků/i, /Tržby celkem/i]);

  const jednotka: "tis. Kč" | "Kč" = /v\s+(?:tis(?:íc)?\.?|celých\s+tis)/i.test(text) ? "tis. Kč" : "Kč";
  const maxY = rok; // rok z metadat Sbírky listin (spolehlivé, neparsujeme z PDF)

  // confidence: Aktiva ≈ pasiva (VK + cizí) v rozumné toleranci
  let confidence: "high" | "low" = "low";
  if (aktiva[0] != null && vk[0] != null && cizi[0] != null) {
    const pasiva = (vk[0] || 0) + (cizi[0] || 0);
    if (aktiva[0] > 0 && Math.abs(pasiva - aktiva[0]) / aktiva[0] < 0.02) confidence = "high";
  } else if (aktiva[0] != null && vh[0] != null) {
    confidence = "low";
  }

  return {
    obdobi: { bezne: maxY, minule: maxY ? maxY - 1 : null },
    jednotka,
    aktivaCelkem: aktiva,
    vlastniKapital: vk,
    ciziZdroje: cizi,
    vysledekHospodareni: vh,
    trzby,
    confidence,
    zdrojPdfUrl: pdfUrl,
  };
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
    const prefix = join(dir, `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}-p${pg}`);
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
          const path = join(tmpdir(), `zav-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
          await writeFile(path, buf);
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
  const urls: string[] = [];
  for (const du of detailUrls) {
    try {
      const res = await undiciFetch(du, { headers: { "user-agent": UA, accept: "text/html" } });
      if (!res.ok) continue;
      const sc = res.headers.get("set-cookie");
      if (sc && !cookie) cookie = sc.split(";")[0];
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

  let combined = ""; // text všech čitelných souborů → rozvaha i výkaz pohromadě
  const ocrTodo: Array<{ path: string; url: string }> = [];
  const firstUrl = files[0]!.url;
  for (const { path, url } of files) {
    let keep = false;
    try {
      const text = await run("pdftotext", ["-layout", path, "-"]);
      combined += "\n" + text;
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

  let parsed = parseRozvaha(combined, firstUrl, rok);
  if (parsed) return parsed;

  // OCR fallback (drahé) — jen na žádost a jen u skenů; OCR text přidáme k textovému.
  if (opts.ocr && ocrTodo.length) {
    for (const { path } of ocrTodo) {
      try {
        combined += "\n" + (await ocrPdfText(path));
      } catch {
        /* OCR strany selhal */
      } finally {
        unlink(path).catch(() => {});
      }
    }
    parsed = parseRozvaha(combined, firstUrl, rok);
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
