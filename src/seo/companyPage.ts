// Server-rendered, indexovatelná stránka per firma pro SEO (Etapa 1).
// Bere výstup fullDueDiligenceService a renderuje sémantické HTML s
// firma-specifickým <title>/meta/OG + JSON-LD schema.org/Organization.
// Záměrně bez CDN/JS závislostí — lehká, rychlá, dobře indexovatelná.

const BASE_URL = process.env.PUBLIC_BASE_URL ?? "https://icovazby.cz";

interface DdLike {
  ico: string;
  obchodniJmeno: string | null;
  risk: { level: "green" | "yellow" | "red"; findings: { level: string; message: string }[] };
  identification: {
    pravniForma?: string | null;
    datumVzniku?: string | null;
    datumZaniku?: string | null;
    sidloText?: string | null;
    czNace?: string[] | null;
  };
  vat: { platceDph: boolean; dic: string | null };
  statutary: {
    aktivniCount: number;
    clenove: { organ?: string | null; funkce?: string | null; jmeno?: string | null }[];
  };
  trade_licenses: { total: number; aktivni: number; predmety: string[] };
  insolvenci: { isInsolvent: boolean; hadHistory: boolean };
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const RISK = {
  green: { emoji: "🟢", label: "nízké", color: "#059669" },
  yellow: { emoji: "🟡", label: "střední", color: "#d97706" },
  red: { emoji: "🔴", label: "zvýšené", color: "#dc2626" },
} as const;

function metaDescription(r: DdLike): string {
  const parts: string[] = [`${r.obchodniJmeno ?? "Firma"} (IČO ${r.ico})`];
  if (r.identification.pravniForma) parts.push(r.identification.pravniForma);
  if (r.identification.sidloText) parts.push(r.identification.sidloText);
  const tail: string[] = [`rizikové skóre ${RISK[r.risk.level].label}`];
  if (r.statutary.aktivniCount) tail.push(`${r.statutary.aktivniCount} ve statutárním orgánu`);
  if (r.vat.platceDph) tail.push("plátce DPH");
  if (r.insolvenci.isInsolvent) tail.push("aktivní insolvence");
  return `${parts.join(", ")}. ${tail.join(", ")}. Prověřte vazby, skutečné majitele, dotace a veřejné zakázky na IČO vazby.`.slice(
    0,
    300,
  );
}

function jsonLd(r: DdLike, url: string): string {
  const org: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: r.obchodniJmeno ?? `IČO ${r.ico}`,
    identifier: r.ico,
    url,
  };
  if (r.identification.sidloText) org.address = r.identification.sidloText;
  if (r.identification.datumVzniku) org.foundingDate = r.identification.datumVzniku;
  if (r.vat.dic) org.vatID = r.vat.dic;
  return JSON.stringify(org);
}

