// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Standalone printable HTML report — A4 ready-to-print DD prověrka.
 *
 * Redesign 0.6.1: lepší corporate layout, prominentnější risk badge,
 * Statutary/Insolvence/Trade-licenses jako karty, footer s disclaimer +
 * report ID + zdrojem (pro audit trail).
 */

export interface DdReport {
  ico: string;
  obchodniJmeno?: string | null;
  risk?: { level?: string; findings?: { level: string; message: string }[] };
  identification?: {
    pravniForma?: string;
    datumVzniku?: string | null;
    datumZaniku?: string | null;
    sidloText?: string;
    czNace?: string[];
  };
  vat?: { platceDph?: boolean; dic?: string | null };
  statutary?: {
    aktivniCount?: number;
    clenove?: { jmeno?: string; funkce?: string; datumNarozeni?: string; organ?: string; datumZapisu?: string }[];
  };
  trade_licenses?: { total?: number; aktivni?: number; predmety?: string[] };
  insolvenci?: { isInsolvent?: boolean; hadHistory?: boolean };
}

function escapeHtml(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function riskBadge(level: string): { color: string; bg: string; label: string; icon: string } {
  const map: Record<string, { color: string; bg: string; label: string; icon: string }> = {
    green: { color: "#065f46", bg: "#d1fae5", label: "BEZ VAROVNÝCH SIGNÁLŮ", icon: "🟢" },
    yellow: { color: "#92400e", bg: "#fef3c7", label: "DOPORUČENO SLEDOVAT", icon: "🟡" },
    red: { color: "#991b1b", bg: "#fee2e2", label: "RIZIKOVÝ SUBJEKT", icon: "🔴" },
  };
  return map[level] ?? { color: "#374151", bg: "#f3f4f6", label: level.toUpperCase(), icon: "•" };
}

function generateReportId(ico: string): string {
  // Stabilní hash z IČO + datum (per-day), aby PDF mělo deterministický ID
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `DD-${datePart}-${ico}`;
}

export function renderDdReportHtml(report: DdReport): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const timeStr = now.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" });
  const reportId = generateReportId(report.ico);
  const id = report.identification;
  const sidlo = id?.sidloText ?? "";
  const findings = report.risk?.findings ?? [];
  const stat = report.statutary?.clenove ?? [];
  const dphActive = report.vat?.platceDph;
  const insolv = report.insolvenci;
  const risk = riskBadge(report.risk?.level ?? "");

  const findingsHtml = findings
    .map(
      (f) => `<li class="finding finding-${f.level}">
        <span class="finding-icon">${f.level === "red" ? "🚨" : f.level === "yellow" ? "⚠" : "✓"}</span>
        <span class="finding-text">${escapeHtml(f.message)}</span>
      </li>`,
    )
    .join("");

  const statHtml = stat.length
    ? `<ul class="stat-list">${stat
        .map((c) => {
          const role = c.funkce ? `<span class="stat-role">${escapeHtml(c.funkce)}</span>` : "";
          const dn = c.datumNarozeni ? `<span class="stat-dob">*${escapeHtml(c.datumNarozeni)}</span>` : "";
          return `<li>
            <span class="stat-name">${escapeHtml(c.jmeno ?? "(neznámý)")}</span>
            ${role}
            ${dn}
          </li>`;
        })
        .join("")}</ul>`
    : '<p class="empty">Žádní aktivní statutární orgány ve VR.</p>';

  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(reportId)} — ${escapeHtml(report.obchodniJmeno ?? report.ico)}</title>
