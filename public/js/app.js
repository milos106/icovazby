/**
 * icovazby — Alpine.js controllers and API glue.
 * Vanilla, no build step. Loaded from /public/js/app.js.
 */

// ── Globální „busy" signál ─────────────────────────────────────────────────
// Jakákoli delší operace = volání /api/. Monkey-patchneme fetch a počítáme
// in-flight API requesty; když nějaké běží déle než ~180 ms, přidáme na <html>
// třídu `app-busy` → CSS nastaví cursor:progress („hodiny"). Práh zabrání
// blikání u rychlých (cachovaných) odpovědí. Platí pro v1 i v2 (oba načítají
// tenhle app.js); pokrývá profil, karty, graf/ego, holding, AI, bulk… vše.
(function () {
  try {
    var n = 0, timer = null, root = document.documentElement;
    var sync = function () {
      if (n > 0) {
        if (!timer && !root.classList.contains("app-busy")) {
          timer = setTimeout(function () { timer = null; if (n > 0) root.classList.add("app-busy"); }, 180);
        }
      } else {
        if (timer) { clearTimeout(timer); timer = null; }
        root.classList.remove("app-busy");
      }
    };
    var orig = window.fetch;
    if (typeof orig === "function") {
      window.fetch = function (input) {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        var track = /\/api\//.test(url);
        if (track) { n++; sync(); }
        var done = function () { if (track) { n = Math.max(0, n - 1); sync(); } };
        return orig.apply(this, arguments).then(function (r) { done(); return r; }, function (e) { done(); throw e; });
      };
    }
  } catch (e) { /* fetch tracking je best-effort */ }
})();

const ICO_RE = /^\d{7,8}$/;
const STORAGE_RECENT = "icovazby:recent";
const STORAGE_BOOKMARKS = "icovazby:bookmarks";
const STORAGE_DD_COLLAPSE = "icovazby:dd-collapsed";
const STORAGE_SECTIONS = "icovazby:sections-hidden";
const STORAGE_INVESTIGATIONS = "icovazby:investigations"; // D+e — seznam „mých" uložených vyšetřování (link + label v prohlížeči)

// Sekce, které lze v Nastavení skrýt. Profil zůstává vždy viditelný.
// Klíče slouží zároveň jako section id v DOM a key v localStorage.
const SECTION_DEFS = [
  { key: "dd-notes", label: "📝 Moje poznámky", group: "Profil firmy" },
  { key: "dd-ai-summary", label: "🤖 AI souhrn (Claude)", group: "Profil firmy", dalsi: true },
  { key: "dd-vr", label: "⚖️ Veřejný rejstřík (OR)", group: "Profil firmy", dalsi: true },
  { key: "dd-ubo", label: "👥 Skuteční majitelé (UBO)", group: "Profil firmy", dalsi: true },
  { key: "dd-dotace", label: "💸 Dotace", group: "Profil firmy", dalsi: true },
  { key: "dd-smlouvy", label: "💰 Veřejné zakázky", group: "Profil firmy", dalsi: true },
  { key: "dd-adis", label: "🏦 DPH (ADIS)", group: "Profil firmy", dalsi: true },
  { key: "dd-isir", label: "⚖️ Insolvence (ISIR)", group: "Profil firmy", dalsi: true },
  { key: "dd-jerrs", label: "🏦 ČNB JERRS", group: "Profil firmy", dalsi: true },
  { key: "dd-sankce", label: "🇪🇺 EU sankce", group: "Profil firmy", dalsi: true },
  { key: "dd-zivno", label: "🏷️ Živnosti", group: "Profil firmy", dalsi: true },
  { key: "dd-timeline", label: "📜 Časová osa", group: "Profil firmy", dalsi: true },
  { key: "dd-upv", label: "™ Ochranné známky (ÚPV)", group: "Profil firmy", dalsi: true },
  { key: "dd-ds", label: "📬 Datová schránka", group: "Profil firmy", dalsi: true },
  { key: "dd-katastr", label: "🏠 Nemovitosti (Katastr, brzy)", group: "Profil firmy", dalsi: true },
  { key: "osoby", label: "🔗 Vazby osoby", group: "Sekce" },
  { key: "graph", label: "🌐 Mapa propojení", group: "Sekce" },
  { key: "address", label: "🏢 Hledat na adrese", group: "Sekce" },
  { key: "saved", label: "📑 Uložená vyhledávání", group: "Sekce" },
  { key: "bulk", label: "📋 Prověrka více firem", group: "Sekce" },
  { key: "compare", label: "⚖️ Porovnat 2 firmy", group: "Sekce" },
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

  // AI access store — BYO klíč + provider/model výběr.
  // Fáze 1 monetizace: AI souhrn defaultně skryt. Když user uloží klíč
  // v Settings (Anthropic Claude / Google Gemini), karta se odemkne,
  // request jde s X-LLM-Provider/Model/Key hlavičkami.
  // Backward compat: starý klíč icovazby:anthropic-key → migrace do icovazby:llm-key.
  window.Alpine.store("aiAccess", {
    provider: (() => {
      try { return localStorage.getItem("icovazby:llm-provider") || "anthropic"; } catch { return "anthropic"; }
    })(),
    model: (() => {
      try { return localStorage.getItem("icovazby:llm-model") || "claude-haiku-4-5-20251001"; } catch { return "claude-haiku-4-5-20251001"; }
    })(),
    apiKey: (() => {
      try {
        return localStorage.getItem("icovazby:llm-key") ||
               localStorage.getItem("icovazby:anthropic-key") || "";
      } catch { return ""; }
    })(),
    set(field, value) {
      const trimmed = (value ?? "").trim();
      this[field] = trimmed;
      const storageKey = field === "apiKey" ? "icovazby:llm-key" : `icovazby:llm-${field}`;
      try {
        if (trimmed) localStorage.setItem(storageKey, trimmed);
        else localStorage.removeItem(storageKey);
      } catch { /* private mode */ }
    },
    enabled() { return this.apiKey.length > 0; },
    // Když user vybere provider, nastav default model.
    onProviderChange(newProvider) {
      this.set("provider", newProvider);
      if (newProvider === "anthropic" && !this.model.startsWith("claude-")) {
        this.set("model", "claude-haiku-4-5-20251001");
      } else if (newProvider === "google" && !this.model.startsWith("gemini-")) {
        this.set("model", "gemini-2.0-flash");
      }
    },
  });

  // Readonly share mode — detekováno z URL ?readonly=1. Skrývá interaktivní
  // prvky (Settings, Subscribe alerty, Save searches) — slouží pro sdílení
  // DD reportu s klientem.
  window.Alpine.store("mode", {
    readonly: (() => {
      try {
        return new URLSearchParams(location.search).get("readonly") === "1";
      } catch {
        return false;
      }
    })(),
  });

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

  // Návrh B — „Další registry a zdroje": jeden store pro celý accordion v profilu.
  window.Alpine.store("dalsiRegistry", { open: false });
  // CTA při naražení na limit Hlídače státu (sdílený token) → nabídni vlastní HS token.
  window.Alpine.store("hsLimit", { hit: false });
});