export function renderCompanyPage(report: DdLike): string {
  const r = report;
  const name = r.obchodniJmeno ?? `IČO ${r.ico}`;
  const url = `${BASE_URL}/firma/${encodeURIComponent(r.ico)}`;
  const risk = RISK[r.risk.level];
  const title = `${name} (IČO ${r.ico}) — prověrka, vazby a rizika | IČO vazby`;
  const desc = metaDescription(r);

  const findings = r.risk.findings
    .map((f) => {
      const icon = f.level === "red" ? "🚨" : f.level === "yellow" ? "⚠️" : "✅";
      return `<li>${icon} ${esc(f.message)}</li>`;
    })
    .join("");

  const clenove = r.statutary.clenove
    .filter((m) => m.jmeno)
    .map(
      (m) =>
        `<li><strong>${esc(m.jmeno)}</strong>${m.funkce ? ` — ${esc(m.funkce)}` : ""}${
          m.organ ? ` <span class="muted">(${esc(m.organ)})</span>` : ""
        }</li>`,
    )
    .join("");

  const nace = (r.identification.czNace ?? []).slice(0, 8).map(esc).join(", ");
  const predmety = r.trade_licenses.predmety.slice(0, 10).map(esc).join(", ");

  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="IČO vazby">
<meta property="og:title" content="${esc(name)} — IČO ${esc(r.ico)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="/favicon.svg">
<script type="application/ld+json">${jsonLd(r, url)}</script>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:860px;margin:0 auto;padding:24px;line-height:1.55;color:#1e293b}
  h1{font-size:1.6rem;margin:0 0 .25rem}
  h2{font-size:1.15rem;margin:1.6rem 0 .5rem;border-bottom:1px solid #e2e8f0;padding-bottom:.25rem}
  .sub{color:#64748b;margin:0 0 1rem}
  .muted{color:#94a3b8}
  .badge{display:inline-block;padding:.2rem .6rem;border-radius:999px;font-weight:600;color:#fff}
  ul{padding-left:1.2rem}
  .cta{display:inline-block;margin:.4rem .6rem .4rem 0;padding:.5rem .9rem;background:#0f766e;color:#fff;border-radius:8px;text-decoration:none}
  .cta.secondary{background:#475569}
  footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #e2e8f0;color:#64748b;font-size:.85rem}
  a{color:#0f766e}
</style>
</head>
<body>
<h1>${esc(name)}</h1>
<p class="sub">IČO ${esc(r.ico)}${r.identification.pravniForma ? ` · ${esc(r.identification.pravniForma)}` : ""}${
    r.identification.sidloText ? ` · ${esc(r.identification.sidloText)}` : ""
  }</p>

<p><span class="badge" style="background:${risk.color}">${risk.emoji} Rizikové skóre: ${risk.label.toUpperCase()}</span></p>
${findings ? `<ul>${findings}</ul>` : ""}

<p>
  <a class="cta" href="/?ico=${encodeURIComponent(r.ico)}&amp;action=profil">Interaktivní profil + mapa vazeb →</a>
  <a class="cta secondary" href="/report/${encodeURIComponent(r.ico)}">Tisková prověrka (PDF)</a>
</p>

<h2>Identifikace</h2>
<ul>
  <li>IČO: <strong>${esc(r.ico)}</strong></li>
  ${r.identification.pravniForma ? `<li>Právní forma: ${esc(r.identification.pravniForma)}</li>` : ""}
  ${r.identification.datumVzniku ? `<li>Datum vzniku: ${esc(r.identification.datumVzniku)}</li>` : ""}
  ${r.identification.datumZaniku ? `<li>Datum zániku: ${esc(r.identification.datumZaniku)}</li>` : ""}
  ${r.identification.sidloText ? `<li>Sídlo: ${esc(r.identification.sidloText)}</li>` : ""}
  ${nace ? `<li>CZ-NACE: ${nace}</li>` : ""}
</ul>

<h2>DPH</h2>
<p>${r.vat.platceDph ? `Plátce DPH${r.vat.dic ? ` (DIČ ${esc(r.vat.dic)})` : ""}.` : "Není plátce DPH (dle ARES)."}</p>

<h2>Insolvence</h2>
<p>${
    r.insolvenci.isInsolvent
      ? "🚨 Aktivní insolvenční řízení / úpadek."
      : r.insolvenci.hadHistory
        ? "⚠️ V minulosti probíhalo insolvenční řízení."
        : "Bez záznamu v insolvenčním rejstříku."
  }</p>

<h2>Statutární orgán</h2>
${
    clenove
      ? `<p>Aktivních členů: ${r.statutary.aktivniCount}</p><ul>${clenove}</ul>`
      : `<p>Bez aktivních záznamů ve statutárním orgánu (dle ARES VR).</p>`
  }

<h2>Živnostenská oprávnění</h2>
<p>Celkem ${r.trade_licenses.total}, aktivních ${r.trade_licenses.aktivni}.${predmety ? ` Předměty: ${predmety}.` : ""}</p>

<h2>Související</h2>
<ul>
  <li><a href="/pruvodce/jak-proverit-firmu.html">Jak prověřit firmu</a></li>
  <li><a href="/pruvodce/skutecny-majitel-firmy.html">Skutečný majitel firmy (UBO)</a></li>
  <li><a href="/pruvodce/insolvence-firmy.html">Insolvence firmy</a></li>
</ul>

<footer>
<p><strong>Zdroj:</strong> veřejné rejstříky — ARES (MF ČR, CC BY 4.0), Veřejný rejstřík (MSp ČR), ISIR, ADIS. Data mají informativní charakter; pro právně závazné rozhodnutí ověřte v primárních zdrojích.</p>
<p>Výstup obsahuje osobní údaje z veřejných rejstříků (čl. 6 GDPR). <a href="/privacy.html">Zásady zpracování</a> · <a href="/">IČO vazby</a></p>
</footer>
</body>
</html>`;
}