<style>
  @page { size: A4; margin: 14mm 14mm 16mm; }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif;
    color: #0f172a;
    line-height: 1.5;
    padding: 24px;
    max-width: 820px;
    margin: 0 auto;
    background: white;
    font-size: 13px;
  }

  /* ─── Header (sticky on print) ────────────────────────────────────── */
  .head {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 20px;
    align-items: start;
    padding-bottom: 16px;
    border-bottom: 3px solid #0f172a;
    margin-bottom: 24px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    font-weight: 700;
    color: #64748b;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  .brand-mark { width: 20px; height: 20px; flex-shrink: 0; }
  .brand-mark svg { display: block; width: 100%; height: 100%; }
  h1 {
    font-size: 26px;
    margin: 0 0 6px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }
  .ico {
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", "Consolas", monospace;
    font-size: 14px;
    color: #475569;
    font-weight: 500;
  }
  .meta {
    text-align: right;
    font-size: 11px;
    color: #64748b;
    line-height: 1.6;
  }
  .meta strong { color: #0f172a; }

  /* ─── Risk hero ───────────────────────────────────────────────────── */
  .risk-hero {
    background: ${risk.bg};
    border-radius: 10px;
    padding: 16px 20px;
    margin: 16px 0 28px;
    border-left: 5px solid ${risk.color};
    page-break-inside: avoid;
  }
  .risk-hero-label {
    color: ${risk.color};
    font-weight: 700;
    font-size: 14px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .risk-hero-detail {
    margin-top: 4px;
    color: #1f2937;
    font-size: 12px;
  }

  /* ─── Sections ───────────────────────────────────────────────────── */
  section { page-break-inside: avoid; margin-bottom: 24px; }
  h2 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: #475569;
    margin: 0 0 10px;
    padding-bottom: 6px;
    border-bottom: 1px solid #e2e8f0;
    font-weight: 700;
  }

  /* ─── Two-column key/value grid ──────────────────────────────────── */
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 28px;
    font-size: 13px;
  }
  .grid dt { color: #64748b; font-weight: 500; }
  .grid dd { margin: 0; font-weight: 600; color: #0f172a; }
  .grid dd.empty { color: #94a3b8; font-weight: 400; }

  /* ─── Findings ────────────────────────────────────────────────────── */
  .findings { list-style: none; padding: 0; margin: 0; }
  .finding {
    padding: 8px 14px;
    margin: 6px 0;
    border-radius: 6px;
    font-size: 13px;
    display: flex;
    gap: 10px;
    align-items: start;
  }
  .finding-red { background: #fef2f2; border-left: 4px solid #dc2626; color: #7f1d1d; }
  .finding-yellow { background: #fffbeb; border-left: 4px solid #d97706; color: #78350f; }
  .finding-green { background: #ecfdf5; border-left: 4px solid #059669; color: #065f46; }
  .finding-icon { font-size: 14px; flex-shrink: 0; }
  .finding-text { flex: 1; }

  /* ─── Statutary list ──────────────────────────────────────────────── */
  .stat-list { list-style: none; padding: 0; margin: 0; }
  .stat-list li {
    padding: 6px 0;
    border-bottom: 1px dotted #e2e8f0;
    display: flex;
    gap: 12px;
    align-items: baseline;
    font-size: 13px;
  }
  .stat-list li:last-child { border-bottom: 0; }
  .stat-name { font-weight: 600; flex: 1; }
  .stat-role { color: #64748b; font-size: 12px; }
  .stat-dob { color: #94a3b8; font-size: 11px; font-family: ui-monospace, monospace; }

  /* ─── Empty / dim ─────────────────────────────────────────────────── */
  .empty { color: #94a3b8; font-size: 12px; font-style: italic; margin: 0; }
  .alert-red { color: #dc2626; font-weight: 700; margin: 0; }
  .alert-yellow { color: #d97706; font-weight: 500; margin: 0; }

  /* ─── NACE tags ───────────────────────────────────────────────────── */
  .nace-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .nace-tag {
    background: #f1f5f9;
    color: #475569;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-family: ui-monospace, monospace;
  }

  /* ─── Footer with disclaimer ─────────────────────────────────────── */
  .doc-footer {
    margin-top: 36px;
    padding: 16px 18px;
    background: #f8fafc;
    border-radius: 8px;
    border: 1px solid #e2e8f0;
    page-break-inside: avoid;
  }
  .doc-footer h3 {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #64748b;
    margin: 0 0 6px;
    font-weight: 700;
  }
  .doc-footer p {
    margin: 4px 0;
    font-size: 10.5px;
    color: #475569;
    line-height: 1.5;
  }
  .doc-footer .disclaimer {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #e2e8f0;
    font-style: italic;
  }
  .doc-footer .signature {
    margin-top: 10px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: #64748b;
  }

  /* ─── Print rules ────────────────────────────────────────────────── */
  @media print {
    body { padding: 0; max-width: none; }
    .no-print { display: none !important; }
    section { page-break-inside: avoid; }
    .doc-footer { page-break-inside: avoid; }
  }
  @media screen {
    body { box-shadow: 0 0 32px rgba(0,0,0,0.08); margin: 24px auto; }
  }

  .print-bar {
    position: fixed; top: 16px; right: 16px;
    background: #0f172a; color: white;
    padding: 10px 18px; border-radius: 8px;
    cursor: pointer; font-size: 13px;
    border: 0; font-weight: 600;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  }
  .print-bar:hover { background: #1e293b; }
</style>
</head>
<body>
<button class="print-bar no-print" onclick="window.print()">📄 Uložit jako PDF</button>

<div class="head">
  <div>
    <div class="brand">
      <span class="brand-mark">
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <path d="M 32 18 L 14 46" stroke="#10b981" stroke-width="3.5" stroke-linecap="round" fill="none"/>
          <path d="M 32 18 L 32 46" stroke="#10b981" stroke-width="3.5" stroke-linecap="round" fill="none"/>
          <path d="M 32 18 L 50 46" stroke="#10b981" stroke-width="3.5" stroke-linecap="round" fill="none"/>
          <rect x="6"  y="42" width="16" height="16" rx="3" fill="#10b981"/>
          <rect x="24" y="42" width="16" height="16" rx="3" fill="#10b981"/>
          <rect x="42" y="42" width="16" height="16" rx="3" fill="#10b981"/>
          <circle cx="32" cy="18" r="11" fill="#065f46"/>
          <circle cx="32" cy="18" r="7"  fill="#34d399"/>
        </svg>
      </span>
      IČO vazby — Due diligence report
    </div>
    <h1>${escapeHtml(report.obchodniJmeno ?? "(neznámý subjekt)")}</h1>
    <div class="ico">IČO ${escapeHtml(report.ico)}${id?.datumVzniku ? " · vznik " + escapeHtml(id.datumVzniku) : ""}${id?.datumZaniku ? " · zánik " + escapeHtml(id.datumZaniku) : ""}</div>
  </div>
  <div class="meta">
    <div>Report ID: <strong>${escapeHtml(reportId)}</strong></div>
    <div>Vygenerováno: <strong>${escapeHtml(dateStr)} ${escapeHtml(timeStr)}</strong></div>
    <div>Snapshot z primárních zdrojů</div>
  </div>
</div>

<div class="risk-hero">
  <div class="risk-hero-label">${risk.icon} ${risk.label}</div>
  <div class="risk-hero-detail">${findings.length} signál${findings.length === 1 ? "" : findings.length < 5 ? "y" : "ů"} — viz Rizikové faktory níže.</div>
</div>

<section>
  <h2>Identifikace</h2>
  <dl class="grid">
    <dt>Sídlo</dt><dd${sidlo ? "" : ' class="empty"'}>${escapeHtml(sidlo) || "—"}</dd>
    <dt>Právní forma</dt><dd${id?.pravniForma ? "" : ' class="empty"'}>${escapeHtml(id?.pravniForma ?? "—")}</dd>
    <dt>DIČ</dt><dd${report.vat?.dic ? "" : ' class="empty"'}>${escapeHtml(report.vat?.dic ?? "—")}</dd>
    <dt>Plátce DPH</dt><dd${dphActive == null ? ' class="empty"' : ""}>${dphActive == null ? "—" : dphActive ? "Ano (aktivní)" : "Ne"}</dd>
    <dt>Aktivních statutářů</dt><dd>${report.statutary?.aktivniCount ?? 0}</dd>
    <dt>Aktivních živností</dt><dd>${report.trade_licenses?.aktivni ?? 0} z ${report.trade_licenses?.total ?? 0}</dd>
  </dl>
  ${
    id?.czNace?.length
      ? `<div style="margin-top:14px"><div style="font-size:11px;color:#64748b;margin-bottom:4px">CZ-NACE klasifikace</div><div class="nace-tags">${id.czNace.slice(0, 12).map((n) => `<span class="nace-tag">${escapeHtml(n)}</span>`).join("")}${id.czNace.length > 12 ? `<span class="nace-tag">+${id.czNace.length - 12}</span>` : ""}</div></div>`
      : ""
  }
</section>

<section>
  <h2>Rizikové faktory</h2>
  <ul class="findings">${findingsHtml || '<li class="finding finding-green"><span class="finding-icon">✓</span><span class="finding-text">Žádné varovné signály v ARES.</span></li>'}</ul>
</section>

<section>
  <h2>Statutární orgán</h2>
  ${statHtml}
</section>

<section>
  <h2>Insolvence (ISIR / CEÚ)</h2>
  ${
    insolv?.isInsolvent
      ? '<p class="alert-red">🚨 Aktivní insolvenční řízení</p>'
      : insolv?.hadHistory
        ? '<p class="alert-yellow">⚠ V minulosti probíhalo insolvenční řízení.</p>'
        : '<p class="empty">Bez záznamů v ISIR / CEÚ.</p>'
  }
</section>

<div class="doc-footer">
  <h3>Zdroje dat</h3>
  <p>ARES — Ministerstvo financí ČR (CC BY 4.0); Veřejný rejstřík — Ministerstvo spravedlnosti ČR (verejnerejstriky.msp.gov.cz); ADIS DPH; ISIR (insolvenční rejstřík); EU consolidated sanctions list (Free Sanctions Feed, FSF); Hlídač státu (CC BY 3.0).</p>

  <p class="disclaimer">
    Prověrka je informativní snapshot k datu generování. Pro právně závazné rozhodnutí ověř data přímo v primárních zdrojích. IČO vazby není odpovědný za rozhodnutí učiněná na základě této prověrky. Aplikace agreguje veřejně dostupná data podle zákonů č. 304/2013 Sb. (veřejné rejstříky) a 106/1999 Sb. (svobodný přístup k informacím).
  </p>

  <div class="signature">
    <span>icovazby.cz — DD report</span>
    <span>${escapeHtml(reportId)}</span>
  </div>
</div>

<script>
  // Auto-trigger print dialog (uživatel může zrušit).
  window.addEventListener("load", () => { setTimeout(() => window.print(), 500); });
</script>
</body>
</html>`;
}
