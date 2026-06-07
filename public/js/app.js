/**
 * ares-web — Alpine.js controllers and API glue.
 * Vanilla, no build step. Loaded from /public/js/app.js.
 */

const ICO_RE = /^\d{7,8}$/;
const STORAGE_RECENT = "ares-web:recent";
const STORAGE_BOOKMARKS = "ares-web:bookmarks";
const STORAGE_DD_COLLAPSE = "ares-web:dd-collapsed";
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

const STORAGE_HS_TOKEN = "ares-web:hs-token";

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
            document.getElementById("search")?.scrollIntoView({ behavior: "smooth" });
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
        } else {
          const u = `/api/search/companies?obchodniJmeno=${encodeURIComponent(q)}&limit=25`;
          const r = await jsonFetch(u);
          this.results = r.vysledky || [];
          this.totalFound = r.celkemNalezeno || 0;
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
      document.getElementById("search")?.scrollIntoView({ behavior: "smooth" });
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
      if (url.ico && url.action === "dd") {
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
        updateUrl({ ico: this.report.ico, action: "dd" });
        document.getElementById("dd")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
    includeHistorical: false,
    loading: false,
    error: "",
    result: null,
    mermaidSvg: "",
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
    async run() {
      this.error = "";
      this.result = null;
      this.mermaidSvg = "";
      const icos = this.parseIcos(this.raw);
      if (icos.length < 2) {
        this.error = "Zadej alespoň 2 platná IČO.";
        return;
      }
      if (icos.length > 50) {
        this.error = "Maximum 50 IČO na jeden dotaz.";
        return;
      }
      this.loading = true;
      try {
        this.result = await jsonFetch("/api/cross-persons", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            icos,
            includeHistorical: this.includeHistorical,
            emitMermaid: true,
          }),
        });
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
    /** Aktivováno custom eventem z personVazbySection — pre-fill IČO a spustit. */
    async seed(icos) {
      if (!Array.isArray(icos) || icos.length < 2) return;
      this.raw = icos.join("\n");
      await this.run();
      document.getElementById("graph")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
          document.getElementById("vazby")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
        localStorage.setItem("ares-web:theme", this.isDark ? "dark" : "light");
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

// Expose factories on window for Alpine
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
window.ddVrLoader = ddVrLoader;
window.ddEuSanctionsLoader = ddEuSanctionsLoader;
window.personVazbySection = personVazbySection;
window.featuresStatus = featuresStatus;
window.cnbRatesWidget = cnbRatesWidget;
window.hsTokenSettings = hsTokenSettings;
