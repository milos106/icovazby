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

async function downloadToTmp(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DL_TIMEOUT_MS);
  try {
    const res = await undiciFetch(url, { headers: { "user-agent": UA }, signal: controller.signal });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_PDF_BYTES || buf.length < 100) return null;
    if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return null; // jen PDF (XML/HTML přeskočíme)
    const path = join(tmpdir(), `zav-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
    await writeFile(path, buf);
    return path;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Z detailu listiny (vypis-sl-detail) najde soubory, stáhne PDF a vrátí
 *  rozvahová čísla z prvního, které rozvahu obsahuje.
 *  opts.ocr: u skenů (PDF bez textu) zkusí OCR (tesseract) — DRAHÉ, jen on-demand. */
export async function extractZaverkaCisla(
  detailUrl: string,
  rok: number | null = null,
  opts: { ocr?: boolean } = {},
): Promise<ZaverkaCisla | { error: string }> {
  let html: string;
  try {
    const res = await undiciFetch(detailUrl, { headers: { "user-agent": UA, accept: "text/html" } });
    if (!res.ok) return { error: `Detail listiny HTTP ${res.status}` };
    html = await res.text();
  } catch (e) {
    return { error: "Detail listiny nedostupný: " + (e as Error).message };
  }
  const ids = [...new Set([...html.matchAll(/\/ias\/content\/download\?id=([a-f0-9]+)/gi)].map((m) => m[1]))].slice(0, 5);
  if (ids.length === 0) return { error: "V detailu listiny nejsou soubory ke stažení." };

  const ocrTodo: Array<{ path: string; url: string }> = []; // skeny k případnému OCR
  for (const id of ids) {
    const url = `${OR_BASE}/ias/content/download?id=${id}`;
    const path = await downloadToTmp(url);
    if (!path) continue;
    let keep = false;
    try {
      const text = await run("pdftotext", ["-layout", path, "-"]);
      const parsed = parseRozvaha(text, url, rok);
      if (parsed) return parsed;
      // málo textu = pravděpodobně sken → kandidát na OCR (jen když opts.ocr)
      if (opts.ocr && text.replace(/\s/g, "").length < 200) {
        ocrTodo.push({ path, url });
        keep = true;
      }
    } catch {
      if (opts.ocr) {
        ocrTodo.push({ path, url });
        keep = true;
      }
    } finally {
      if (!keep) unlink(path).catch(() => {});
    }
  }

  // OCR fallback (drahé) — jen na explicitní žádost a jen u skenů bez textu
  if (opts.ocr) {
    for (const { path, url } of ocrTodo) {
      try {
        const text = await ocrPdfText(path);
        const parsed = parseRozvaha(text, url, rok);
        if (parsed) {
          parsed.source = "ocr";
          parsed.confidence = "low"; // OCR je vždy nejistý (záměny 0/O, 5/S, 8/B)
          return parsed;
        }
      } catch {
        /* OCR selhal → zkus další */
      } finally {
        unlink(path).catch(() => {});
      }
    }
  }
  return opts.ocr
    ? { error: "Ani OCR čísla nepřečetl — sken je nečitelný nebo netypická forma. Otevři PDF ručně." }
    : { error: "Čísla z výkazů se nepodařilo přečíst (sken nebo strukturovaný formát) — otevři PDF ručně." };
}
