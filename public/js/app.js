/**
 * icovazby — Alpine.js controllers and API glue.
 * Vanilla, no build step. Loaded from /public/js/app.js.
 */

const ICO_RE = /^\d{7,8}$/;
const STORAGE_RECENT = "icovazby:recent";
const STORAGE_BOOKMARKS = "icovazby:bookmarks";
const STORAGE_DD_COLLAPSE = "icovazby:dd-collapsed";
const STORAGE_SECTIONS = "icovazby:sections-hidden";

// Sekce, které lze v Nastavení skrýt. Profil zůstává vždy viditelný.
// Klíče slouží zároveň jako section id v DOM a key v localStorage.
const SECTION_DEFS = [
  { key: "dd-timeline", label: "📜 Časová osa", group: "Profil firmy" },
  { key: "dd-katastr", label: "🏠 Nemovitosti (Katastr, brzy)", group: "Profil firmy" },
  { key: "dd-ds", label: "📬 Datová schránka", group: "Profil firmy" },
  { key: "dd-upv", label: "™ Ochranné známky (TMView)", group: "Profil firmy" },
  { key: "dd-vr", label: "⚖️ Veřejný rejstřík (OR)", group: "Profil firmy" },
  { key: "dd-ubo", label: "👥 Skuteční majitelé (UBO)", group: "Profil firmy" },
  { key: "dd-dotace", label: "💸 Dotace", group: "Profil firmy" },
  { key: "dd-smlouvy", label: "💰 Veřejné zakázky", group: "Profil firmy" },
  { key: "dd-adis", label: "🏦 DPH (ADIS)", group: "Profil firmy" },
  { key: "dd-isir", label: "⚖️ Insolvence (ISIR)", group: "Profil firmy" },
  { key: "dd-jerrs", label: "🏦 ČNB JERRS", group: "Profil firmy" },
  { key: "dd-sankce", label: "🇪🇺 EU sankce", group: "Profil firmy" },
  { key: "dd-zivno", label: "🏷️ Živnosti", group: "Profil firmy" },
  { key: "graph", label: "🌐 Mapa propojení", group: "Sekce" },
  { key: "address", label: "🏢 Hledat na adrese", group: "Sekce" },
  { key: "osoby", label: "🔗 Vazby osoby", group: "Sekce" },
  { key: "compare", label: "⚖️ Porovnat 2 firmy", group: "Sekce" },
  { key: "bulk", label: "📋 Hromadná prověrka", group: "Sekce" },
  { key: "saved", label: "📑 Uložená vyhledávání", group: "Sekce" },
];
const RECENT_LIMIT = 10;

// Alpine store pro stav rozbalení DD karet — persistovaný v localStorage.
// Klíč = id karty (např. "dd-adis"). Default chování: dd-profil je VŽDY
// rozbalený a nelze ho sbalit; ostatní jsou defaultně sbalené (uživatel
// si je rozbalí kliknutím na hlavičku). Toggle se ukládá hned.
// CZ-NACE číselník — bundled jako /data/cz-nace.json (sekce A–U +
// kódy 2/3/4/5 znaků). Načítáme jednou při alpine:init; pokud kód
// není v indexu, zkusíme hierarchický fallback (delší prefix se
// zkrátí o jeden znak až do nalezení nadřazené úrovně).
document.addEventListener("alpine:init", () => {
  window.Alpine.store("nace", {
    table: {},
    loaded: false,
    async ensureLoaded() {
      if (this.loaded) return;
      try {
        const r = await fetch("/data/cz-nace.json");
        if (r.ok) this.table = await r.json();
      } catch {
        /* ignore — fallback bude jen kód */
      }
      this.loaded = true;
    },
    describe(kod) {
      // Lazy load při prvním volání. Alpine title binding přečte
      // aktuální hodnotu při hover, takže opožděné naplnění je OK.
      if (!this.loaded) this.ensureLoaded();
      if (!kod) return "";
      const k = String(kod).trim();
      if (this.table[k]) return `${k} — ${this.table[k]}`;
      // Hierarchický fallback: zkrátit kód o jeden znak a zkusit znovu.
      for (let i = k.length - 1; i >= 1; i--) {
        const cut = k.slice(0, i);
        if (this.table[cut]) return `${k} (nadřazené ${cut} — ${this.table[cut]})`;
      }
      return `${k} (kód není v číselníku CZ-NACE)`;
    },
  });

  // Globální historie toggle: synchronizuje cb v Profilu (Rozkrýt holding)
  // a v Mapě propojení. User myslí v binární kategorii „chci historické info"
  // — discovery i render vždy řídí stejný flag. Default off.
  window.Alpine.store("history", { enabled: false });

  // Section visibility — uživatel může v Nastavení skrýt sekce/karty.
  // Persistujeme jen SKRYTÉ klíče (= defaultně všechno viditelné). Profil
  // je always-on a do nastavení se nezobrazí. Sync mezi menu a body
  // přes jeden zdroj pravdy.
  window.Alpine.store("sections", {
    hidden: (() => {
      try {
        const raw = localStorage.getItem(STORAGE_SECTIONS);
        return raw ? new Set(JSON.parse(raw)) : new Set();
      } catch {
        return new Set();
      }
    })(),
    save() {
      try {
        localStorage.setItem(STORAGE_SECTIONS, JSON.stringify([...this.hidden]));
      } catch {
        /* private mode */
      }
    },
    visible(key) {
      return !this.hidden.has(key);
    },
    setVisible(key, on) {
      if (on) this.hidden.delete(key);
      else this.hidden.add(key);
      this.save();
    },
    toggle(key) {
      this.setVisible(key, this.hidden.has(key));
    },
    defs() {
      return SECTION_DEFS;
    },
  });

  window.Alpine.store("ddCollapse", {
    state: (() => {
      try {
        const raw = localStorage.getItem(STORAGE_DD_COLLAPSE);
        return raw ? JSON.parse(raw) : {};
      } catch {
        return {};
      }
    })(),
    save() {
      try {
        localStorage.setItem(STORAGE_DD_COLLAPSE, JSON.stringify(this.state));
      } catch {
        /* private mode, ignore */
      }
    },
    isExpanded(id) {
      if (id === "dd-profil") return true;
      const explicit = this.state[id];
      return explicit === true;
    },
    toggle(id) {
      if (id === "dd-profil") return;
      this.state[id] = !this.isExpanded(id);
      this.save();
    },
    expandAll(ids) {
      for (const id of ids) if (id !== "dd-profil") this.state[id] = true;
      this.save();
    },
    collapseAll(ids) {
      for (const id of ids) if (id !== "dd-profil") this.state[id] = false;
      this.save();
    },
  });
});

const STORAGE_HS_TOKEN = "icovazby:hs-token";

/**
 * Wrapped fetch: ke každému API requestu přidá X-Hlidac-Token hlavičku,
 * pokud má uživatel v localStorage vlastní token. Server tento token
 * použije přednostně před env tokenem — tím se rate limit rozdělí
 * per-uživatele.
 */
async function jsonFetch(url, opts) {
  const headers = new Headers((opts && opts.headers) || {});
  try {
    const tok = (localStorage.getItem(STORAGE_HS_TOKEN) || "").trim();
    if (tok) headers.set("X-Hlidac-Token", tok);
  } catch {
    /* private mode, ignore */
  }
  const r = await fetch(url, { ...(opts || {}), headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data.message || data.error || `HTTP ${r.status}`);
  }
  return data;
}

