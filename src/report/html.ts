// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Standalone printable HTML report. Klient otevře /report/:ico v novém tabu,
 * auto-invokuje window.print() a uživatel uloží jako PDF přes browserový dialog.
 *
 * Nezáměrně light: žádný headless browser, žádný PDF lib — printable HTML
 * je univerzální (Chrome, Firefox, Safari, Edge) a stačí na deliverable.
 */

// Lehký lokální tvar; přesné typy fullDueDiligenceService nejsou exportovány,
// ale strukturu známe ze server.ts /api/dd/:ico response.
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
    clenove?: { jmeno?: string; funkce?: string; datumNarozeni?: string }[];
  };
  trade_licenses?: { total?: number; aktivni?: number };
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

function riskBadge(level: string): string {
  const map: Record<string, { color: string; label: string }> = {
    green: { color: "#059669", label: "🟢 BEZ VAROVNÝCH SIGNÁLŮ" },
    yellow: { color: "#d97706", label: "🟡 SLEDOVAT" },
    red: { color: "#dc2626", label: "🔴 RIZIKO" },
  };
  const m = map[level] ?? { color: "#6b7280", label: level };
  return `<span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${m.color};color:white;font-weight:600;font-size:12px;letter-spacing:.5px">${m.label}</span>`;
}

export function renderDdReportHtml(report: DdReport): string {
  const dateStr = new Date().toLocaleDateString("cs-CZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const id = report.identification;
  const sidlo = id?.sidloText ?? "";
  const findings = report.risk?.findings ?? [];
  const stat = report.statutary?.clenove ?? [];
  const dphActive = report.vat?.platceDph;
  const insolv = report.insolvenci;

  const findingsHtml = findings
    .map(
      (f) =>
        `<li class="finding finding-${f.level}"><span class="finding-icon">${
          f.level === "red" ? "🚨" : f.level === "yellow" ? "⚠️" : "✓"
        }</span> ${escapeHtml(f.message)}</li>`,
    )
    .join("");

  const statHtml = stat.length
    ? `<ul class="stat-list">${stat
        .map((c) => {
          const role = c.funkce ? ` — ${escapeHtml(c.funkce)}` : "";
          const dn = c.datumNarozeni ? ` <span class="dim">(*${escapeHtml(c.datumNarozeni)})</span>` : "";
          return `<li>${escapeHtml(c.jmeno ?? "(neznámý)")}${dn}${role}</li>`;
        })
        .join("")}</ul>`
    : '<p class="dim">Žádní aktivní statutární orgány ve VR.</p>';

  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<title>Prověrka ${escapeHtml(report.obchodniJmeno ?? report.ico)} — IČO ${escapeHtml(report.ico)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif;
    color: #0f172a;
    line-height: 1.45;
    margin: 0;
    padding: 24px;
    max-width: 800px;
    background: white;
  }
  h1 { font-size: 24px; margin: 0 0 4px; font-weight: 600; letter-spacing: -0.02em; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .08em; color: #475569; margin: 24px 0 8px; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; }
  .ico { font-family: ui-monospace, "SF Mono", "JetBrains Mono", monospace; font-size: 14px; color: #64748b; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 2px solid #0f172a; }
  .meta { font-size: 11px; color: #64748b; text-align: right; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 24px; font-size: 13px; }
  .grid2 dt { color: #64748b; }
  .grid2 dd { margin: 0; font-weight: 500; }
  .findings { list-style: none; padding: 0; margin: 0; }
  .finding { padding: 6px 12px; margin: 4px 0; border-radius: 4px; font-size: 13px; }
  .finding-red { background: #fef2f2; border-left: 3px solid #dc2626; }
  .finding-yellow { background: #fffbeb; border-left: 3px solid #d97706; }
  .finding-green { background: #ecfdf5; border-left: 3px solid #059669; }
  .finding-icon { font-weight: bold; margin-right: 4px; }
  .stat-list { padding-left: 18px; font-size: 13px; }
  .stat-list li { margin: 3px 0; }
  .dim { color: #94a3b8; font-size: 12px; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 10px; color: #94a3b8; }
  .footer p { margin: 4px 0; }
  @media print {
    body { padding: 0; }
    .no-print { display: none !important; }
  }
  .print-bar { position: fixed; top: 8px; right: 8px; background: #0f172a; color: white; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; border: 0; }
  .print-bar:hover { background: #1e293b; }
</style>
</head>
<body>
<button class="print-bar no-print" onclick="window.print()">📄 Uložit jako PDF</button>

<div class="header">
  <div>
    <h1>${escapeHtml(report.obchodniJmeno ?? "(neznámý subjekt)")}</h1>
    <div class="ico">IČO ${escapeHtml(report.ico)}${id?.datumVzniku ? " · vznik " + escapeHtml(id.datumVzniku) : ""}${id?.datumZaniku ? " · zánik " + escapeHtml(id.datumZaniku) : ""}</div>
  </div>
  <div class="meta">
    <div>Prověrka generována ${dateStr}</div>
    <div>${riskBadge(report.risk?.level ?? "")}</div>
  </div>
</div>

<h2>Identifikace</h2>
<dl class="grid2">
  <dt>Sídlo</dt><dd>${escapeHtml(sidlo)}</dd>
  <dt>Právní forma</dt><dd>${escapeHtml(id?.pravniForma ?? "—")}</dd>
  <dt>DIČ</dt><dd>${escapeHtml(report.vat?.dic ?? "—")}</dd>
  <dt>DPH status</dt><dd>${dphActive == null ? "—" : dphActive ? "Aktivní plátce" : "Neaktivní"}</dd>
  <dt>Aktivní statutáři</dt><dd>${report.statutary?.aktivniCount ?? 0}</dd>
  <dt>Aktivní živnosti</dt><dd>${report.trade_licenses?.aktivni ?? 0} z ${report.trade_licenses?.total ?? 0}</dd>
</dl>

<h2>Riziko</h2>
<ul class="findings">${findingsHtml}</ul>

<h2>Statutární orgán</h2>
${statHtml}

<h2>Insolvence</h2>
${
  insolv?.isInsolvent
    ? '<p style="color:#dc2626;font-weight:600">⚠ Aktivní insolvenční řízení</p>'
    : insolv?.hadHistory
      ? '<p style="color:#d97706">V minulosti probíhalo insolvenční řízení.</p>'
      : '<p class="dim">Bez záznamů v ISIR / CEÚ.</p>'
}

<div class="footer">
  <p><strong>Zdroje:</strong> ARES (Ministerstvo financí ČR, CC BY 4.0), Veřejný rejstřík (Ministerstvo spravedlnosti, verejnerejstriky.msp.gov.cz), ADIS DPH, ČNB JERRS, EU sankce (FSF).</p>
  <p><strong>Disclaimer:</strong> Prověrka je informativní snapshot ke dni vygenerování. Pro právně závazné rozhodnutí ověř data přímo v primárních zdrojích. ares-web / IČO vazby není odpovědný za rozhodnutí na základě této prověrky.</p>
  <p>Vygenerováno: IČO vazby · ${dateStr}</p>
</div>

<script>
  // Auto-trigger print dialog after page loads. Uživatel může zrušit.
  window.addEventListener("load", () => { setTimeout(() => window.print(), 400); });
</script>
</body>
</html>`;
}