// Návrh B — klik v levém menu na blok uvnitř „Další registry" → otevři accordion
// a doscrolluj na cílovou kartu (jinak by anchor mířil na skrytý prvek).
const DALSI_REGISTRY_IDS = ["dd-ai-summary", "dd-vr", "dd-ubo", "dd-dotace", "dd-smlouvy", "dd-adis", "dd-isir", "dd-jerrs", "dd-sankce", "dd-zivno", "dd-timeline", "dd-upv", "dd-ds", "dd-katastr"];
document.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest('a[href^="#dd-"]');
  if (!a) return;
  const id = a.getAttribute("href").slice(1);
  if (!DALSI_REGISTRY_IDS.includes(id)) return;
  e.preventDefault();
  const store = window.Alpine && window.Alpine.store("dalsiRegistry");
  if (store) store.open = true;
  setTimeout(() => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 80);
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
  // BYO LLM klíč pro AI souhrn (Fáze 1 monetizace).
  // Posílá provider + model + klíč. Klíč žije jen v browseru, posílá se
  // přes HTTPS přímo backendu který ho přepošle providerovi.
  if (typeof url === "string" && url.includes("/api/llm/")) {
    try {
      const key = (localStorage.getItem("icovazby:llm-key") ||
                   localStorage.getItem("icovazby:anthropic-key") || "").trim();
      if (key) {
        const provider = localStorage.getItem("icovazby:llm-provider") || "anthropic";
        const model = localStorage.getItem("icovazby:llm-model") || "claude-haiku-4-5-20251001";
        headers.set("X-LLM-Key", key);
        headers.set("X-LLM-Provider", provider);
        headers.set("X-LLM-Model", model);
      }
    } catch { /* ignore */ }
  }
  const r = await fetch(url, { ...(opts || {}), headers });
  const data = await r.json().catch(() => ({}));
  // HS sdílený token narazil na limit → nabídni userovi vlastní token (jen pokud ho ještě nemá).
  if (data && data.reason === "hs_rate_limited") {
    try {
      const hasOwn = (localStorage.getItem(STORAGE_HS_TOKEN) || "").trim().length > 0;
      if (!hasOwn && window.Alpine?.store("hsLimit")) window.Alpine.store("hsLimit").hit = true;
    } catch { /* ignore */ }
  }
  if (!r.ok) {
    throw new Error(data.message || data.error || `HTTP ${r.status}`);
  }
  // Graceful degradation z backendu (např. VR blokované, HS rate limit) —
  // server vrátí 200 + { ok:false, reason, message }. Throw aby komponenty
  // s error stavem zobrazily zprávu místo crash při render valid data.
  if (data && data.ok === false && data.reason) {
    throw new Error(data.message || `Zdroj nedostupný (${data.reason})`);
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

const STORAGE_LAST_QUERY = "icovazby:last-query";

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
    // True když Mapa propojení byla naplněna SEZNAMEM (≥2 IČO) → zobrazený
    // profil může patřit jiné firmě než ta v mapě. Hint vybídne k volbě uzlu.
    // Vyčistí se v run() (= načtení konkrétního profilu, vč. kliku na uzel).
    mapHint: false,
    persistQuery() {
      try {
        if (this.query?.trim()) {
          localStorage.setItem(STORAGE_LAST_QUERY, this.query);
        } else {
          localStorage.removeItem(STORAGE_LAST_QUERY);
        }
      } catch {
        /* private mode */
      }
    },
    init() {
      // history bar can ask us to load a specific IČO
      window.addEventListener("open-search", (e) => {
        if (e.detail?.ico) {
          this.query = e.detail.ico;
          this.persistQuery();
          this.run().then(() => {
            /* scroll removed per user request */
          });
        }
      });
      // Mapa propojení naplněná seznamem (≥2 IČO) → profil může být „cizí".
      // Zobraz hint vybízející k volbě firmy klikem v mapě (drill-down).
      window.addEventListener("ares-seed-graph", (e) => {
        this.mapHint = (e.detail?.icos?.length ?? 0) >= 2;
      });
      // Restore last query z localStorage (po refreshi / re-open tabu)
      try {
        const saved = localStorage.getItem(STORAGE_LAST_QUERY);
        if (saved && !this.query) this.query = saved;
      } catch {
        /* ignore */
      }
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
      this.mapHint = false; // načítáme konkrétní profil → hint už neplatí
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
    shareCopied: false,
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
          obchodniJmeno: this.report.obchodniJmeno,
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
    async copyShareUrl(ico) {
      try {
        const url = `${location.origin}/?ico=${encodeURIComponent(ico)}&action=profil&readonly=1`;
        await navigator.clipboard.writeText(url);
        this.shareCopied = true;
        setTimeout(() => { this.shareCopied = false; }, 3000);
      } catch (e) {
        alert("Kopírování selhalo: " + e.message);
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
    /** 'mermaid' | 'interactive' — toggle. Default interactive (klikatelný
     *  drill-down do profilu); Mermaid je volba pro statický export. */
    renderMode: "interactive",
    /** 'both' | 'persons' | 'ownership' — které vrstvy mapy zobrazit
     *  (osoby = sdílení statutáři, vlastnictví = akcionář→firma). */
    graphLayer: "both",
    /** Fáze B — fokus na osobu: id uzlu osoby (null = bez fokusu) + label do chipu. */
    /** C+b — investigativní SUBJEKTY (víc osob naráz). Každý {key,label,dob}.
     *  Všichni se zvýrazní (keep = sjednocení jejich okolí) → overlap vynikne. */
    egoPersons: [],
    /** #2 — PRIMÁRNÍ subjekt: když je nastaven, graf se zaměří jen na něj
     *  (single fokus + výrazné zvýraznění). Klik na subjekt přepíná. */
    primaryKey: null,
    /** C+c — textový výrok o vazbě mezi subjekty (sdílené firmy / mosty). */
    connectionMsg: "",
    /** AND — režim „jen společné firmy" (průnik): skryje vše kromě subjektů
     *  a firem, kde sedí ≥2 subjekty. Ostré hledání přímých vazeb. */
    intersectMode: false,
    /** Fáze C — osoba k zaměření po příštím renderu (z „Vazby osoby" ego-grafu). */
    pendingFocusPerson: null,
    /** Osoby, jejichž VŠECHNY firmy už jsou v grafu (ego/rozbalené) → „Rozbalit"
     *  u nich zašedneme. */
    fullKeys: [],
    /** Cytoscape instance — odkaz pro relayout / destroy. */
    cy: null,
    /** R3 — IČO firmy, ke které je mapa „ukotvena". Při přepnutí na jinou
     *  firmu (nový profil) se mapa vynuluje, ať nedrží předchozí subjekt. */
    _lastReportIco: null,
    /** Poslední načtený profil (z ares-report-loaded) — pro detekci OSVČ:
     *  fyzická osoba není ve VR → mapa prázdná → nabídneme „Vazby osoby". */
    latestReport: null,
    // Selection map pro „Možné jmenovce" (tentativeCandidates). Key = jmeno|prijmeni
    // (unikátní per name; pokud má více seed firem, vše bere). Hodnota = boolean.
    // Default ON — uživatel odškrtává ty, kteří nejsou ten samý člověk.
    tentativeSelections: {},
    /** Fáze D — uložit/sdílet plátno. shareUrl = vygenerovaný /v/<id> odkaz;
     *  shared = true když je plátno načtené ze sdíleného odkazu (read-only). */
    shareUrl: "",
    shareCopied: false,
    saving: false,
    shared: false,
    /** D+e — „knihovna": seznam uložených vyšetřování (link+label v localStorage). */
    savedInvestigations: [],
    libOpen: false,
    investigationName: "", // volitelný název při ukládání
    init() {
      this.loadSavedInvestigations();
      // DŮLEŽITÉ: event listenery registruj VŽDY a JAKO PRVNÍ — dřív byly až za
      // /v/ early-returnem, takže v načteném vyšetřování nefungoval ego-graf ani
      // „Přidat do mapy" (ares-focus-person/ares-add-to-graph listener chyběl).
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
      // Fáze C — „Vazby osoby" pošle ego-graf: zapamatuj osobu k zaměření,
      // aplikuje se na konci příštího renderCytoscape (po seedu + run).
      window.addEventListener("ares-focus-person", (e) => {
        const d = e.detail || {};
        if (d.datumNarozeni) this.pendingFocusPerson = { jmeno: d.jmeno || "", datumNarozeni: d.datumNarozeni };
      });
      // C+d — přidat osobu k EXISTUJÍCÍ mapě (sjednocení firem + nový subjekt).
      // Na rozdíl od ego-grafu (nahradí) tohle přidává → multi-subjekt + detekce vazby.
      window.addEventListener("ares-add-to-graph", (e) => {
        const { icos, person } = e.detail || {};
        if (!Array.isArray(icos) || icos.length === 0) return;
        const set = new Set(this.parseIcos(this.raw));
        for (const ico of icos) { if (set.size >= 50) break; set.add(ico); }
        if (person && person.datumNarozeni) {
          this.pendingFocusPerson = { jmeno: person.jmeno || "", datumNarozeni: person.datumNarozeni };
        }
        const h = window.Alpine?.store("history"); if (h) h.enabled = true; // ať se osoba (i historicky) ukáže
        this.raw = [...set].join("\n");
        this.run();
      });
      // R3 — přepnutí na JINOU firmu (nový profil) vynuluje mapu propojení, ať
      // nedrží předchozí subjekt (uživatel hlásil „mapa drží staré AGROFERT IČO,
      // zadám SimpleSolar a mapa se nezmění"). Stejnou logiku má /v2 (resetGraph
      // v v2.js) — tady čistíme přímo v graphSection, takže platí pro / i /v2;
      // dvojí spuštění nevadí (obojí jen maže = idempotentní).
      // Bezpečnostní brzdy: sdílené plátno nech být a probíhající MULTI-subjektové
      // vyšetřování (≥2 IČO nebo ego-osoby) nemaž — jen ukotvení na jednu firmu.
      window.addEventListener("ares-report-loaded", (e) => {
        const ico = e.detail?.ico;
        if (!ico) return;
        this.latestReport = e.detail; // pro OSVČ nótku — nastav VŽDY (i před returny)
        if (this.shared) return;
        if (ico === this._lastReportIco) return;
        const wasMulti = (this.egoPersons?.length || 0) > 0 || this.parseIcos(this.raw).length >= 2;
        this._lastReportIco = ico;
        if (wasMulti) return;
        this.resetGraph();
      });
      // Fáze D — sdílené/uložené vyšetřování: /v/<id> → dotáhni stav a obnov plátno.
      const invMatch = location.pathname.match(/^\/v\/([A-Za-z0-9_-]{1,32})$/);
      if (invMatch) {
        const id = invMatch[1];
        // Vlastní záznam (je v MÉ knihovně) → editace jako normálně; cizí přijatý odkaz → read-only.
        const own = this.savedInvestigations.find((x) => x.id === id);
        this.shared = !own;
        if (own) this.investigationName = own.label; // předvyplň pole názvem uloženého
        this.loadInvestigation(id);
        return;
      }
      const url = readUrl();
      if (url.icos) {
        this.raw = url.icos.split(",").join("\n");
        this.run();
      }
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
        if (!this.shared) updateUrl({ icos: icos.join(",") });
        if (this.result.mermaid && window.__mermaid) {
          const id = "mer-" + Date.now();
          try {
            const { svg } = await window.__mermaid.render(id, this.result.mermaid);
            this.mermaidSvg = svg;
          } catch (e) {
            this.error = "Nepodařilo se vykreslit graf: " + e.message;
          }
        }
        // Default režim je interaktivní → vykresli Cytoscape i bez kliknutí na
        // toggle (dřív se renderCytoscape spouštěl jen z toggle tlačítka).
        if (this.renderMode === "interactive") {
          requestAnimationFrame(() => this.renderCytoscape());
        }
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
    /** Fáze D — serializovatelný stav plátna (minimum pro rekonstrukci). */
    captureState() {
      return {
        v: 1,
        icos: this.parseIcos(this.raw),
        egoPersons: this.egoPersons,
        primaryKey: this.primaryKey,
        graphLayer: this.graphLayer,
        intersectMode: this.intersectMode,
        renderMode: this.renderMode,
        includeHistorical: !!(window.Alpine?.store("history")?.enabled),
      };
    },
    /** Fáze D — ulož plátno na server → vygeneruj read-only odkaz /v/<id>. */
    async saveInvestigation() {
      const icos = this.parseIcos(this.raw);
      if (icos.length < 1) {
        this.error = "Není co uložit — nejdřív vykresli mapu.";
        return;
      }
      this.saving = true;
      this.error = "";
      try {
        const r = await jsonFetch("/api/investigations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: this.captureState() }),
        });
        this.shareUrl = `${location.origin}/v/${r.id}`;
        // D+e — zapamatuj si ho do „knihovny" (localStorage), ať jde znovu otevřít bez linku.
        this.recordSavedInvestigation(r.id, icos);
        this.investigationName = ""; // vyčisti pole názvu po uložení
        this.libOpen = true; // auto-rozbal knihovnu, ať je po uložení vidět
        try {
          await navigator.clipboard.writeText(this.shareUrl);
          this.shareCopied = true;
          setTimeout(() => { this.shareCopied = false; }, 3000);
        } catch (_) { /* clipboard nemusí být dostupný — odkaz se ukáže i tak */ }
      } catch (e) {
        this.error = "Uložení vyšetřování selhalo: " + e.message;
      } finally {
        this.saving = false;
      }
    },
    /** D+e — knihovna uložených vyšetřování (localStorage). */
    loadSavedInvestigations() {
      try {
        const raw = localStorage.getItem(STORAGE_INVESTIGATIONS);
        this.savedInvestigations = raw ? JSON.parse(raw) : [];
      } catch { this.savedInvestigations = []; }
    },
    persistSavedInvestigations() {
      try { localStorage.setItem(STORAGE_INVESTIGATIONS, JSON.stringify(this.savedInvestigations)); } catch { /* private mode */ }
    },
    recordSavedInvestigation(id, icos) {
      const auto = (this.egoPersons || []).map((e) => e.label).join(", ")
        || `${(icos || []).length} subjektů`;
      const label = (this.investigationName || "").trim() || auto;
      // dedup dle id, nový nahoru, drž max 50
      this.savedInvestigations = this.savedInvestigations.filter((x) => x.id !== id);
      this.savedInvestigations.unshift({
        id,
        url: `${location.origin}/v/${id}`,
        label,
        count: (icos || []).length,
        savedAt: new Date().toISOString(),
      });
      this.savedInvestigations = this.savedInvestigations.slice(0, 50);
      this.persistSavedInvestigations();
    },
    openInvestigation(inv) {
      window.location.href = inv.url;
    },
    removeSavedInvestigation(id) {
      this.savedInvestigations = this.savedInvestigations.filter((x) => x.id !== id);
      this.persistSavedInvestigations();
    },
    /** Fáze D — načti sdílené plátno z /v/<id> a obnov stav. */
    async loadInvestigation(id) {
      try {
        const resp = await jsonFetch(`/api/investigations/${encodeURIComponent(id)}`);
        const st = resp.state || resp || {};
        if (Array.isArray(st.icos)) this.raw = st.icos.join("\n");
        this.egoPersons = Array.isArray(st.egoPersons) ? st.egoPersons : [];
        this.primaryKey = st.primaryKey ?? null;
        this.graphLayer = st.graphLayer || "both";
        this.intersectMode = !!st.intersectMode;
        this.renderMode = st.renderMode || "interactive";
        const h = window.Alpine?.store("history");
        if (h) h.enabled = !!st.includeHistorical;
        await this.run();
      } catch (e) {
        this.error = "Sdílené vyšetřování se nepodařilo načíst: " + e.message;
      }
    },
    /** Fáze D — ze sdíleného (read-only) /v/<id> přejdi do editace: odemkne
     *  vstup, chipy i Uložit (uloží se jako NOVÉ vyšetřování). Odebere /v/ z URL. */
    continueEditing() {
      this.shared = false;
      const icos = this.parseIcos(this.raw);
      window.history.replaceState(null, "", icos.length ? `/?icos=${icos.join(",")}` : "/");
    },
    /** Fáze D (D+c) — export aktuálního plátna do PDF: cy.png() → tisknutelná
     *  stránka v novém tabu (window.print → uložit jako PDF). Stejný princip
     *  jako PDF prověrka. Fallback: stáhne PNG když popup blokován. */
    exportCanvasImage() {
      if (!this.cy) {
        this.error = "Není co exportovat — mapa není vykreslená.";
        return;
      }
      let png;
      try {
        png = this.cy.png({ full: true, bg: "#ffffff", scale: 2 });
      } catch (e) {
        this.error = "Export plátna selhal: " + e.message;
        return;
      }
      const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      const subjects = (this.egoPersons || []).map((e) => esc(e.label)).join(", ") || "—";
      const dateStr = new Date().toLocaleDateString("cs-CZ", { day: "numeric", month: "long", year: "numeric" });
      const w = window.open("", "_blank");
      if (!w) {
        const a = document.createElement("a");
        a.href = png;
        a.download = `platno-${Date.now()}.png`;
        a.click();
        return;
      }
      w.document.write(
        '<!doctype html><html lang="cs"><head><meta charset="utf-8">' +
        "<title>Vyšetřovací plátno — icovazby.cz</title>" +
        "<style>@page{size:A4 landscape;margin:12mm}" +
        "body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:16px;color:#0f172a}" +
        "h1{font-size:18px;margin:0 0 4px}.meta{font-size:12px;color:#475569;margin-bottom:12px}" +
        "img{max-width:100%;height:auto;border:1px solid #e2e8f0;border-radius:6px}" +
        ".foot{margin-top:10px;font-size:10px;color:#94a3b8}</style></head><body>" +
        "<h1>Mapa propojení — vyšetřovací plátno</h1>" +
        '<div class="meta">Subjekty: <strong>' + subjects + "</strong> · " + dateStr + " · icovazby.cz</div>" +
        '<img src="' + png + '" alt="graf vazeb">' +
        '<div class="foot">Vygenerováno z icovazby.cz · data z veřejných registrů ČR a EU</div>' +
        "<scr" + "ipt>window.onload=function(){setTimeout(function(){window.print()},300)}</scr" + "ipt>" +
        "</body></html>",
      );
      w.document.close();
    },
    /** R3 — vynuluj mapu propojení (po přepnutí firmy). Zrcadlí v2 resetGraph:
     *  zahodí cytoscape instanci i veškerý investigativní stav a vyprázdní
     *  kontejner, aby z předchozí firmy nezůstal žádný uzel. */
    resetGraph() {
      this.result = null;
      this.mermaidSvg = "";
      this.error = "";
      if (this.cy) { try { this.cy.destroy(); } catch { /* ignore */ } this.cy = null; }
      this.egoPersons = [];
      this.primaryKey = null;
      this.connectionMsg = "";
      this.intersectMode = false;
      this.pendingFocusPerson = null;
      this.fullKeys = [];
      this.raw = "";
      const c = document.getElementById("cytoscape-container");
      if (c) c.innerHTML = "";
    },
    /** Je poslední načtený subjekt fyzická osoba / OSVČ? (PF 100/101/105/107/108…)
     *  Taková entita NENÍ ve VR → mapa propojení by byla prázdná; UI místo toho
     *  nabídne „Vazby osoby". */
    isFyzickaOsoba() {
      const pf = String(this.latestReport?.pravniForma ?? "");
      if (["100", "101", "102", "105", "107", "108", "109"].indexOf(pf) >= 0) return true;
      const n = parseInt(pf, 10);
      return Number.isFinite(n) && n >= 100 && n < 111;
    },
    /** Otevři „Vazby osoby" s předvyplněným jménem posledního subjektu (bez DOB —
     *  uživatel ho doplní; samotné hledání DOB stejně vyžaduje). */
    openLatestPersonVazby() {
      const r = this.latestReport;
      if (!r || !r.obchodniJmeno) return;
      window.dispatchEvent(new CustomEvent("ares-open-person-vazby", {
        detail: { jmeno: r.obchodniJmeno, datumNarozeni: "" },
      }));
      requestAnimationFrame(() => document.getElementById("vazby")?.scrollIntoView({ behavior: "smooth", block: "start" }));
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
      // Osoby + jejich hrany. Statutární (modré) → vrstva „osoby"; vlastnické
      // (oranžové, relation='owner') → vrstva „vlastnictví". Uzel osoby se přidá
      // jen pokud má v aktuální vrstvě aspoň jednu viditelnou hranu.
      {
        const personNodes = new Map();
        const personUsed = new Set();
        const addPerson = (p) => {
          const key = "P-" + (p.jmeno || "") + "|" + (p.datumNarozeni || "");
          if (!personNodes.has(key)) {
            personNodes.set(key, {
              data: {
                id: key,
                label: p.jmeno,
                datumNarozeni: p.datumNarozeni || "",
                type: p.isLegalEntity ? "legalPerson" : "person",
                shared: p.memberships && p.memberships.length > 1,
              },
            });
          }
          return key;
        };
        const seenEdge = new Set();
        const addEdges = (list, suffix, includeOwner) => {
          for (const p of list || []) {
            const pid = addPerson(p);
            for (const m of p.memberships || []) {
              const isOwner = m.relation === "owner";
              if (isOwner && !includeOwner) continue; // vlastnické hrany jen z activePersons (jednou)
              personUsed.add(pid);
              const id = pid + "-" + m.ico + (isOwner ? "-own" : "") + suffix;
              if (seenEdge.has(id)) continue; // dedup: vícenásobná členství k téže firmě = jedna hrana
              seenEdge.add(id);
              const data = { id, source: pid, target: "F-" + m.ico, label: m.funkce || "" };
              if (isOwner) data.type = "ownership";
              else if (suffix) data.shared = true;
              elements.push({ data });
            }
          }
        };
        addEdges(this.result.activePersons, "", true);
        addEdges(this.result.sharedPersons, "-s", false);
        for (const [key, node] of personNodes) {
          if (personUsed.has(key)) elements.push(node);
        }
      }
      // Vlastnické hrany firma→firma (vždy v elements; viditelnost řeší applyLayer).
      for (const e of this.result.ownershipEdges || []) {
        elements.push({
          data: { id: "OWN-" + e.from + "-" + e.to, source: "F-" + e.from, target: "F-" + e.to, type: "ownership" },
        });
      }

      // Uzly PŘED hranami — robustnost při re-renderu (žádné forward-reference
      // hrany na ještě nepřidané uzly; edge má `source`, node ne).
      elements.sort((a, b) => (a.data.source ? 1 : 0) - (b.data.source ? 1 : 0));
      const isDark = document.documentElement.classList.contains("dark");
      this.cy = window.cytoscape({
        container,
        elements,
        layout: { name: "cose", animate: false, fit: true, nodeRepulsion: 8000, idealEdgeLength: 100, padding: 30 },
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
            // Hover afordance: emerald „ring" kolem firmy → signál, že je klikatelná.
            selector: "node[type='firma'].hover",
            style: {
              "border-width": 4,
              "border-color": isDark ? "#6ee7b7" : "#34d399",
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
          {
            // Vlastnická hrana: akcionář-PO → vlastněná firma (oranžová, směrová).
            selector: "edge[type='ownership']",
            style: {
              "line-color": isDark ? "#fb923c" : "#ea580c",
              "target-arrow-color": isDark ? "#fb923c" : "#ea580c",
              "target-arrow-shape": "triangle",
              "curve-style": "bezier",
              "width": 2.5,
            },
          },
          {
            // Fokus na osobu (Fáze B): ostatní prvky ztlumené.
            selector: ".faded",
            style: { "opacity": 0.12, "text-opacity": 0.12 },
          },
          {
            // Plán B — skrytá vrstva: prvek úplně schován (přepínání vrstev).
            selector: ".layer-off",
            style: { "display": "none" },
          },
          {
            // C+c — overlap: sdílená firma / mostová osoba mezi subjekty (zlatý ring).
            selector: ".overlap",
            style: { "border-width": 5, "border-color": isDark ? "#fbbf24" : "#d97706" },
          },
          {
            // #2 — primární subjekt: výrazný indigo ring (odlišný od zlatého overlapu).
            selector: ".primary",
            style: { "border-width": 8, "border-color": isDark ? "#818cf8" : "#4f46e5" },
          },
          {
            // AND — průnik: prvek mimo společné firmy úplně schován.
            selector: ".intersect-off",
            style: { "display": "none" },
          },
        ],
      });
      // Click na firmu = otevři její profil v search.
      // POZN.: searchSection poslouchá "open-search" (ne "ares-open-profile" —
      // ten dříve nikdo nekonzumoval → klik byl mrtvý). Tím je drill-down
      // z Mapy propojení do Profilu funkční: uzel = volba subjektu do pole 1.
      this.cy.on("tap", "node[type='firma']", (evt) => {
        const ico = evt.target.data("ico");
        if (ico) window.dispatchEvent(new CustomEvent("open-search", { detail: { ico } }));
      });
      // Afordance: pointer kurzor + ring při najetí na firmu (uzel je klikatelný).
      this.cy.on("mouseover", "node[type='firma']", (evt) => {
        evt.target.addClass("hover");
        container.style.cursor = "pointer";
      });
      this.cy.on("mouseout", "node[type='firma']", (evt) => {
        evt.target.removeClass("hover");
        container.style.cursor = "default";
      });
      // Klik na osobu = fokus na její vztahy (Fáze B). Pointer kurzor = afordance.
      this.cy.on("tap", "node[type='person'], node[type='legalPerson']", (evt) => {
        this.focusPerson(evt.target.id(), evt.target.data("label"));
      });
      this.cy.on("mouseover", "node[type='person'], node[type='legalPerson']", () => { container.style.cursor = "pointer"; });
      this.cy.on("mouseout", "node[type='person'], node[type='legalPerson']", () => { container.style.cursor = "default"; });
      // Prune subjekty/full na ty, jejichž uzel v NOVÉM grafu reálně existuje —
      // robustní proti spurious re-renderům (dřív je render bez pending vynuloval).
      this.egoPersons = this.egoPersons.filter((e) => this.cy.getElementById(e.key).nonempty());
      this.fullKeys = this.fullKeys.filter((k) => this.cy.getElementById(k).nonempty());
      if (this.primaryKey && this.cy.getElementById(this.primaryKey).empty()) this.primaryKey = null;
      // Plán B: viditelnost vrstev se řeší zde (bez re-renderu při přepnutí).
      this.applyLayer();
      // Fáze C: čeká-li osoba k zaměření (ego-graf), zaměř ji; jinak fokus.
      if (this.pendingFocusPerson) this.applyPendingFocus();
      else this.applyFocus();
    },
    /** Plán B — přepnutí vrstev BEZ re-renderu: jen mění viditelnost prvků
     *  (display:none přes .layer-off). Tím nemůže žádný uzel „vypadnout". */
    applyLayer() {
      if (!this.cy) return;
      const layer = this.graphLayer;
      this.cy.batch(() => {
        this.cy.elements().removeClass("layer-off");
        if (layer === "persons") {
          this.cy.edges("[type='ownership']").addClass("layer-off");
        } else if (layer === "ownership") {
          this.cy.edges().filter((e) => e.data("type") !== "ownership").addClass("layer-off");
        }
        // osoby bez viditelné hrany skryj (firmy necháme vždy)
        this.cy.nodes("[type='person'], [type='legalPerson']").forEach((n) => {
          const vis = n.connectedEdges().filter((e) => !e.hasClass("layer-off")).length;
          if (vis === 0) n.addClass("layer-off");
        });
      });
      // Po změně viditelnosti znovu aplikuj fokus (zachová zvýraznění osoby
      // napříč vrstvami; když je osoba v dané vrstvě skrytá, nefáduje se).
      this.applyFocus();
    },
    /** Fáze B — fokus na osobu: ztlumí vše kromě osoby, jejích hran a firem
     *  na druhém konci. Druhý klik na tutéž osobu fokus zruší (toggle). */
    focusPerson(nodeId, label) {
      const i = this.egoPersons.findIndex((e) => e.key === nodeId);
      if (i < 0) {
        // nová osoba → přidat jako subjekt (multi-fokus)
        this.egoPersons.push({ key: nodeId, label: label || "", dob: nodeId.split("|")[1] || "" });
      } else {
        // už je subjekt → klik přepíná „primární" (single fokus na něj / zpět na multi)
        this.primaryKey = this.primaryKey === nodeId ? null : nodeId;
      }
      this.applyFocus();
    },
    /** #2 — nastav/zruš primární subjekt (klik na chip). */
    setPrimary(key) {
      this.primaryKey = this.primaryKey === key ? null : key;
      this.applyFocus();
    },
    clearFocus() {
      this.egoPersons = [];
      this.primaryKey = null;
      this.applyFocus();
    },
    removeEgo(key) {
      this.egoPersons = this.egoPersons.filter((e) => e.key !== key);
      if (this.primaryKey === key) this.primaryKey = null;
      this.applyFocus();
    },
    /** Multi-fokus: keep = sjednocení okolí VŠECH subjektů; zbytek zašedne.
     *  Subjekt skrytý aktuální vrstvou se přeskočí (návrat ho zase zvýrazní). */
    applyFocus() {
      if (!this.cy) return;
      this.cy.elements().removeClass("faded").removeClass("overlap").removeClass("primary");
      this.connectionMsg = "";
      if (this.egoPersons.length === 0) { this.primaryKey = null; return; }
      // MULTI-fokus VŽDY: keep = sjednocení okolí VŠECH subjektů; zbytek zašedne.
      // (Kontext + vazby mezi subjekty zůstanou — nezužujeme na jednoho.)
      let keep = this.cy.collection();
      const egoNodes = [];
      for (const ego of this.egoPersons) {
        const node = this.cy.getElementById(ego.key);
        if (!node || node.empty() || node.hasClass("layer-off")) continue;
        egoNodes.push(node);
        keep = keep.union(node).union(node.connectedEdges()).union(node.connectedEdges().connectedNodes());
      }
      if (keep.length === 0) return; // všichni subjekti skrytí v této vrstvě
      this.cy.elements().not(keep).addClass("faded");
      if (egoNodes.length >= 2) this.detectConnections(egoNodes);
      // #2 — primární subjekt jen VIZUÁLNĚ zvýrazni (indigo ring); kontext zůstává.
      if (this.primaryKey) {
        const p = this.cy.getElementById(this.primaryKey);
        if (p.nonempty()) p.addClass("primary");
      }
      this.applyIntersect();
    },
    /** AND — průnik: nech jen subjekty + společné firmy (overlap firma) a hrany
     *  mezi nimi; zbytek schovej. Ostrá odpověď „kde sedí oba/všichni". */
    applyIntersect() {
      if (!this.cy) return;
      this.cy.elements().removeClass("intersect-off");
      if (!this.intersectMode || this.egoPersons.length < 2) return;
      const egoIds = new Set(this.egoPersons.map((e) => e.key));
      const vis = new Set();
      this.cy.nodes().forEach((n) => {
        if (egoIds.has(n.id())) vis.add(n.id());
        else if (n.hasClass("overlap") && n.data("type") === "firma") vis.add(n.id());
      });
      this.cy.nodes().forEach((n) => { if (!vis.has(n.id())) n.addClass("intersect-off"); });
      this.cy.edges().forEach((e) => {
        if (!vis.has(e.source().id()) || !vis.has(e.target().id())) e.addClass("intersect-off");
      });
    },
    /** C+c — overlap + textová detekce vazby mezi ≥2 subjekty. Sdílené firmy
     *  a mostové osoby dostanou třídu .overlap; sestaví výrok do connectionMsg. */
    detectConnections(egoNodes) {
      const egoFirms = egoNodes.map((node) => {
        const firms = new Set();
        node.connectedEdges().connectedNodes("[type='firma']").forEach((f) => {
          const ico = f.data("ico"); if (ico) firms.add(ico);
        });
        return firms;
      });
      // Sdílené firmy (v okolí ≥2 subjektů) = přímá vazba.
      const firmCount = new Map();
      for (const fs of egoFirms) for (const ico of fs) firmCount.set(ico, (firmCount.get(ico) || 0) + 1);
      const shared = [...firmCount].filter(([, c]) => c >= 2).map(([ico]) => ico);
      for (const ico of shared) this.cy.getElementById("F-" + ico).addClass("overlap");
      // Mosty (nepřímá vazba) hledej jen když nemají přímou sdílenou firmu.
      const bridges = [];
      if (shared.length === 0) {
        const egoIds = new Set(egoNodes.map((n) => n.id()));
        this.cy.nodes("[type='person'], [type='legalPerson']").forEach((p) => {
          if (egoIds.has(p.id()) || p.hasClass("layer-off")) return;
          const pf = new Set();
          p.connectedEdges().connectedNodes("[type='firma']").forEach((f) => { const ico = f.data("ico"); if (ico) pf.add(ico); });
          let touch = 0;
          for (const fs of egoFirms) if ([...pf].some((ico) => fs.has(ico))) touch++;
          if (touch >= 2) { bridges.push(p.data("label")); p.addClass("overlap"); }
        });
      }
      const parts = [];
      if (shared.length) parts.push(`sdílí ${shared.length} ${shared.length === 1 ? "firmu" : "firem"}`);
      if (bridges.length) parts.push(`propojeni přes ${bridges.slice(0, 3).join(", ")}${bridges.length > 3 ? " …" : ""}`);
      this.connectionMsg = parts.length
        ? "🔗 Subjekty propojeny — " + parts.join(" · ")
        : "Subjekty v grafu nemají společnou firmu ani most (zkus ➕ rozbalit).";
    },
    /** Fáze C — zaměří osobu z ego-grafu. Hledá uzel podle data narození
     *  (spolehlivý klíč) + příjmení, protože display label se může lišit. */
    applyPendingFocus() {
      const fp = this.pendingFocusPerson;
      this.pendingFocusPerson = null;
      if (!fp || !this.cy) { this.applyFocus(); return; }
      const surname = (fp.jmeno || "").trim().split(/\s+/).pop().toLowerCase();
      const persons = this.cy.nodes("[type='person'], [type='legalPerson']");
      // 1) přesná shoda data narození + příjmení
      let match = null;
      if (fp.datumNarozeni) {
        persons.forEach((n) => {
          if (match) return;
          if (n.data("datumNarozeni") === fp.datumNarozeni &&
              (!surname || (n.data("label") || "").toLowerCase().includes(surname))) {
            match = n;
          }
        });
      }
      // 2) fallback: uzel bez DOB (historik z VR) / DOB nesedí → podle příjmení,
      //    ale jen když je v grafu JEDNOZNAČNÉ (jediný uzel s tím příjmením).
      if (!match && surname) {
        const byName = persons.filter((n) => (n.data("label") || "").toLowerCase().includes(surname));
        if (byName.length === 1) match = byName[0];
      }
      if (match) {
        const key = match.id();
        if (!this.egoPersons.some((e) => e.key === key)) {
          this.egoPersons.push({ key, label: match.data("label") || "", dob: key.split("|")[1] || "" });
        }
        if (!this.fullKeys.includes(key)) this.fullKeys.push(key); // celá (ego/rozbalená)
      }
      this.applyFocus();
    },
    /** C+a — rozbalit zaměřenou osobu: přidá její DALŠÍ firmy do grafu
     *  (z persons/vazby) a překreslí. Roste vyšetřovací plátno + odhalí
     *  skryté vazby přes spolu-statutáry. Po překreslení osobu zase zaměří. */
    async expandEgo(key, label, dob) {
      if (!key || !dob || !label) return;
      const jmeno = label;
      this.loading = true;
      this.error = "";
      try {
        const data = await jsonFetch("/api/persons/vazby", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jmeno,
            datumNarozeni: dob,
            includeHistorical: Alpine.store("history").enabled,
            resolveIco: true,
          }),
        });
        const newIcos = [...new Set((data.vazby || [])
          .filter((v) => v.resolvedIco && v.ambiguousMatchCount <= 1)
          .map((v) => v.resolvedIco))];
        const set = new Set(this.parseIcos(this.raw));
        const MAX = 50;
        let added = 0;
        for (const ico of newIcos) {
          if (set.size >= MAX) break;
          if (!set.has(ico)) { set.add(ico); added++; }
        }
        if (added === 0) {
          this.error = "Žádné nové firmy této osoby k přidání (nebo už jsou v grafu).";
          return;
        }
        this.pendingFocusPerson = { jmeno, datumNarozeni: dob }; // po renderu zase zaměřit
        this.raw = [...set].join("\n");
        await this.run();
        if (set.size >= MAX) this.error = "Dosažen limit 50 firem v grafu — rozbaluj cíleně.";
      } catch (e) {
        this.error = "Rozbalení osoby selhalo: " + e.message;
      } finally {
        this.loading = false;
      }
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
      if (!Array.isArray(icos) || icos.length < 1) return;
      // Když už na plátně probíhá vyšetřování (jsou SUBJEKTY), ego-graf další
      // osoby SLUČ — přidej její firmy, nezahazuj předchozí subjekt (jinak by
      // druhý „ego-graf do mapy" vymazal firmy prvního a po jeho odebrání by se
      // nedaly vrátit — multi-subjekt + overlap se rozbije). Prázdné plátno
      // (nová firma / holding seed) → nahraď.
      if ((this.egoPersons?.length || 0) > 0) {
        const set = new Set(this.parseIcos(this.raw));
        for (const ico of icos) { if (set.size >= 50) break; set.add(ico); }
        this.raw = [...set].join("\n");
      } else {
        this.raw = icos.join("\n");
      }
      // 1 IČO je OK → server vykreslí ego-graf jedné firmy (firma + statutáři).
      if (this.parseIcos(this.raw).length >= 1) await this.run();
      else this.error = "Zadej alespoň 1 platné IČO.";
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
        if (!jmeno) return;
        // Předvyplň jméno VŽDY; datum narození jen když ho máme. U OSVČ (z mapy)
        // DOB nemáme → necháme uživatele doplnit a sám spustit. Auto-run jen když
        // máme oboje (klik na statutára s DOB). Samotné hledání DOB stejně
        // vyžaduje (run() guard) — LIA zůstává splněna.
        this.form.jmeno = jmeno;
        this.form.datumNarozeni = datumNarozeni || "";
        window.Alpine?.store("sections")?.setVisible("osoby", true);
        if (datumNarozeni) {
          Promise.resolve().then(() => { this.run(); });
        }
      });
    },
    close() {
      window.Alpine?.store("sections")?.setVisible("osoby", false);
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
      // Ego-graf (Fáze C): všechny firmy osoby do mapy + auto-fokus na osobu.
      // Zapni historický režim, ať se osoba s ukončenými rolemi v mapě ukáže
      // (jinak by ji current-only graf vynechal a fokus by nesedl).
      const hist = window.Alpine?.store("history");
      if (hist && this.form.includeHistorical) hist.enabled = true;
      window.dispatchEvent(new CustomEvent("ares-focus-person", {
        detail: { jmeno: this.form.jmeno, datumNarozeni: this.form.datumNarozeni },
      }));
      window.Alpine?.store("sections")?.setVisible("graph", true);
      window.dispatchEvent(new CustomEvent("ares-seed-graph", { detail: { icos } }));
      requestAnimationFrame(() => document.querySelector("#graph")?.scrollIntoView({ behavior: "smooth" }));
    },
    /** C+d — PŘIDAT osobu k existující Mapě propojení (nenahradí ji). Sjednotí
     *  její firmy + udělá z ní další subjekt → multi-fokus + detekce vazby. */
    addToMap() {
      const icos = this.allResolvedIcos();
      if (icos.length < 1) return;
      window.Alpine?.store("sections")?.setVisible("graph", true);
      window.dispatchEvent(new CustomEvent("ares-add-to-graph", {
        detail: { icos, person: { jmeno: this.form.jmeno, datumNarozeni: this.form.datumNarozeni } },
      }));
      requestAnimationFrame(() => document.querySelector("#graph")?.scrollIntoView({ behavior: "smooth" }));
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
        // Seeduj i jednu firmu (≥1) → ego-graf firmy (firma + statutáři), ať je
        // panel mapy užitečný u každého subjektu, ne jen u holdingů. Server u 1
        // IČO ještě zkusí auto-expand; když nic, vykreslí ji samotnou.
        if (icos.length >= 1) {
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

// Sbírka listin (or.justice) — Fáze 1: metadata; Fáze 2: čísla z PDF (lazy).
function ddSbirkaListinLoader() {
  return {
    sl: null,
    loading: false,
    slError: "",
    cisla: null,
    cislaLoading: false,
    cislaError: "",
    cislaTried: false,
    formatCZK,
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.sl = null;
      this.slError = "";
      this.cisla = null;
      this.cislaTried = false;
      this.cislaError = "";
      this.ocrTried = false;
      this.ocrError = "";
      try {
        this.sl = await jsonFetch(`/api/sbirka-listin/${encodeURIComponent(ico)}`);
        // Eager: jakmile máme metadata a firma je v OR, rovnou natáhni čísla i graf
        // (fire-and-forget, nezdrží render) — uživatel vidí data hned, bez klikání.
        // OCR zůstává manuální (drahé). Vše cachované → cena jen na 1. zobrazení.
        if (this.sl && this.sl.applicable && !this.sl.error) {
          this.loadCisla(ico);
          this.loadVyvoj(ico);
        }
      } catch (e) {
        this.slError = "Sbírku listin nelze načíst: " + e.message;
      } finally {
        this.loading = false;
      }
    },
    // Fáze 2 — lazy: stáhne PDF poslední závěrky a vytáhne čísla (pdftotext, bez LLM).
    async loadCisla(ico) {
      if (!ico || this.cislaLoading) return;
      this.cislaTried = true;
      this.cislaLoading = true;
      this.cislaError = "";
      try {
        this.cisla = await jsonFetch(`/api/zaverka-cisla/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.cislaError = "Čísla nelze načíst: " + e.message;
      } finally {
        this.cislaLoading = false;
      }
    },
    // Fáze 2b — OCR skenu (on-demand, drahé). Nabízí se, jen když běžné čtení
    // selhalo (sken). Výsledek má stejný tvar jako cisla → recyklujeme tabulku.
    ocrLoading: false,
    ocrTried: false,
    ocrError: "",
    // OCR běží na pozadí (může trvat 1–3 min) → spustíme a POLLUJEME, dokud nejsou
    // čísla (cisla) nebo chyba. Server vrací {running:true}, dokud doběhne.
    async loadOcr(ico) {
      if (!ico || this.ocrLoading) return;
      this.ocrTried = true;
      this.ocrLoading = true;
      this.ocrError = "";
      this._ocrPolls = 0;
      this._ocrTick(ico);
    },
    async _ocrTick(ico) {
      try {
        const res = await jsonFetch(`/api/zaverka-ocr/${encodeURIComponent(ico)}`);
        if (res && res.cisla) {
          this.cisla = res; // přepíše „nepodařilo se" → zobrazí se OCR čísla
          this.cislaError = "";
          if (res.vyvoj) { this.vyvoj = res.vyvoj; this.vyvojTried = true; this.vyvojError = ""; }
          this.ocrLoading = false;
        } else if (res && res.running) {
          this._ocrPolls = (this._ocrPolls || 0) + 1;
          if (this._ocrPolls > 18) { this.ocrError = "OCR trvá neobvykle dlouho — zkus to za chvíli znovu."; this.ocrLoading = false; return; }
          setTimeout(() => this._ocrTick(ico), 12000); // pollni za 12 s
        } else {
          this.ocrError = (res && res.error) || "OCR nic nepřečetlo.";
          this.ocrLoading = false;
        }
      } catch (e) {
        this.ocrError = "OCR nelze spustit: " + e.message;
        this.ocrLoading = false;
      }
    },
    // tis. Kč → čitelná částka v Kč (formatCZK). Záporné OK.
    fmtTis(v, jednotka) {
      if (v == null) return "—";
      var kc = jednotka === "tis. Kč" ? v * 1000 : v;
      // formatCZK neformátuje záporné → formátuj absolutní hodnotu a vrať znaménko.
      return (kc < 0 ? "−" : "") + this.formatCZK(Math.abs(kc));
    },
    fmtPct(v) {
      return v == null ? "—" : (v * 100).toFixed(1).replace(".", ",") + " %";
    },
    // Přístup 2 — víceletý vývoj (řada + metriky + trendy). Lazy.
    vyvoj: null,
    vyvojLoading: false,
    vyvojError: "",
    vyvojTried: false,
    async loadVyvoj(ico) {
      if (!ico || this.vyvojLoading) return;
      this.vyvojTried = true;
      this.vyvojLoading = true;
      this.vyvojError = "";
      try {
        this.vyvoj = await jsonFetch(`/api/zaverka-vyvoj/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.vyvojError = "Vývoj nelze načíst: " + e.message;
      } finally {
        this.vyvojLoading = false;
      }
    },
    // Metrika sloupců grafu: tržby (preferované); fallback na aktiva, když firma
    // neukládá čitelnou výsledovku (jen rozvahu) — ať není graf prázdný.
    _vyvojMetric: "trzby",
    vyvojMetricLabel() {
      return this._vyvojMetric === "aktiva" ? "aktiva" : "tržby";
    },
    // Plausibility guard: zkrácené/malé formy parser občas přečte špatně
    // (špatný sloupec „minulé období") → nesmyslné meziroční skoky. Když je
    // některý rok >10× menší/větší než OBA sousedi, řadu označíme za nespolehlivou
    // a graf radši nezobrazíme (lepší než sebevědomě špatné číslo).
    vyvojReliable() {
      const rada = ((this.vyvoj && this.vyvoj.rada) || []).slice().reverse(); // staré → nové
      const cnt = (k) => rada.filter((r) => typeof r[k] === "number").length;
      // Preferuj tržby, ale jen když pokrývají skoro stejně let jako aktiva
      // (jinak by 3 prázdné sloupce u firem bez recentní výsledovky) → pak aktiva.
      const ct = cnt("trzby"),
        ca = cnt("aktiva");
      const metric = ct >= 2 && ct + 1 >= ca ? "trzby" : ca >= 2 ? "aktiva" : "trzby";
      const v = rada.map((r) => r[metric]);
      for (let i = 1; i < v.length - 1; i++) {
        if (typeof v[i] !== "number" || typeof v[i - 1] !== "number" || typeof v[i + 1] !== "number") continue;
        const a = Math.abs(v[i - 1]),
          b = Math.abs(v[i]),
          c = Math.abs(v[i + 1]);
        const dip = b > 0 && b * 10 < a && b * 10 < c; // propad mezi dvěma vyššími
        const spike = a > 0 && c > 0 && b > 10 * a && b > 10 * c; // špička mezi dvěma nižšími
        if (dip || spike) return false;
      }
      return true;
    },
    // Řádky grafu (staré → nové) se šířkou sloupce (CSS bar, bez knihovny).
    vyvojRows() {
      const rada = ((this.vyvoj && this.vyvoj.rada) || []).slice().reverse();
      const cnt = (k) => rada.filter((r) => typeof r[k] === "number").length;
      // Preferuj tržby, ale jen když pokrývají skoro stejně let jako aktiva
      // (jinak by 3 prázdné sloupce u firem bez recentní výsledovky) → pak aktiva.
      const ct = cnt("trzby"),
        ca = cnt("aktiva");
      const metric = ct >= 2 && ct + 1 >= ca ? "trzby" : ca >= 2 ? "aktiva" : "trzby";
      this._vyvojMetric = metric;
      const vals = rada.map((r) => r[metric]).filter((v) => typeof v === "number");
      const max = vals.length ? Math.max.apply(null, vals.map(Math.abs)) : 0;
      return rada.map((r) => ({
        rok: r.rok,
        val: r[metric],
        vh: r.vysledekHospodareni,
        barPct: typeof r[metric] === "number" && max > 0 ? Math.max(3, Math.round((Math.abs(r[metric]) / max) * 100)) : 0,
      }));
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

// Forenzní indikátory (Fáze 1): hromadné sídlo, bílý kůň, kruhové vlastnictví.
// Adresu předáváme z reportu → server nemusí znovu fetchovat ARES.
function ddForensikaLoader() {
  return {
    data: null,
    loading: false,
    forError: "",
    async load(ico, adresa) {
      if (!ico) return;
      this.loading = true;
      this.data = null;
      this.forError = "";
      try {
        var q = adresa ? "?adresa=" + encodeURIComponent(adresa) : "";
        this.data = await jsonFetch("/api/forensika/" + encodeURIComponent(ico) + q);
      } catch (e) {
        this.forError = "Forenzní indikátory selhaly: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}
window.ddForensikaLoader = ddForensikaLoader;

// PEP + sankce (Hodnota #2): řídicí osoby firmy x PEP (Hlídač státu) + EU sankce.
function ddPepSankceLoader() {
  return {
    data: null,
    loading: false,
    psError: "",
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.data = null;
      this.psError = "";
      try {
        this.data = await jsonFetch("/api/pep-sankce/" + encodeURIComponent(ico));
      } catch (e) {
        this.psError = "PEP/sankce screening selhal: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}
window.ddPepSankceLoader = ddPepSankceLoader;

// Přeshraniční vlastnictví (Hodnota #4): GLEIF LEI mateřská/dceřiné firmy vč. zahraničních.
function ddCrossBorderLoader() {
  return {
    data: null,
    loading: false,
    cbError: "",
    async load(ico) {
      if (!ico) return;
      this.loading = true;
      this.data = null;
      this.cbError = "";
      try {
        this.data = await jsonFetch("/api/cross-border/" + encodeURIComponent(ico));
      } catch (e) {
        this.cbError = "Přeshraniční vlastnictví selhalo: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}
window.ddCrossBorderLoader = ddCrossBorderLoader;

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
      // Listener pro openSettings() z empty-states napříč profilem
      window.addEventListener("ares-open-settings", () => {
        this.open = true;
      });
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

const STORAGE_NOTES = "icovazby:notes";

/** Anotace per firma — localStorage, žádný server. */
function ddNotesCard() {
  return {
    note: "",
    tags: [],
    lastSaved: "",
    availableTags: [
      { key: "red-flag", label: "🚩 Red flag", activeClass: "bg-rose-100 dark:bg-rose-900/40 text-rose-700 border-rose-300" },
      { key: "approved", label: "✅ Schváleno", activeClass: "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 border-emerald-300" },
      { key: "watching", label: "👀 Sleduji", activeClass: "bg-amber-100 dark:bg-amber-900/40 text-amber-700 border-amber-300" },
      { key: "client", label: "🤝 Klient", activeClass: "bg-blue-100 dark:bg-blue-900/40 text-blue-700 border-blue-300" },
      { key: "competitor", label: "⚔ Konkurence", activeClass: "bg-purple-100 dark:bg-purple-900/40 text-purple-700 border-purple-300" },
    ],
    load(ico) {
      if (!ico) return;
      try {
        const all = JSON.parse(localStorage.getItem(STORAGE_NOTES) || "{}");
        const entry = all[ico] || {};
        this.note = entry.note || "";
        this.tags = entry.tags || [];
      } catch {
        this.note = "";
        this.tags = [];
      }
    },
    save(ico) {
      if (!ico) return;
      try {
        const all = JSON.parse(localStorage.getItem(STORAGE_NOTES) || "{}");
        if (!this.note && this.tags.length === 0) {
          delete all[ico];
        } else {
          all[ico] = { note: this.note, tags: this.tags, updatedAt: new Date().toISOString() };
        }
        localStorage.setItem(STORAGE_NOTES, JSON.stringify(all));
        this.lastSaved = new Date().toLocaleTimeString("cs-CZ");
      } catch {
        /* private mode */
      }
    },
    toggleTag(key, ico) {
      if (this.tags.includes(key)) {
        this.tags = this.tags.filter((t) => t !== key);
      } else {
        this.tags = [...this.tags, key];
      }
      this.save(ico);
    },
    get hasContent() {
      return Boolean(this.note?.trim() || this.tags.length > 0);
    },
  };
}
window.ddNotesCard = ddNotesCard;

/**
 * Klasifikace chybové zprávy do typové variant pro empty-state UI.
 * Vrací jeden z: 'missing-token' | 'network' | 'not-found' | 'rate-limit' | 'other'
 */
function classifyError(msg) {
  if (!msg) return "other";
  const m = String(msg).toLowerCase();
  if (m.includes("missing_token") || m.includes("hlídač státu není nakonfigurován") || m.includes("token chybí")) return "missing-token";
  if (m.includes("fetch failed") || m.includes("econn") || m.includes("network") || m.includes("getaddrinfo") || m.includes("upstream")) return "network";
  if (m.includes("not_found") || m.includes("not found") || m.includes("nenalezeno")) return "not-found";
  if (m.includes("rate_limit") || m.includes("rate_limited") || m.includes("429") || m.includes("příliš mnoho dotazů")) return "rate-limit";
  return "other";
}
window.classifyError = classifyError;

/** Otevři settings popover přes custom event — hsTokenSettings listener. */
function openSettings() {
  window.dispatchEvent(new CustomEvent("ares-open-settings"));
}
window.openSettings = openSettings;

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
    aml: false, // AML režim: obohatí o forenziku + PEP/sankce + přeshraniční
    lastRunAml: false, // jaký režim měl poslední běh (řídí sloupce/CSV)
    init() {
      // Seed z jiné sekce (např. Uložená vyhledávání → Prověřit více firem).
      window.addEventListener("ares-seed-bulk", (e) => {
        const icos = e.detail?.icos || [];
        if (!icos.length) return;
        window.Alpine?.store("sections")?.setVisible("bulk", true);
        this.raw = icos.join("\n");
      });
    },
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
      // AML režim je dražší (PEP přes Hlídač státu je rate-limited) → menší cap + nižší konkurence.
      const cap = this.aml ? 25 : 50;
      if (icos.length > cap) {
        this.error = "Maximum " + cap + " IČO" + (this.aml ? " v AML režimu (PEP screening je pomalý)." : " na bulk request.");
        return;
      }
      this.lastRunAml = this.aml;
      this.loading = true;
      this.total = icos.length;
      this.progress = 0;
      const out = [];
      const aml = this.aml;
      const CONCURRENCY = aml ? 2 : 5;
      let cursor = 0;
      const worker = async () => {
        while (cursor < icos.length) {
          const i = cursor++;
          const ico = icos[i];
          try {
            const dd = await jsonFetch(`/api/dd/${ico}`);
            const row = {
              ico,
              obchodniJmeno: dd.obchodniJmeno,
              risk: dd.risk?.level || "?",
              dph: dd.vat?.platceDph ? "ano" : "ne",
              statutary: dd.statutary?.aktivniCount ?? 0,
              insolvence: dd.insolvenci?.isInsolvent ? "ANO" : "ne",
              findings: (dd.risk?.findings || []).map((f) => f.message).join("; "),
            };
            if (aml) out[i] = await this.enrichAml(row, ico, dd);
            else out[i] = row;
          } catch (e) {
            out[i] = { ico, obchodniJmeno: "(chyba)", risk: "error", dph: "—", statutary: "—", insolvence: "—", findings: e.message, amlScore: -1 };
          }
          this.progress++;
          this.results = out.filter(Boolean);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      // Nejhorší nahoře (AML přehled portfolia).
      if (aml) this.results = out.filter(Boolean).sort((a, b) => (b.amlScore || 0) - (a.amlScore || 0));
      this.loading = false;
    },
    // Obohatí řádek o forenziku + PEP/sankce + přeshraniční a spočítá AML skóre (jen řazení/přehled).
    async enrichAml(row, ico, dd) {
      const [forn, ps, cb] = await Promise.all([
        jsonFetch(`/api/forensika/${ico}`).catch(() => null),
        jsonFetch(`/api/pep-sankce/${ico}`).catch(() => null),
        jsonFetch(`/api/cross-border/${ico}`).catch(() => null),
      ]);
      const forParts = [];
      if (forn) {
        if (forn.sidlo && forn.sidlo.level && forn.sidlo.level !== "green") forParts.push("hromadné sídlo");
        if ((forn.statutari || []).some((s) => s.level !== "green")) forParts.push("bílý kůň");
        if (forn.kruhove && forn.kruhove.nalezeno) forParts.push("cyklus");
        if (forn.phoenix) forParts.push("phoenix");
      }
      const pepN = ps && ps.pep ? ps.pep.length : 0;
      const sankN = ps && ps.sankce ? ps.sankce.length : 0;
      const cbFlag = cb && cb.crossBorder ? (cb.foreignParent ? "matka v zahraničí" : "zahr. dcery") : "";
      row.forensika = forParts.join(", ") || "—";
      row.pep = pepN;
      row.sankce = sankN;
      row.crossBorder = cbFlag || "—";
      // AML skóre (vyšší = rizikovější) — jen pro řazení a přehled, ne oficiální metrika.
      row.amlScore =
        (row.risk === "red" ? 40 : row.risk === "yellow" ? 15 : 0) +
        (row.insolvence === "ANO" ? 30 : 0) +
        forParts.length * 8 +
        pepN * 10 +
        sankN * 40 +
        (cbFlag ? 6 : 0);
      return row;
    },
    exportCsv() {
      const aml = this.lastRunAml;
      const headers = aml
        ? ["AML skóre", "IČO", "Jméno", "Risk", "Insolvence", "Forenzní flagy", "PEP", "Sankce", "Přeshraniční", "DPH", "Statutáři", "Findings"]
        : ["IČO", "Jméno", "Risk", "DPH", "Statutáři", "Insolvence", "Findings"];
      const rows = this.results.map((r) =>
        aml
          ? [r.amlScore, r.ico, r.obchodniJmeno, r.risk, r.insolvence, r.forensika, r.pep, r.sankce, r.crossBorder, r.dph, r.statutary, r.findings]
          : [r.ico, r.obchodniJmeno, r.risk, r.dph, r.statutary, r.insolvence, r.findings],
      );
      // Formula-injection ochrana: buňka začínající =,+,-,@,tab,CR by se v Excelu
      // vyhodnotila jako vzorec (jméno firmy z rejstříku je útočníkem ovlivnitelné).
      var csvCell = function (v) {
        var s = String(v == null ? "" : v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return '"' + s.replace(/"/g, '""') + '"';
      };
      const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
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
          // ICO_RE pustí `00000000` (8 číslic) — explicitně odmítnout všenuly,
          // jinak by se uložil placeholder text z textarey jako platné IČO.
          .filter((s) => ICO_RE.test(s) && !/^0+$/.test(s)),
      )];
    },
    add() {
      if (!this.newName.trim()) {
        alert("Zadej název seznamu.");
        return;
      }
      const icos = this.parseQuery(this.newQuery);
      if (icos.length === 0) {
        alert("Zadej alespoň jedno platné IČO (8 číslic, ne samé nuly).");
        return;
      }
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
      window.Alpine?.store("sections")?.setVisible("bulk", true);
      window.dispatchEvent(new CustomEvent("ares-seed-bulk", {
        detail: { icos: s.icos },
      }));
      requestAnimationFrame(() => {
        document.querySelector("#bulk")?.scrollIntoView({ behavior: "smooth" });
      });
    },
    map(s) {
      window.Alpine?.store("sections")?.setVisible("graph", true);
      window.dispatchEvent(new CustomEvent("ares-seed-graph", {
        detail: { icos: s.icos },
      }));
      requestAnimationFrame(() => {
        document.querySelector("#graph")?.scrollIntoView({ behavior: "smooth" });
      });
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
    ds: null,
    loading: false,
    error: "",
    lastIco: "",
    async fetchDs(ico) {
      if (!ico || ico === this.lastIco) return;
      this.lastIco = ico;
      this.loading = true;
      this.error = "";
      this.ds = null;
      try {
        this.ds = await jsonFetch(`/api/ds/${encodeURIComponent(ico)}`);
      } catch (e) {
        this.error = "Lookup selhal: " + e.message;
      } finally {
        this.loading = false;
      }
    },
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

/**
 * ÚPV ochranné známky — lokální SQLite index (ST.96 open data).
 * Fuzzy match na obchodní jméno (ÚPV neposkytuje IČO). Volá se z dd-upv
 * karty s `report.obchodniJmeno` + sídlo city.
 */
function ddUpvCard() {
  return {
    data: null,
    loading: false,
    error: "",
    showAll: false,
    lastKey: "",
    async load(name, city) {
      if (!name || name.trim().length < 2) return;
      const key = `${name}|${city ?? ""}`;
      if (key === this.lastKey) return; // už načteno pro tenhle profil
      this.lastKey = key;
      this.loading = true;
      this.error = "";
      this.data = null;
      this.showAll = false;
      try {
        const params = new URLSearchParams({ name });
        if (city) params.set("city", city);
        this.data = await jsonFetch(`/api/upv/by-name?${params.toString()}`);
      } catch (e) {
        this.error = "ÚPV nelze načíst: " + e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}
window.ddUpvCard = ddUpvCard;

/**
 * AI auto-summary firmy — Claude Haiku 4.5 cez /api/llm/summary/:ico.
 * Lazy load — neudělá nic dokud user explicit neklikne „Generovat".
 * Cache 7 dní backend-side (SQLite).
 */
function ddAiSummaryCard() {
  return {
    data: null,
    loading: false,
    error: "",
    generated: false,
    async generate(ico, force = false) {
      if (!ico) return;
      this.loading = true;
      this.error = "";
      try {
        const params = force ? "?force=1" : "";
        this.data = await jsonFetch(`/api/llm/summary/${encodeURIComponent(ico)}${params}`, { method: "POST" });
        this.generated = true;
      } catch (e) {
        this.error = "AI souhrn se nezdařil: " + e.message;
      } finally {
        this.loading = false;
      }
    },
    statusBadge(code) {
      if (!code) return { label: "Neznámý", color: "slate" };
      if (code >= 0.8) return { label: "Vysoká důvěra", color: "emerald" };
      if (code >= 0.6) return { label: "Střední důvěra", color: "amber" };
      return { label: "Nízká důvěra", color: "rose" };
    },
    openSettings() {
      // Odlož o tick — jinak tentýž klik spustí @click.outside Nastavení a hned ho zavře.
      setTimeout(() => window.dispatchEvent(new CustomEvent("ares-open-settings")), 0);
    },
  };
}
window.ddAiSummaryCard = ddAiSummaryCard;

/**
 * AI promo banner — viditelný visitor-ům bez Anthropic klíče.
 * Dismiss perzistovaný v localStorage, aby se neukazoval znovu po zavření.
 * Fáze 1 monetizace: nenápadná upozornění bez paywall friction.
 */
function aiPromoBanner() {
  return {
    visible: true,
    init() {
      try { this.visible = localStorage.getItem("icovazby:ai-promo-dismissed") !== "1"; } catch {}
    },
    dismiss() {
      this.visible = false;
      try { localStorage.setItem("icovazby:ai-promo-dismissed", "1"); } catch {}
    },
  };
}
window.aiPromoBanner = aiPromoBanner;

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