/** Stejné jako jsonFetch, ale pro raw `fetch()` v custom callerech. */
function withHsToken(opts) {
  const headers = new Headers((opts && opts.headers) || {});
  try {
    const tok = (localStorage.getItem(STORAGE_HS_TOKEN) || "").trim();
    if (tok) headers.set("X-Hlidac-Token", tok);
  } catch {
    /* ignore */
  }
  return { ...(opts || {}), headers };
}

function loadList(key) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : [];
  } catch {
    return [];
  }
}

function saveList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* ignore quota errors */
  }
}

/**
 * Replace the URL with the given state object without adding a history entry.
 * Used to keep the URL in sync with the current view so deep-links and back/
 * forward navigation work. We never reload — Alpine state drives rendering.
 */
function updateUrl(state) {
  const params = new URLSearchParams();
  if (state.ico) params.set("ico", state.ico);
  if (state.action) params.set("action", state.action);
  if (state.address) params.set("address", state.address);
  if (state.icos) params.set("icos", state.icos);
  const qs = params.toString();
  const url = qs ? `?${qs}` : "/";
  window.history.replaceState(null, "", url);
}

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  return {
    ico: p.get("ico"),
    action: p.get("action"),
    address: p.get("address"),
    icos: p.get("icos"),
  };
}

/**
 * Record a visit. Bubbles the entry to the top of the recent list, dedupes
 * by IČO, and keeps at most RECENT_LIMIT entries. Broadcasts a custom event
 * so the header history dropdown updates without coupling.
 */
function recordVisit(entry) {
  if (!entry || !entry.ico) return;
  const recent = loadList(STORAGE_RECENT).filter((r) => r.ico !== entry.ico);
  recent.unshift({ ico: entry.ico, obchodniJmeno: entry.obchodniJmeno, at: Date.now() });
  saveList(STORAGE_RECENT, recent.slice(0, RECENT_LIMIT));
  window.dispatchEvent(new CustomEvent("ares-history-changed"));
}

