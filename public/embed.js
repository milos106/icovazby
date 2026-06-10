// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * icovazby embed widget — vlož na jakýkoli web jako:
 *
 *   <script src="https://icovazby.cz/embed.js"></script>
 *   <icovazby-card ico="26185610"></icovazby-card>
 *
 * Custom element s shadow DOM (izolovaný od stylů hostujícího webu).
 * Volá veřejný /api/dd/{ico} endpoint, zobrazí kompaktní DD kartu s risk
 * score, jménem, DPH stavem a tlačítkem na plný profil.
 *
 * AGPL-3.0 §13: hostující stránka musí poskytnout link na zdrojový kód
 * pokud tu instanci modifikuje. Zde se servíruje original embed.js z naší
 * domény, takže AGPL clause splňujeme my (icovazby.cz/github source).
 */

(function () {
  if (window.customElements && window.customElements.get("icovazby-card")) return;

  const BASE = (document.currentScript && document.currentScript.src.replace(/\/embed\.js.*$/, "")) || "https://icovazby.cz";

  const STYLES = `
    :host {
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif;
      max-width: 480px;
      margin: 0.5em 0;
    }
    .card {
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 14px 16px;
      background: #fff;
      color: #0f172a;
      font-size: 14px;
      line-height: 1.4;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .card.loading { color: #64748b; font-style: italic; }
    .card.error { border-color: #fecaca; background: #fef2f2; color: #991b1b; }
    .header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
    .name { font-weight: 600; font-size: 15px; }
    .ico { font-family: ui-monospace, "SF Mono", "JetBrains Mono", monospace; font-size: 12px; color: #64748b; }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid currentColor;
    }
    .badge-green { color: #065f46; background: #d1fae5; }
    .badge-amber { color: #92400e; background: #fef3c7; }
    .badge-red { color: #991b1b; background: #fee2e2; }
    .badge-slate { color: #334155; background: #f1f5f9; }
    .findings { margin: 8px 0 0 0; padding-left: 18px; }
    .findings li { font-size: 12px; color: #475569; margin: 2px 0; }
    .footer {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid #e2e8f0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      font-size: 11px;
    }
    .cta {
      color: #047857;
      text-decoration: none;
      font-weight: 500;
    }
    .cta:hover { text-decoration: underline; }
    .brand { color: #94a3b8; }
    .brand a { color: inherit; text-decoration: none; }
    .brand a:hover { color: #047857; text-decoration: underline; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1e293b; border-color: #334155; color: #f1f5f9; }
      .ico, .findings li { color: #94a3b8; }
      .footer { border-top-color: #334155; }
      .badge-green { color: #6ee7b7; background: rgba(16, 185, 129, 0.15); }
      .badge-amber { color: #fcd34d; background: rgba(245, 158, 11, 0.15); }
      .badge-red { color: #fca5a5; background: rgba(239, 68, 68, 0.15); }
      .badge-slate { color: #cbd5e1; background: rgba(100, 116, 139, 0.15); }
      .card.error { background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.3); color: #fca5a5; }
    }
  `;

  function riskBadge(level) {
    const map = {
      green: ["badge-green", "🟢 Risk nízký"],
      amber: ["badge-amber", "🟡 Risk střední"],
      red: ["badge-red", "🔴 Risk vysoký"],
    };
    return map[level] || ["badge-slate", "❓ Neznámý"];
  }

  class IcoVazbyCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }
    static get observedAttributes() { return ["ico"]; }
    attributeChangedCallback(_n, _o, v) { if (v) this._load(v); }
    connectedCallback() {
      const ico = this.getAttribute("ico");
      if (ico) this._load(ico);
    }
    _load(ico) {
      const cleanIco = String(ico).replace(/\D/g, "").padStart(8, "0").slice(-8);
      this._render(this._loadingHtml(cleanIco));
      fetch(`${BASE}/api/dd/${encodeURIComponent(cleanIco)}`)
        .then((r) => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
        .then((data) => this._render(this._cardHtml(data, cleanIco)))
        .catch(() => this._render(this._errorHtml(cleanIco)));
    }
    _render(inner) {
      this.shadowRoot.innerHTML = `<style>${STYLES}</style>${inner}`;
    }
    _loadingHtml(ico) {
      return `<div class="card loading">Načítám prověrku pro IČO ${ico}…</div>`;
    }
    _errorHtml(ico) {
      return `
        <div class="card error">
          ⚠️ Nepodařilo se načíst data pro IČO ${ico}.
          <div class="footer">
            <a class="cta" href="${BASE}/?ico=${ico}&action=profil" target="_blank" rel="noopener">Otevřít na icovazby.cz →</a>
            <span class="brand"><a href="${BASE}" target="_blank" rel="noopener">icovazby</a></span>
          </div>
        </div>`;
    }
    _cardHtml(data, ico) {
      const [riskClass, riskLabel] = riskBadge(data.risk?.level);
      const dphActive = data.vat?.platceDph;
      const insolvent = data.insolvenci?.isInsolvent;
      const statCount = data.statutary?.aktivniCount ?? 0;
      const findings = (data.risk?.findings || []).slice(0, 3);

      return `
        <div class="card">
          <div class="header">
            <span class="name">${escapeHtml(data.obchodniJmeno || ico)}</span>
            <span class="ico">IČO ${ico}</span>
          </div>
          <div class="badges">
            <span class="badge ${riskClass}">${riskLabel}</span>
            ${dphActive ? '<span class="badge badge-green">DPH plátce</span>' : '<span class="badge badge-slate">Neplátce DPH</span>'}
            ${insolvent ? '<span class="badge badge-red">⚠️ Insolvence</span>' : ''}
            <span class="badge badge-slate">${statCount} statutár${statCount === 1 ? '' : statCount < 5 ? 'i' : 'ů'}</span>
          </div>
          ${findings.length > 0 ? `
            <ul class="findings">
              ${findings.map((f) => `<li>${escapeHtml(f.message)}</li>`).join("")}
            </ul>
          ` : ""}
          <div class="footer">
            <a class="cta" href="${BASE}/?ico=${ico}&action=profil" target="_blank" rel="noopener">Plný profil + holding mapa →</a>
            <span class="brand">Powered by <a href="${BASE}" target="_blank" rel="noopener">icovazby.cz</a></span>
          </div>
        </div>`;
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  customElements.define("icovazby-card", IcoVazbyCard);
})();
