// Procházecí adresář firem pro SEO (Etapa 3a). Dává Googlu crawl cesty z
// indexovaných stránek na /firma stránky (řeší "objeveno, ale neindexováno" /
// orphan). Stránkováno; každá strana linkuje ~100 firem + prev/next řetěz.

import { firmaPath } from "./companyPage.js";

const BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://icovazby.cz";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function dirUrl(page: number): string {
  return page <= 1 ? `${BASE_URL}/firmy` : `${BASE_URL}/firmy/strana/${page}`;
}

export interface DirItem {
  ico: string;
  name: string | null;
}

export function renderDirectoryPage(
  items: DirItem[],
  page: number,
  totalPages: number,
  total: number,
): string {
  const canonical = dirUrl(page);
  const title =
    page > 1
      ? `Adresář firem — strana ${page} z ${totalPages} | IČO vazby`
      : "Adresář českých firem — prověrka a vazby | IČO vazby";
  const desc = `Procházejte databázi ${total.toLocaleString("cs-CZ")} českých firem na IČO vazby — prověrka, statutární orgán, rizika, vazby a skuteční majitelé. Strana ${page} z ${totalPages}.`;

  const list = items
    .map(
      (c) =>
        `<li><a href="${esc(firmaPath(c.ico, c.name))}">${esc(c.name ?? `IČO ${c.ico}`)}</a> <span class="muted">(IČO ${esc(c.ico)})</span></li>`,
    )
    .join("");

  const prev = page > 1 ? `<a class="cta" href="${esc(dirUrl(page - 1))}">← Předchozí</a>` : "";
  const next =
    page < totalPages ? `<a class="cta" href="${esc(dirUrl(page + 1))}">Další →</a>` : "";
  const relPrev = page > 1 ? `<link rel="prev" href="${esc(dirUrl(page - 1))}">` : "";
  const relNext = page < totalPages ? `<link rel="next" href="${esc(dirUrl(page + 1))}">` : "";

  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${esc(canonical)}">
${relPrev}
${relNext}
<meta property="og:type" content="website">
<meta property="og:site_name" content="IČO vazby">
<meta property="og:title" content="${esc(title)}">
<meta property="og:url" content="${esc(canonical)}">
<link rel="icon" href="/favicon.svg">
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:860px;margin:0 auto;padding:24px;line-height:1.55;color:#1e293b}
  h1{font-size:1.6rem;margin:0 0 .25rem}
  .sub{color:#64748b;margin:0 0 1rem}
  .muted{color:#94a3b8}
  ul{padding-left:1.2rem;columns:2;column-gap:2rem}
  @media(max-width:600px){ul{columns:1}}
  li{margin:.15rem 0;break-inside:avoid}
  .cta{display:inline-block;margin:.4rem .6rem .4rem 0;padding:.5rem .9rem;background:#0f766e;color:#fff;border-radius:8px;text-decoration:none}
  nav.pager{margin:1.4rem 0;text-align:center}
  footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #e2e8f0;color:#64748b;font-size:.85rem}
  a{color:#0f766e}
</style>
</head>
<body>
<h1>Adresář českých firem</h1>
<p class="sub">${total.toLocaleString("cs-CZ")} firem v databázi · strana ${page} z ${totalPages}</p>
<p>Prověřte libovolnou firmu — identifikace, statutární orgán, DPH, insolvence, rizikové skóre a <a href="/pruvodce/skutecny-majitel-firmy.html">skuteční majitelé</a>. Vyhledat podle IČO nebo názvu můžete na <a href="/">úvodní stránce</a>.</p>
<ul>${list}</ul>
<nav class="pager">${prev}${next}</nav>
<footer>
<p>Zdroj: veřejné rejstříky (ARES, MF ČR, CC BY 4.0; Veřejný rejstřík, MSp ČR). Data mají informativní charakter.</p>
<p><a href="/">IČO vazby</a> · <a href="/pruvodce/jak-proverit-firmu.html">Jak prověřit firmu</a></p>
</footer>
</body>
</html>`;
}