function searchSection() {
  return {
    query: "",
    loading: false,
    error: "",
    profile: null,
    results: [],
    totalFound: 0,
    fallbackNotice: "",
    resData: null,
    licensesData: null,
    exportNotice: "",
    _initialized: false,
    init() {
      // history bar can ask us to load a specific IČO
      window.addEventListener("open-search", (e) => {
        if (e.detail?.ico) {
          this.query = e.detail.ico;
          this.run().then(() => {
            /* scroll removed per user request */
          });
        }
      });
      // restore from URL on first load if no other section will claim it
      const url = readUrl();
      if (url.ico && (!url.action || url.action === "profile")) {
        this.query = url.ico;
        this.run();
      }
      this._initialized = true;
    },
    _resetExpansions() {
      this.resData = null;
      this.licensesData = null;
      this.exportNotice = "";
    },
    async run() {
      this.error = "";
      this.profile = null;
      this.results = [];
      this.totalFound = 0;
      this.fallbackNotice = "";
      this._resetExpansions();
      const q = (this.query || "").trim().replace(/\s+/g, " ");
      if (!q) return;
      this.loading = true;
      try {
        const cleaned = q.replace(/^CZ\s*/i, "").replace(/\s|-|\./g, "");
        if (ICO_RE.test(cleaned)) {
          this.profile = await jsonFetch(`/api/company/${encodeURIComponent(cleaned)}`);
          recordVisit({ ico: this.profile.ico, obchodniJmeno: this.profile.obchodniJmeno });
          updateUrl({ ico: this.profile.ico, action: "profile" });
          // Auto-trigger DD pro stejné IČO. Profil i prověrka by měly být
          // v sync, aby uživatel nemusel klikat na samostatné tlačítko.
          window.dispatchEvent(new CustomEvent("open-dd", { detail: { ico: this.profile.ico } }));
          // Profil → ostatní sekce: Mapa propojení si načte IČO do textarea
          // (uživatel doplní další IČO a klikne Vykreslit), Vazby osoby
          // si event ignoruje (pracují s osobou ne s firmou).
          window.dispatchEvent(new CustomEvent("ares-profile-loaded", { detail: { ico: this.profile.ico } }));
        } else {
          const u = `/api/search/companies?obchodniJmeno=${encodeURIComponent(q)}&limit=25`;
          const r = await jsonFetch(u);
          this.results = r.vysledky || [];
          this.totalFound = r.celkemNalezeno || 0;
          this.fallbackNotice = "";
          if (r.localFallbackUsed) {
            this.fallbackNotice = `ARES nenalezl „${r.originalQuery}" (vyhledává jen celá slova). Z lokální historie vyhledávání nabízíme:`;
          } else if (r.fallbackUsed && r.usedQuery && r.originalQuery && r.usedQuery !== r.originalQuery) {
            this.fallbackNotice = `ARES nenalezl přesně „${r.originalQuery}" (vyhledává celá slova). Zobrazujem výsledky pro „${r.usedQuery}".`;
          }
          if (this.results.length === 0) this.error = `Nic nenalezeno pro "${q}".`;
          // Pokud z name-search vypadne jediný hit → auto-trigger DD na něj.
          if (this.results.length === 1) {
            window.dispatchEvent(new CustomEvent("open-dd", { detail: { ico: this.results[0].ico } }));
          }
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    async loadByIco(ico) {
      this.query = ico;
      await this.run();
      /* scroll removed per user request */
    },
    async toggleRes(ico) {
      if (this.resData) {
        this.resData = null;
        return;
      }
      try {
        this.resData = await jsonFetch(`/api/res/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.error = "Klasifikaci nelze načíst: " + e.message;
      }
    },
    async toggleLicenses(ico) {
      if (this.licensesData) {
        this.licensesData = null;
        return;
      }
      try {
        this.licensesData = await jsonFetch(`/api/licenses/${encodeURIComponent(ico)}`);
      } catch (e) {
        // 404 = no RŽP record for this entity — that's a valid response
        if (e.message?.includes("404") || e.message?.toLowerCase().includes("not found")) {
          this.licensesData = { pocetCelkem: 0, pocetAktivnich: 0, zivnostenskaOpravneni: [] };
        } else {
          this.error = "Živnosti nelze načíst: " + e.message;
        }
      }
    },
    async exportTo(ico, target) {
      try {
        this.exportNotice = "";
        const r = await jsonFetch(`/api/export/${encodeURIComponent(ico)}/${target}`);
        const text = JSON.stringify(r.payload, null, 2);
        await navigator.clipboard.writeText(text);
        this.exportNotice = `✅ JSON pro ${target} zkopírován do schránky (${text.length} znaků).`;
        setTimeout(() => { this.exportNotice = ""; }, 6000);
      } catch (e) {
        this.exportNotice = `Export selhal: ${e.message}`;
      }
    },
  };
}

function ddSection() {
  return {
    ico: "",
    loading: false,
    error: "",
    report: null,
    exportNotice: "",
    init() {
      const url = readUrl();
      // Akceptujeme i staré bookmarky s action=dd kvůli backward compat;
      // nově se zapisuje action=profil (sekce byla přejmenována).
      if (url.ico && (url.action === "profil" || url.action === "dd")) {
        this.run(url.ico);
      }
    },
    async run(maybeIco) {
      this.error = "";
      this.report = null;
      this.exportNotice = "";
      const i = (maybeIco || this.ico || "").trim().replace(/^CZ\s*/i, "").replace(/\s|-|\./g, "");
      if (!ICO_RE.test(i)) {
        this.error = "Zadej platné IČO (7-8 číslic).";
        return;
      }
      this.ico = i;
      this.loading = true;
      try {
        this.report = await jsonFetch(`/api/dd/${encodeURIComponent(i)}`);
        recordVisit({ ico: this.report.ico, obchodniJmeno: this.report.obchodniJmeno });
        updateUrl({ ico: this.report.ico, action: "profil" });
        /* scroll removed per user request */
        // Ulož „latest profile" na window, ať holdingDiscovery, který se
        // vyrenderuje až po template x-if="report", ho mohl číst při init().
        // (Bare event dispatch by se mohl ztratit — Alpine ještě nestihla
        // template vyrenderovat, takže listener není zaregistrován.)
        const reportDetail = {
          ico: this.report.ico,
          pravniForma: this.report.identification?.pravniForma,
          aktivniCount: this.report.statutary?.aktivniCount || 0,
        };
        window.__aresLatestReport = reportDetail;
        window.dispatchEvent(new CustomEvent("ares-report-loaded", { detail: reportDetail }));
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    async exportTo(ico, target) {
      try {
        this.exportNotice = "";
        const r = await jsonFetch(`/api/export/${encodeURIComponent(ico)}/${target}`);
        const text = JSON.stringify(r.payload, null, 2);
        await navigator.clipboard.writeText(text);
        this.exportNotice = `✅ JSON pro ${target} zkopírován do schránky.`;
        setTimeout(() => { this.exportNotice = ""; }, 6000);
      } catch (e) {
        this.exportNotice = `Export selhal: ${e.message}`;
      }
    },
    openPersonVazby(jmeno, datumNarozeni) {
      window.dispatchEvent(new CustomEvent("ares-open-person-vazby", {
        detail: { jmeno, datumNarozeni },
      }));
    },
  };
}

function graphSection() {
  return {
    raw: "",
    loading: false,
    error: "",
    result: null,
    mermaidSvg: "",
    /** 'mermaid' | 'interactive' — toggle. Default Mermaid (zpětně kompatibilní). */
    renderMode: "mermaid",
    /** Cytoscape instance — odkaz pro relayout / destroy. */
    cy: null,
    // Selection map pro „Možné jmenovce" (tentativeCandidates). Key = jmeno|prijmeni
    // (unikátní per name; pokud má více seed firem, vše bere). Hodnota = boolean.
    // Default ON — uživatel odškrtává ty, kteří nejsou ten samý člověk.
    tentativeSelections: {},
    init() {
      const url = readUrl();
      if (url.icos) {
        this.raw = url.icos.split(",").join("\n");
        this.run();
      }
      // re-render Mermaid on theme switch
      window.addEventListener("ares-theme-changed", async () => {
        if (this.result?.mermaid && window.__mermaid) {
          try {
            const { svg } = await window.__mermaid.render("mer-" + Date.now(), this.result.mermaid);
            this.mermaidSvg = svg;
          } catch (e) {
            /* ignore */
          }
        }
      });
    },
    parseIcos(raw) {
      return (raw || "")
        .split(/[\s,;\n]+/g)
        .map((s) => s.trim().replace(/^CZ\s*/i, "").replace(/\s|-|\./g, ""))
        .filter((s) => ICO_RE.test(s));
    },
    async run(extraTentativeIcos = []) {
      this.error = "";
      this.mermaidSvg = "";
      const userIcos = this.parseIcos(this.raw);
      if (userIcos.length < 1) {
        this.error = "Zadej alespoň 1 platné IČO.";
        return;
      }
      // Spoj user IČO + IČO z selected tentative kandidátů (re-render flow).
      const icos = [...new Set([...userIcos, ...extraTentativeIcos])];
      if (icos.length > 50) {
        this.error = "Maximum 50 IČO na jeden dotaz.";
        return;
      }
      this.loading = true;
      try {
        const prev = this.result;
        this.result = await jsonFetch("/api/cross-persons", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            icos,
            includeHistorical: Alpine.store("history").enabled,
            emitMermaid: true,
          }),
        });
        // Initialize selections: default ALL on
        if (this.result?.tentativeCandidates) {
          const nextSelections = {};
          for (const c of this.result.tentativeCandidates) {
            const key = this.candidateKey(c);
            // Zachovej předchozí volbu pokud uživatel již dříve odškrtl
            nextSelections[key] = prev?.tentativeCandidates?.length
              ? this.tentativeSelections[key] ?? true
              : true;
          }
          this.tentativeSelections = nextSelections;
        } else {
          this.tentativeSelections = {};
        }
        updateUrl({ icos: icos.join(",") });
        if (this.result.mermaid && window.__mermaid) {
          const id = "mer-" + Date.now();
          try {
            const { svg } = await window.__mermaid.render(id, this.result.mermaid);
            this.mermaidSvg = svg;
          } catch (e) {
            this.error = "Nepodařilo se vykreslit graf: " + e.message;
          }
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    /** Cytoscape rendering — interaktivní force graph. */
    renderCytoscape() {
      if (!this.result || !window.cytoscape) return;
      const container = document.getElementById("cytoscape-container");
      if (!container) return;
      if (this.cy) {
        this.cy.destroy();
        this.cy = null;
      }
      // Companies = uzly typu firma; activePersons = uzly typu osoba; edges =
      // membership (osoba → firma).
      const elements = [];
      for (const c of this.result.companies || []) {
        elements.push({
          data: { id: "F-" + c.ico, label: c.obchodniJmeno || c.ico, ico: c.ico, type: "firma" },
        });
      }
      const personNodes = new Map();
      const addPerson = (p) => {
        const key = "P-" + (p.jmeno || "") + "|" + (p.datumNarozeni || "");
        if (!personNodes.has(key)) {
          personNodes.set(key, {
            data: {
              id: key,
              label: p.jmeno,
              type: p.isLegalEntity ? "legalPerson" : "person",
              shared: p.memberships && p.memberships.length > 1,
            },
          });
        }
        return key;
      };
      for (const p of this.result.activePersons || []) {
        const pid = addPerson(p);
        for (const m of p.memberships || []) {
          elements.push({
            data: { id: pid + "-" + m.ico, source: pid, target: "F-" + m.ico, label: m.funkce || "" },
          });
        }
      }
      for (const p of this.result.sharedPersons || []) {
        const pid = addPerson(p);
        for (const m of p.memberships || []) {
          elements.push({
            data: { id: pid + "-" + m.ico + "-s", source: pid, target: "F-" + m.ico, label: m.funkce || "", shared: true },
          });
        }
      }
      for (const node of personNodes.values()) elements.push(node);

      const isDark = document.documentElement.classList.contains("dark");
      this.cy = window.cytoscape({
        container,
        elements,
        layout: { name: "cose", animate: false, nodeRepulsion: 8000, idealEdgeLength: 100, padding: 30 },
        style: [
          {
            selector: "node[type='firma']",
            style: {
              "background-color": isDark ? "#10b981" : "#059669",
              "color": "#ffffff",
              "label": "data(label)",
              "font-size": 11,
              "font-weight": "bold",
              "text-valign": "center",
              "text-halign": "center",
              "text-wrap": "wrap",
              "text-max-width": "120px",
              "width": "label",
              "height": "label",
              "padding": "8px",
              "shape": "round-rectangle",
            },
          },
          {
            selector: "node[type='person']",
            style: {
              "background-color": isDark ? "#60a5fa" : "#3b82f6",
              "color": "#ffffff",
              "label": "data(label)",
              "font-size": 10,
              "text-valign": "center",
              "text-halign": "center",
              "width": "label",
              "height": 22,
              "padding": "4px",
              "shape": "round-rectangle",
            },
          },
          {
            selector: "node[type='person'][?shared]",
            style: {
              "background-color": isDark ? "#f59e0b" : "#d97706",
              "border-width": 2,
              "border-color": isDark ? "#fbbf24" : "#b45309",
            },
          },
          {
            selector: "node[type='legalPerson']",
            style: {
              "background-color": isDark ? "#a78bfa" : "#8b5cf6",
              "color": "#ffffff",
              "label": "data(label)",
              "font-size": 10,
              "text-valign": "center",
              "text-halign": "center",
              "shape": "diamond",
              "width": 60,
              "height": 60,
            },
          },
          {
            selector: "edge",
            style: {
              "width": 1.5,
              "line-color": isDark ? "#475569" : "#94a3b8",
              "target-arrow-color": isDark ? "#475569" : "#94a3b8",
              "target-arrow-shape": "triangle",
              "curve-style": "bezier",
              "font-size": 8,
              "color": isDark ? "#cbd5e1" : "#64748b",
            },
          },
          {
            selector: "edge[?shared]",
            style: { "line-color": isDark ? "#fbbf24" : "#d97706", "target-arrow-color": isDark ? "#fbbf24" : "#d97706", "width": 2 },
          },
        ],
      });
      // Click na firmu = otevři její profil v search
      this.cy.on("tap", "node[type='firma']", (evt) => {
        const ico = evt.target.data("ico");
        if (ico) window.dispatchEvent(new CustomEvent("ares-open-profile", { detail: { ico } }));
      });
    },
    /** Unique key pro tentative kandidáta — pro Alpine x-model binding. */
    candidateKey(c) {
      return `${c.jmeno}|${c.prijmeni}`.toLowerCase();
    },
    /** Spočti počet aktivních (zaškrtnutých) tentative kandidátů. */
    activeCandidateCount() {
      if (!this.result?.tentativeCandidates) return 0;
      return this.result.tentativeCandidates.filter(
        (c) => this.tentativeSelections[this.candidateKey(c)],
      ).length;
    },
    /** Re-render s aktuální checkbox volbou. Vezme všechny IČO z aktivně
     *  zaškrtnutých kandidátů a spojí je s původním user inputem. */
    renderWithSelections() {
      const extra = new Set();
      for (const c of this.result?.tentativeCandidates ?? []) {
        if (!this.tentativeSelections[this.candidateKey(c)]) continue;
        for (const m of c.memberships ?? []) extra.add(m.ico);
      }
      this.run([...extra]);
    },
    /** Aktivováno custom eventem (holding discovery / personVazby): pre-fill
     *  IČO + spustit run(). Historický flag se čte z globálního Alpine store
     *  ($store.history.enabled) sdíleného s Profilem. */
    async seed(icos) {
      if (!Array.isArray(icos) || icos.length < 2) return;
      this.raw = icos.join("\n");
      await this.run();
    },
    /**
     * Nový profil firmy v searchSection RESETuje Mapu propojení na jediné
     * to nové IČO. Předchozí výsledky se zahodí — jinak by se míchaly firmy
     * z různých vyhledávání (PD MONT pak SimpleSolar = 2 holdingy v jednom
     * grafu = nedává smysl). Holding discovery pak buď `seed()` IČO sadu
     * dceřinek, nebo uživatel přidá ručně.
     */
    addIcoFromProfile(ico) {
      if (!ico) return;
      this.raw = ico;
      this.result = null;
      this.mermaidSvg = "";
      this.error = "";
    },
    /** Vyvolá vazby ze sharedPersons listu. */
    openPersonVazby(jmeno, datumNarozeni) {
      window.dispatchEvent(new CustomEvent("ares-open-person-vazby", {
        detail: { jmeno, datumNarozeni },
      }));
    },
  };
}

function personVazbySection() {
  return {
    visible: false,
    loading: false,
    vazbyError: "",
    result: null,
    selected: new Set(),
    form: {
      jmeno: "",
      datumNarozeni: "",
      includeHistorical: true,
    },
    init() {
      window.addEventListener("ares-open-person-vazby", (e) => {
        const { jmeno, datumNarozeni } = e.detail || {};
        if (!jmeno || !datumNarozeni) return;
        this.form.jmeno = jmeno;
        this.form.datumNarozeni = datumNarozeni;
        this.visible = true;
        // Necháme Alpine rerenderovat než scrollneme.
        Promise.resolve().then(() => {
          /* scroll removed */
          this.run();
        });
      });
    },
    close() {
      this.visible = false;
      this.result = null;
      this.selected = new Set();
    },
    async run() {
      this.vazbyError = "";
      this.result = null;
      this.selected = new Set();
      if (!this.form.jmeno || !this.form.datumNarozeni) {
        this.vazbyError = "Vyplň jméno a datum narození.";
        return;
      }
      this.loading = true;
      try {
        const r = await fetch("/api/persons/vazby", withHsToken({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jmeno: this.form.jmeno,
            datumNarozeni: this.form.datumNarozeni,
            includeHistorical: this.form.includeHistorical,
            resolveIco: true,
          }),
        }));
        if (!r.ok) {
          const e = await r.json().catch(() => ({ message: "HTTP " + r.status }));
          throw new Error(e.message || ("HTTP " + r.status));
        }
        this.result = await r.json();
      } catch (e) {
        this.vazbyError = "Vazby nelze načíst: " + e.message;
      } finally {
        this.loading = false;
      }
    },
    toggleIco(ico) {
      if (!ico) return;
      const next = new Set(this.selected);
      if (next.has(ico)) next.delete(ico);
      else next.add(ico);
      this.selected = next;
    },
    allResolvedSelected() {
      if (!this.result) return false;
      const uniqueResolvable = new Set();
      for (const v of this.result.vazby) {
        if (v.resolvedIco && v.ambiguousMatchCount <= 1) uniqueResolvable.add(v.resolvedIco);
      }
      if (uniqueResolvable.size === 0) return false;
      for (const ico of uniqueResolvable) if (!this.selected.has(ico)) return false;
      return true;
    },
    toggleAllResolved() {
      if (!this.result) return;
      if (this.allResolvedSelected()) {
        this.selected = new Set();
      } else {
        const next = new Set();
        for (const v of this.result.vazby) {
          if (v.resolvedIco && v.ambiguousMatchCount <= 1) next.add(v.resolvedIco);
        }
        this.selected = next;
      }
    },
    selectedIcos() {
      return [...this.selected];
    },
    seedGraph() {
      const icos = this.selectedIcos();
      if (icos.length < 2) return;
      window.dispatchEvent(new CustomEvent("ares-seed-graph", { detail: { icos } }));
    },
    /** Vrátí dedup-ed seznam všech jednoznačně vyřešených IČO ze všech vazeb. */
    allResolvedIcos() {
      if (!this.result) return [];
      const set = new Set();
      for (const v of this.result.vazby) {
        if (v.resolvedIco && v.ambiguousMatchCount <= 1) set.add(v.resolvedIco);
      }
      return [...set];
    },
    resolvedIcoCount() {
      return this.allResolvedIcos().length;
    },
    /** One-click: všechna vyřešená IČO → Mapa propojení. Bez nutnosti
     *  ručního výběru checkboxy. */
    openAllInMap() {
      const icos = this.allResolvedIcos();
      if (icos.length < 2) return;
      window.dispatchEvent(new CustomEvent("ares-seed-graph", { detail: { icos } }));
    },
    copiedNotice: "",
    async copyIcosToClipboard() {
      const icos = this.allResolvedIcos();
      if (icos.length === 0) return;
      const text = icos.join(", ");
      try {
        await navigator.clipboard.writeText(text);
        this.copiedNotice = `✓ Zkopírováno (${icos.length})`;
      } catch {
        // fallback bez clipboard API
        this.copiedNotice = "✗ Selhalo (zkopíruj ručně)";
      }
      setTimeout(() => { this.copiedNotice = ""; }, 2500);
    },
    /**
     * Uživatel zná IČO další firmy, kde sedí prohlížená osoba.
     * Spustíme paralelně DD + VR endpointy (oba plní lokální index),
     * pak rerun vazby. Po úspěšném doplnění vyčistíme input.
     */
    addIco: "",
    addingIco: false,
    addError: "",
    async addCompanyAndRefresh() {
      const raw = (this.addIco || "").trim().replace(/^CZ\s*/i, "").replace(/\s|-|\./g, "");
      if (!/^\d{7,8}$/.test(raw)) {
        this.addError = "Zadej platné IČO (7–8 číslic).";
        return;
      }
      this.addError = "";
      this.addingIco = true;
      try {
        const [dd, vr] = await Promise.allSettled([
          fetch(`/api/dd/${encodeURIComponent(raw)}`, withHsToken()),
          fetch(`/api/vr/${encodeURIComponent(raw)}`, withHsToken()),
        ]);
        if (dd.status === "rejected" && vr.status === "rejected") {
          this.addError = "Obě prověrky selhaly. Ověř IČO v ARES.";
          return;
        }
        if (dd.status === "fulfilled" && !dd.value.ok) {
          this.addError = `ARES DD vrátilo HTTP ${dd.value.status}.`;
          return;
        }
        this.addIco = "";
        await this.run(); // re-fetch vazby
      } catch (e) {
        this.addError = "Doplnění selhalo: " + e.message;
      } finally {
        this.addingIco = false;
      }
    },
  };
}

function addressSection() {
  return {
    adresa: "",
    loading: false,
    error: "",
    result: null,
    init() {
      const url = readUrl();
      if (url.address) {
        this.adresa = url.address;
        this.run();
      }
    },
    async run() {
      this.error = "";
      this.result = null;
      const a = (this.adresa || "").trim();
      if (a.length < 3) {
        this.error = "Adresa musí mít alespoň 3 znaky.";
        return;
      }
      this.loading = true;
      try {
        this.result = await jsonFetch(`/api/search/address?adresa=${encodeURIComponent(a)}&limit=50`);
        updateUrl({ address: a });
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}

/**
 * Inline loader pro DPH compliance data v DD kartě. Fetchne ADIS endpoint
 * po vyrendrování DD reportu a vystaví reactive `adis` property pro Alpine.
 */

function formatCZK(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " mld Kč";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + " mil Kč";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " tis Kč";
  return Math.round(n) + " Kč";
}
window.formatCZK = formatCZK;

// Tooltip helper: vrátí přepočet CZK → EUR podle aktuálního kurzu ČNB
// (uložen v window.__cnbRates widgetem). Použito jako `:title` na headline
// částkách v Smlouvy/Dotace tak, aby uživatel viděl řádové porovnání v euro.
function czkAsEurTooltip(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  const eur = window.__cnbRates?.core?.EUR?.rate;
  if (!eur) return "";
  const v = n / eur;
  let formatted;
  if (v >= 1e6) formatted = (v / 1e6).toFixed(2) + " mil €";
  else if (v >= 1e3) formatted = (v / 1e3).toFixed(0) + " tis €";
  else formatted = Math.round(v) + " €";
  return `≈ ${formatted}  (kurz ČNB k ${window.__cnbRates.validFor})`;
}
window.czkAsEurTooltip = czkAsEurTooltip;

/**
 * EU consolidated sanctions screening. Z reportu vytáhneme jména
 * statutárních orgánů + samotnou firmu (pro případ, že je sankcionován
 * jako entity); pošleme batch POST a vykreslíme případné shody.
 */
function ddEuSanctionsLoader() {
  return {
    result: null,
    loading: false,
    sanctionsError: "",
    async screen(report) {
      if (!report) return;
      const names = [];
      if (report.obchodniJmeno) names.push(report.obchodniJmeno);
      const clenove = (report.statutary && report.statutary.clenove) || [];
      for (const c of clenove) {
        if (c.jmeno) names.push(c.jmeno);
      }
      if (names.length === 0) return;
      this.loading = true;
      this.result = null;
      this.sanctionsError = "";
      try {
        const r = await fetch("/api/eu-sanctions/screen", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ names }),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        this.result = await r.json();
      } catch (e) {
        this.sanctionsError = "EU sankce nelze načíst: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}

/**
 * Holding discovery — z parent IČO rozkryje strukturu holdingu (BFS přes
 * jednatele a akcionáře) a výsledek pošle do Mapy propojení jako seed.
 * Mermaid graf v graphSection se pak vykreslí automaticky.
 */
function holdingDiscovery() {
  return {
    depth: 2,
    loading: false,
    error: "",
    result: null,
    elapsed: 0,
    showAdvanced: false,
    lastRunIco: null,
    autoTriggered: false,
    /**
     * Init: poslouchá ares-report-loaded event (z ddSection.run()).
     * Pokud je firma „holding-likely" (a.s. s ≥5 aktivními jednateli),
     * automaticky spustí Rozkrýt. Pro OSVČ / drobné s.r.o. skip.
     */
    init() {
      window.addEventListener("ares-report-loaded", (e) => this.maybeAutoRun(e.detail));
      // Recovery: pokud ddSection už event vystřelila ještě než se
      // holdingDiscovery zaregistroval, vezmeme cached snapshot z windowu.
      if (window.__aresLatestReport) {
        this.maybeAutoRun(window.__aresLatestReport);
      }
    },
    maybeAutoRun(detail) {
      if (!detail?.ico) return;
      if (this.lastRunIco === detail.ico) return;
      // Heuristika: spusť auto-trigger pro libovolnou firmu s ≥1 aktivním
      // statutárem, SKIP jen pro pure OSVČ (pravniForma 107/108) kde není
      // co rozkrývat (jednatel = subjekt sám). Tím se chytnou i menší s.r.o.
      // s vazbou na další firmy přes jednatele (PD MONT → Dubický OSVČ).
      const pf = String(detail.pravniForma || "");
      const isOSVC = pf === "107" || pf === "108";
      const hasStatutar = (detail.aktivniCount || 0) >= 1;
      if (isOSVC || !hasStatutar) return;
      this.autoTriggered = true;
      this.run(detail.ico);
    },
    async run(parentIco) {
      if (!parentIco) return;
      this.loading = true;
      this.error = "";
      this.result = null;
      this.elapsed = 0;
      const t0 = performance.now();
      try {
        const r = await fetch("/api/holding/discover", withHsToken({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ico: parentIco,
            depth: this.depth,
            maxIcos: 50,
            includeHistorical: Alpine.store("history").enabled,
          }),
        }));
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.message || `HTTP ${r.status}`);
        }
        this.result = await r.json();
        this.elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        // Mapa dostane jen IČO. Historický flag čte z globálního store
        // ($store.history.enabled) — již synced s Profilem checkboxem.
        const icos = [parentIco, ...this.result.discovered.map((c) => c.ico)];
        if (icos.length >= 2) {
          window.dispatchEvent(new CustomEvent("ares-seed-graph", { detail: { icos } }));
        }
      } catch (e) {
        this.error = "Rozkrytí selhalo: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}

/** Časová osa firmy — vertical timeline events from ARES VR. */
function ddTimelineLoader() {
  return {
    result: null,
    loading: false,
    error: "",
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.result = null;
      this.error = "";
      try {
        this.result = await jsonFetch(`/api/timeline/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.error = "Časovou osu nelze načíst: " + e.message;
      } finally {
        this.loading = false;
      }
    },
    timelineIcon(type) {
      return {
        "vznik": "🟢",
        "zanik": "🔴",
        "jmeno": "✏️",
        "jmeno-konec": "✂️",
        "statutar-vznik": "👤",
        "statutar-zanik": "👋",
        "akcionar-vznik": "🤝",
        "akcionar-zanik": "🚪",
        "kapital": "💰",
        "kapital-konec": "📉",
      }[type] || "•";
    },
    timelineColor(type) {
      if (type === "vznik") return "bg-emerald-500";
      if (type === "zanik") return "bg-rose-500";
      if (type.endsWith("-zanik") || type === "jmeno-konec" || type === "kapital-konec") return "bg-amber-400";
      return "bg-blue-500";
    },
  };
}

function ddVrLoader() {
  return {
    vr: null,
    loading: false,
    vrError: "",
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.vr = null;
      this.vrError = "";
      try {
        this.vr = await jsonFetch(`/api/vr/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.vrError = "Veřejný rejstřík nelze načíst: " + e.message;
      } finally {
        this.loading = false;
      }
    },
    openPersonVazby(jmeno, datumNarozeni) {
      window.dispatchEvent(new CustomEvent("ares-open-person-vazby", {
        detail: { jmeno, datumNarozeni },
      }));
    },
  };
}

function ddJerrsLoader() {
  return {
    jerrs: null,
    loading: false,
    jerrsError: "",
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.jerrs = null;
      this.jerrsError = "";
      try {
        this.jerrs = await jsonFetch(`/api/jerrs/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.jerrsError = "JERRS index nelze načíst: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}

function ddIsirLoader() {
  return {
    isir: null,
    loading: false,
    isirError: "",
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.isir = null;
      this.isirError = "";
      try {
        this.isir = await jsonFetch(`/api/isir/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.isirError = "ISIR detail nelze načíst: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}

function ddDotaceLoader() {
  return {
    dotace: null,
    loading: false,
    dotaceError: "",
    formatCZK,
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.dotace = null;
      this.dotaceError = "";
      try {
        this.dotace = await jsonFetch(`/api/dotace/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.dotaceError = "Dotace nelze načíst: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}

function ddSmlouvyLoader() {
  return {
    smlouvy: null,
    loading: false,
    smlouvyError: "",
    formatCZK,
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.smlouvy = null;
      this.smlouvyError = "";
      try {
        this.smlouvy = await jsonFetch(`/api/smlouvy/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.smlouvyError = "Smlouvy nelze načíst: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}

function ddUboLoader() {
  return {
    ubo: null,
    loading: false,
    uboError: "",
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.ubo = null;
      this.uboError = "";
      try {
        this.ubo = await jsonFetch(`/api/ubo/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.uboError = "UBO data nelze načíst: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}

function ddAdisLoader() {
  return {
    adis: null,
    loading: false,
    adisError: "",
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.adis = null;
      this.adisError = "";
      try {
        this.adis = await jsonFetch(`/api/adis/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.adisError = "DPH compliance check selhal: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}

/**
 * Načte stav volitelných integrací (Hlídač státu API). Footer atribuce
 * citujícího Hlídače státu se zobrazí pouze pokud je integrace aktivní.
 */
function featuresStatus() {
  return {
    features: { hlidacstatu: false },
    async init() {
      try {
        const r = await fetch("/api/features");
        if (r.ok) this.features = await r.json();
      } catch {
        /* offline / starting up — keep defaults (all off) */
      }
    },
  };
}

/**
 * Mini-widget zobrazující denní kurzy ČNB. Načítá pouze jednou za session
 * (na serveru je 6h cache, není potřeba spam refresh).
 */
function cnbRatesWidget() {
  return {
    open: false,
    rates: null,
    async init() {
      try {
        const r = await fetch("/api/cnb/rates");
        if (r.ok) {
          this.rates = await r.json();
          window.__cnbRates = this.rates;
        }
      } catch {
        /* offline — keep null, the template falls back to placeholder */
      }
    },
  };
}

/**
 * HS token settings — per-user token saved in localStorage, sent
 * as X-Hlidac-Token header. Bez tokenu uživatel sdílí serverový
 * token (rate limit shared mezi všechny návštěvníky).
 */
function hsTokenSettings() {
  return {
    open: false,
    draft: "",
    saved: false,
    hasOwnToken: false,
    tokenLen: 0,
    init() {
      try {
        const t = (localStorage.getItem(STORAGE_HS_TOKEN) || "").trim();
        this.draft = t;
        this.hasOwnToken = Boolean(t);
        this.tokenLen = t.length;
      } catch {
        /* ignore */
      }
    },
    save() {
      const t = (this.draft || "").trim();
      try {
        if (t) localStorage.setItem(STORAGE_HS_TOKEN, t);
        else localStorage.removeItem(STORAGE_HS_TOKEN);
      } catch {
        /* ignore */
      }
      this.hasOwnToken = Boolean(t);
      this.tokenLen = t.length;
      this.saved = true;
      setTimeout(() => { this.saved = false; }, 2500);
    },
    clearToken() {
      this.draft = "";
      this.save();
    },
  };
}

/**
 * Sidebar scroll-spy — IntersectionObserver na všech kartách v Profilu,
 * zvýrazní v sidebaru tu, která je aktuálně v rootMargin top zóně.
 * Threshold 0 + rootMargin '-80px 0px -50% 0px' = highlight zóna je
 * horních cca 50% viewportu od stickyho headeru.
 */
function sidebarScrollSpy() {
  return {
    active: "dd-profil",
    observer: null,
    init() {
      // Počkat až se DOM ustálí (Alpine + Mermaid render).
      requestAnimationFrame(() => {
        this.setup();
      });
    },
    setup() {
      const ids = [
        "dd-profil", "dd-vr", "dd-ubo", "dd-dotace", "dd-smlouvy",
        "dd-adis", "dd-isir", "dd-jerrs", "dd-sankce", "dd-zivno",
      ];
      const targets = ids.map((id) => document.getElementById(id)).filter(Boolean);
      if (targets.length === 0) return;
      this.observer = new IntersectionObserver(
        (entries) => {
          // Pick the section whose top is CLOSEST to the trigger line (top of
          // active zone, just below sticky header). To dělá scroll-spy přesnější
          // — postupně se highlight stahuje s tím jak uživatel scrolluje. Bez
          // tohoto by se aktivovala vždy nejvyšší viditelná sekce (často ta
          // předchozí kterou už uživatel přeskočil).
          const visible = entries
            .filter((e) => e.isIntersecting)
            .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
          if (visible.length > 0) this.active = visible[0].target.id;
        },
        {
          // Úzká „active zone" hned pod sticky headerem — minimalizuje
          // překryv mezi sousedními kartami.
          rootMargin: "-110px 0px -80% 0px",
          threshold: 0,
        },
      );
      for (const t of targets) this.observer.observe(t);
    },
  };
}

/**
 * Globální keyboard shortcuts:
 * - "/" nebo Cmd+K → focus search input
 * - Escape → odběr fokusu / zavření popoverů (Alpine to řeší samo přes
 *   click.outside, ale Esc je rychlejší)
 */
document.addEventListener("alpine:init", () => {
  document.addEventListener("keydown", (e) => {
    const tag = (e.target?.tagName || "").toLowerCase();
    const inEditable = tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable;
    if (!inEditable && (e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey)))) {
      e.preventDefault();
      const input = document.querySelector('section#profil input[type="text"]');
      if (input) {
        input.focus();
        input.select();
      }
    }
  });
});

function themeToggle() {
  return {
    isDark: false,
    init() {
      this.isDark = document.documentElement.classList.contains("dark");
    },
    toggle() {
      this.isDark = !this.isDark;
      document.documentElement.classList.toggle("dark", this.isDark);
      try {
        localStorage.setItem("icovazby:theme", this.isDark ? "dark" : "light");
      } catch {
        /* private mode, ignore */
      }
      // re-init Mermaid with new theme and re-render visible graph
      if (window.__mermaidReinit) window.__mermaidReinit();
      window.dispatchEvent(new CustomEvent("ares-theme-changed", { detail: { dark: this.isDark } }));
    },
  };
}

function historyBar() {
  return {
    open: false,
    recent: [],
    bookmarks: [],
    init() {
      this.refresh();
      window.addEventListener("ares-history-changed", () => this.refresh());
    },
    refresh() {
      this.recent = loadList(STORAGE_RECENT);
      this.bookmarks = loadList(STORAGE_BOOKMARKS);
    },
    async run(ico) {
      // dispatch an event the search section listens for, mirroring DD's pattern
      window.dispatchEvent(new CustomEvent("open-search", { detail: { ico } }));
    },
    bookmark(entry) {
      if (!entry || !entry.ico) return;
      const list = loadList(STORAGE_BOOKMARKS).filter((b) => b.ico !== entry.ico);
      list.unshift({ ico: entry.ico, obchodniJmeno: entry.obchodniJmeno, at: Date.now() });
      saveList(STORAGE_BOOKMARKS, list);
      this.refresh();
    },
    unbookmark(ico) {
      saveList(
        STORAGE_BOOKMARKS,
        loadList(STORAGE_BOOKMARKS).filter((b) => b.ico !== ico),
      );
      this.refresh();
    },
    clearRecent() {
      saveList(STORAGE_RECENT, []);
      this.refresh();
    },
  };
}

function alertSubscribe() {
  return {
    email: "",
    open: false,
    submitting: false,
    notice: "",
    error: "",
    async submit(ico) {
      this.error = "";
      this.notice = "";
      if (!/^\S+@\S+\.\S+$/.test(this.email)) {
        this.error = "Neplatný e-mail.";
        return;
      }
      this.submitting = true;
      try {
        const r = await fetch("/api/alerts/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: this.email, ico }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.message || "Chyba při odběru.");
        this.notice = data.pendingVerification
          ? "Zkontroluj e-mail a klikni na potvrzovací odkaz."
          : "Odběr aktivní.";
        this.email = "";
      } catch (e) {
        this.error = e.message;
      } finally {
        this.submitting = false;
      }
    },
  };
}

// Expose factories on window for Alpine
window.alertSubscribe = alertSubscribe;
window.searchSection = searchSection;
window.ddSection = ddSection;
window.graphSection = graphSection;
window.addressSection = addressSection;
window.historyBar = historyBar;
window.themeToggle = themeToggle;
window.ddAdisLoader = ddAdisLoader;
window.ddUboLoader = ddUboLoader;
window.ddSmlouvyLoader = ddSmlouvyLoader;
window.ddDotaceLoader = ddDotaceLoader;
window.ddIsirLoader = ddIsirLoader;
window.ddJerrsLoader = ddJerrsLoader;
window.ddTimelineLoader = ddTimelineLoader;

/** Diff mode — side-by-side porovnání 2 firem. */
function compareSection() {
  return {
    icoA: "",
    icoB: "",
    resultA: null,
    resultB: null,
    loading: false,
    error: "",
    init() {
      const url = readUrl();
      if (url.a && url.b) {
        this.icoA = url.a;
        this.icoB = url.b;
        this.run();
      }
    },
    async run() {
      this.error = "";
      this.resultA = null;
      this.resultB = null;
      const a = this.icoA.replace(/\D/g, "").padStart(8, "0");
      const b = this.icoB.replace(/\D/g, "").padStart(8, "0");
      if (!ICO_RE.test(a) || !ICO_RE.test(b)) {
        this.error = "Obě IČO musí být 8místná čísla.";
        return;
      }
      if (a === b) {
        this.error = "Zadej 2 různé IČO.";
        return;
      }
      this.loading = true;
      try {
        const [ra, rb] = await Promise.all([
          jsonFetch(`/api/dd/${a}`),
          jsonFetch(`/api/dd/${b}`),
        ]);
        this.resultA = ra;
        this.resultB = rb;
        updateUrl({ a, b });
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    compareRows() {
      if (!this.resultA || !this.resultB) return [];
      const get = (r, path) => path.split(".").reduce((o, k) => o?.[k], r);
      const rows = [
        { label: "Risk", path: "risk.level" },
        { label: "Vznik", path: "identification.datumVzniku" },
        { label: "Zánik", path: "identification.datumZaniku" },
        { label: "Právní forma", path: "identification.pravniForma" },
        { label: "Sídlo", path: "sidloText" },
        { label: "DPH", path: "vat.platceDph" },
        { label: "DIČ", path: "vat.dic" },
        { label: "Aktivních statutářů", path: "statutary.aktivniCount" },
        { label: "Insolvence", path: "insolvenci.isInsolvent" },
        { label: "CZ-NACE [0]", path: "identification.czNace.0" },
        { label: "Aktivní živnosti", path: "trade_licenses.aktivni" },
      ];
      return rows.map((r) => {
        const va = get(this.resultA, r.path);
        const vb = get(this.resultB, r.path);
        const fmt = (v) => {
          if (v === null || v === undefined || v === "") return null;
          if (typeof v === "boolean") return v ? "Ano" : "Ne";
          return String(v);
        };
        const valueA = fmt(va);
        const valueB = fmt(vb);
        return { label: r.label, valueA, valueB, diff: valueA !== valueB };
      });
    },
  };
}
window.compareSection = compareSection;

/** Bulk DD — paralelní /api/dd pro list IČO, CSV export. */
function bulkSection() {
  return {
    raw: "",
    loading: false,
    error: "",
    results: [],
    progress: 0,
    total: 0,
    init() {},
    parseIcos() {
      return [...new Set(
        (this.raw || "")
          .split(/[\s,;\n]+/g)
          .map((s) => s.trim().replace(/^CZ\s*/i, "").replace(/\s|-|\./g, "").padStart(8, "0"))
          .filter((s) => ICO_RE.test(s)),
      )];
    },
    async loadFile(file) {
      if (!file) return;
      const text = await file.text();
      this.raw = text;
    },
    async run() {
      this.error = "";
      this.results = [];
      const icos = this.parseIcos();
      if (icos.length === 0) {
        this.error = "Žádné platné IČO. Vlož 8místná čísla, 1 na řádku.";
        return;
      }
      if (icos.length > 50) {
        this.error = "Maximum 50 IČO na bulk request.";
        return;
      }
      this.loading = true;
      this.total = icos.length;
      this.progress = 0;
      const out = [];
      const CONCURRENCY = 5;
      let cursor = 0;
      const worker = async () => {
        while (cursor < icos.length) {
          const i = cursor++;
          const ico = icos[i];
          try {
            const dd = await jsonFetch(`/api/dd/${ico}`);
            out[i] = {
              ico,
              obchodniJmeno: dd.obchodniJmeno,
              risk: dd.risk?.level || "?",
              dph: dd.vat?.platceDph ? "ano" : "ne",
              statutary: dd.statutary?.aktivniCount ?? 0,
              insolvence: dd.insolvenci?.isInsolvent ? "ANO" : "ne",
              findings: (dd.risk?.findings || []).map((f) => f.message).join("; "),
            };
          } catch (e) {
            out[i] = { ico, obchodniJmeno: "(chyba)", risk: "error", dph: "—", statutary: "—", insolvence: "—", findings: e.message };
          }
          this.progress++;
          this.results = out.filter(Boolean);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      this.loading = false;
    },
    exportCsv() {
      const headers = ["IČO", "Jméno", "Risk", "DPH", "Statutáři", "Insolvence", "Findings"];
      const rows = this.results.map((r) => [r.ico, r.obchodniJmeno, r.risk, r.dph, r.statutary, r.insolvence, r.findings]);
      const csv = [headers, ...rows].map((row) => row.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
      const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `icovazby-bulk-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
  };
}
window.bulkSection = bulkSection;

const STORAGE_SAVED = "icovazby:saved-searches";

/** Saved searches — lokální storage list IČO. */
function savedSection() {
  return {
    searches: [],
    newName: "",
    newQuery: "",
    subscribeMsg: "",
    init() {
      try {
        const raw = localStorage.getItem(STORAGE_SAVED);
        this.searches = raw ? JSON.parse(raw) : [];
      } catch {
        this.searches = [];
      }
    },
    save() {
      try {
        localStorage.setItem(STORAGE_SAVED, JSON.stringify(this.searches));
      } catch {
        /* private mode */
      }
    },
    parseQuery(q) {
      return [...new Set(
        (q || "")
          .split(/[\s,;\n]+/g)
          .map((s) => s.trim().replace(/^CZ\s*/i, "").replace(/\s|-|\./g, "").padStart(8, "0"))
          .filter((s) => ICO_RE.test(s)),
      )];
    },
    add() {
      if (!this.newName.trim()) return;
      const icos = this.parseQuery(this.newQuery);
      if (icos.length === 0) return;
      this.searches.unshift({
        id: Date.now().toString(),
        name: this.newName.trim(),
        icos,
        createdAt: new Date().toISOString(),
        subscribed: false,
      });
      this.newName = "";
      this.newQuery = "";
      this.save();
    },
    remove(id) {
      this.searches = this.searches.filter((s) => s.id !== id);
      this.save();
    },
    load(s) {
      const bulk = document.querySelector("#bulk textarea");
      if (bulk) {
        bulk.value = s.icos.join("\n");
        bulk.dispatchEvent(new Event("input", { bubbles: true }));
      }
      document.querySelector("#bulk")?.scrollIntoView({ behavior: "smooth" });
    },
    map(s) {
      window.dispatchEvent(new CustomEvent("ares-seed-graph", {
        detail: { icos: s.icos },
      }));
      document.querySelector("#graph")?.scrollIntoView({ behavior: "smooth" });
    },
    async subscribe(s) {
      const email = prompt(`Zadej email pro upozornění na změny v "${s.name}" (${s.icos.length} IČO):`);
      if (!email || !email.includes("@")) return;
      this.subscribeMsg = `Přihlašuji ${s.icos.length} IČO…`;
      let ok = 0;
      for (const ico of s.icos) {
        try {
          await jsonFetch("/api/alerts/subscribe", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, ico }),
          });
          ok++;
        } catch {
          /* skip */
        }
      }
      s.subscribed = true;
      this.save();
      this.subscribeMsg = `Přihlášeno ${ok} / ${s.icos.length} IČO. Ověř e-mail pro každé.`;
    },
  };
}
window.savedSection = savedSection;

/** Datová schránka — heuristika z pravniForma + datumZaniku. */
function ddDatovaSchrankaCard() {
  return {
    status(report) {
      const pf = String(report?.identification?.pravniForma ?? "");
      const zanik = report?.identification?.datumZaniku;
      if (zanik) {
        return { label: "🚫 N/A — firma zanikla", explain: "Datová schránka byla zrušena s zánikem subjektu." };
      }
      const isFyzicka = pf === "107" || pf === "108";
      const isPravnicka = !isFyzicka && pf !== "";
      if (isPravnicka) {
        return {
          label: "✅ Pravděpodobně ANO (povinně ze zákona)",
          explain: "Právnické osoby zapsané do veřejných rejstříků mají datovou schránku zřízenou automaticky od 2009 (zák. č. 300/2008 Sb.). Konkrétní ID viz ISDS lookup.",
        };
      }
      if (isFyzicka) {
        return {
          label: "✅ Pravděpodobně ANO (od 2023)",
          explain: "OSVČ/živnostníci mají datovou schránku povinně od 1. 1. 2023. Před tím dobrovolně.",
        };
      }
      return {
        label: "❔ Nelze rozhodnout (neznámá právní forma)",
        explain: "Doporučujeme ověřit ručně.",
      };
    },
  };
}
window.ddDatovaSchrankaCard = ddDatovaSchrankaCard;

/** Ochranné známky přes TMView (EUIPN). */
function ddTrademarksLoader() {
  return {
    result: null,
    loading: false,
    error: "",
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.result = null;
      this.error = "";
      try {
        this.result = await jsonFetch(`/api/trademarks/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.error = "TMView dotaz selhal: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}
window.ddTrademarksLoader = ddTrademarksLoader;
window.ddVrLoader = ddVrLoader;
window.holdingDiscovery = holdingDiscovery;
window.ddEuSanctionsLoader = ddEuSanctionsLoader;
window.personVazbySection = personVazbySection;
window.featuresStatus = featuresStatus;
window.cnbRatesWidget = cnbRatesWidget;
window.hsTokenSettings = hsTokenSettings;
window.sidebarScrollSpy = sidebarScrollSpy;
