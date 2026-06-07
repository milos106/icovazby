/**
 * ares-web — Alpine.js controllers and API glue.
 * Vanilla, no build step. Loaded from /public/js/app.js.
 */

const ICO_RE = /^\d{7,8}$/;
const STORAGE_RECENT = "ares-web:recent";
const STORAGE_BOOKMARKS = "ares-web:bookmarks";
const RECENT_LIMIT = 10;

async function jsonFetch(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data.message || data.error || `HTTP ${r.status}`);
  }
  return data;
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
        } else {
          const u = `/api/search/companies?obchodniJmeno=${encodeURIComponent(q)}&limit=25`;
          const r = await jsonFetch(u);
          this.results = r.vysledky || [];
          this.totalFound = r.celkemNalezeno || 0;
          if (this.results.length === 0) this.error = `Nic nenalezeno pro "${q}".`;
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
window.featuresStatus = featuresStatus;
