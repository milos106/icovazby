/* ============================================================================
 * icovazby /v2 — Workspace (varianta C) shell + risk engine
 * ----------------------------------------------------------------------------
 * Tento soubor NESAHÁ na produkční appku. Recykluje VŠECHNY Alpine factory
 * z /js/app.js (ddSection, ddVrLoader, ddUboLoader, … graphSection,
 * personVazbySection) a přidává jen shell logiku 3-sloupcového command-centra:
 *   - stav aktivní skupiny (7 tabů)
 *   - risk summary + „Zjištění podle priority" z REÁLNÝCH dat (report.risk
 *     + lazy loadery ADIS/ISIR/UBO/dotace/smlouvy/EU sankce)
 *   - ⌘K command palette
 *   - light/dark toggle sdílený se starou appkou (klíč icovazby:theme)
 *
 * Root komponenta = v2App(), která rozšiřuje ddSection() (drží `report`).
 * ==========================================================================*/
(function () {
  "use strict";

  // Mapování právní formy → čitelný název (nejčastější kódy ARES).
  var PF = {
    "100": "Podnikající fyzická osoba", "101": "Fyzická osoba",
    "107": "OSVČ", "108": "Zahraniční fyzická osoba",
    "111": "Veřejná obchodní společnost", "112": "Společnost s ručením omezeným",
    "113": "Komanditní společnost", "121": "Akciová společnost",
    "141": "Společenství vlastníků jednotek", "151": "Komoditní burza",
    "205": "Družstvo", "301": "Státní podnik", "325": "Příspěvková organizace",
    "331": "Organizační složka státu", "421": "Odštěpný závod zahr. osoby",
    "705": "Podílový fond", "706": "Svěřenský fond", "707": "Zahr. svěřenský fond",
    "751": "Spolek", "601": "Vysoká škola", "352": "Veřejnoprávní instituce",
    "801": "Obec", "804": "Kraj",
  };

  var GROUP_LABELS = {
    identita: "Identita",
    vlastnictvi: "Vlastnictví a řízení",
    finance: "Finance a veřejné peníze",
    rizika: "Rizika",
  };

  var ORD = { red: 0, amber: 1, green: 2 };

  function v2App() {
    // Recykluj kompletní ddSection() (ico, report, run(), init(), …).
    var dd = (typeof window.ddSection === "function") ? window.ddSection() : {};

    var shell = {
      // --- shell state ---
      active: "identita",
      palette: false,
      pq: "",
      q: "",
      // --- našeptávač podle názvu firmy ---
      suggestions: [],     // [{ ico, obchodniJmeno, … }]
      sugOpen: false,
      sugLoading: false,
      sugActive: -1,       // index zvýrazněné položky (klávesnice)
      _sugTimer: null,     // debounce
      _sugSeq: 0,          // pořadí fetchů — invaliduje zastaralé odpovědi
      dark: false,
      drawer: false,        // mobil/tablet: off-canvas pravý panel
      showFindings: false,  // rozbalený panel „Zjištění podle priority"
      toolModal: null,      // 'osoby'|'address'|'compare'|'bulk'|'saved'|null — nástroj v overlay
      settingsOpen: false,  // ⚙️ Nastavení overlay (HS token + AI klíč)
      graphFull: false,     // fullscreen přepnutí STÁVAJÍCÍHO #v2-map-box (žádná 2. instance)
      readonly: false,      // Fáze D — sdílené plátno (?v=<id>): zamkni editaci (akční lišta, ⚙️, ruční mapa, ukládání)
      holdingLoading: false, // běží reálné rozkrytí holdingu (akční lišta vlevo)
      recents: [],          // historie naposledy prohlížených firem (sdílené s app.js)
      histOpen: false,      // dropdown „🕘 Historie" v headeru
      bookmarks: [],        // oblíbené firmy (sdílené s app.js přes icovazby:bookmarks)
      favOpen: false,       // dropdown „⭐ Oblíbené" v headeru
      hsTokenSet: false,    // ⚙️ indikátor — má uživatel vlastní HS token (z localStorage)
      _lastGraphIco: null,  // poslední firma, pro kterou byla resetovaná mapa (anti-stale graf)

      // Forenzní indikátory — JEDEN zdroj pravdy: computeRisk je načte a uloží sem;
      // karta v Rizika i risk skóre čtou z TÉHOŽ → nemůžou se rozejít.
      forensika: null,
      forensikaLoading: false,
      // PEP + sankce — stejný single-source vzor (computeRisk → self.pepSankce)
      pepSankce: null,
      pepSankceLoading: false,

      riskState: {
        loading: false,
        ready: false,        // true až když derivace doběhne (zdroje / watchdog)
        findings: [],
        counts: { red: 0, amber: 0, green: 0 },
        score: null,
        level: null,
        areas: {},          // {identita,vlastnictvi,finance,rizika} → red|amber|green
      },

      groups: [
        { id: "identita",    icon: "🪪", label: "Identita",             sub: "kdo subjekt je" },
        { id: "vlastnictvi", icon: "👥", label: "Vlastnictví a řízení", sub: "kdo za firmou stojí" },
        { id: "finance",     icon: "💸", label: "Finance a veř. peníze", sub: "toky veřejných peněz" },
        { id: "rizika",      icon: "🚩", label: "Rizika",               sub: "na co si dát pozor" },
        { id: "aktiva",      icon: "🏠", label: "Aktiva",               sub: "majetek a značky" },
        { id: "synteza",     icon: "🧠", label: "Syntéza",              sub: "AI souhrn · vývoj" },
      ],
      tools: [
        // „Mapa" záměrně NENÍ tlačítko — graf je stále vidět v pravém panelu.
        // (focusTool('graph') dál funguje přes ⌘G a tlačítko „Rozkrýt holding".)
        { id: "osoby",   icon: "🔗", label: "Vazby os." },
        { id: "address", icon: "🏢", label: "Adresa" },
        { id: "compare", icon: "⚖️", label: "Porovnat" },
        { id: "bulk",    icon: "📋", label: "Dávková prověrka" },
        // „Uložené" záměrně NENÍ v tomto seznamu (tlačítko skryté) —
        // zůstává dostupné přes ⌘K paletu a větev modalu (toolModal==='saved').
      ],

      // --- helpers ---
      pfLabel: function (code) {
        var k = String(code == null ? "" : code);
        return PF[k] || (k ? "Právní forma " + k : "—");
      },
      gLabel: function (id) { return GROUP_LABELS[id] || id; },
      currentGroup: function () {
        var self = this;
        return this.groups.find(function (g) { return g.id === self.active; }) || this.groups[0];
      },
      naceDescribe: function (kod) {
        try {
          var s = this.$store && this.$store.nace;
          return s && s.describe ? (s.describe(kod) || "") : "";
        } catch (e) { return ""; }
      },

      // --- portál deep-linky (tvar URL 1:1 ze staré public/index.html) ---
      upvUrl: function (jmeno) {
        return "https://isdv.upv.gov.cz/webapp/resdb.print_detail?xprx=ÚZNÁMKY-FZS&xs=" + encodeURIComponent(jmeno || "");
      },
      dsUrl: function (ico) {
        return "https://www.mojedatovaschranka.cz/sds/search?searchValue=" + encodeURIComponent(ico || "");
      },

      // --- lifecycle ---
      init: function () {
        var self = this;
        this.dark = document.documentElement.classList.contains("dark");

        window.addEventListener("keydown", function (e) { self.onKey(e); });
        // drill-down z grafu / historie: open-search → načti firmu
        window.addEventListener("open-search", function (e) {
          if (e.detail && e.detail.ico) { self.q = e.detail.ico; self.run(e.detail.ico); }
        });

        // historie naposledy prohlížených firem (zapisuje app.js přes recordVisit) —
        // čteme přímo z localStorage a reaktivně obnovujeme při ares-history-changed.
        this.loadRecents();
        this.loadBookmarks();
        // Stará app.js dispatchuje „ares-history-changed" i po změně oblíbených
        // (historyBar.refresh() čte recent i bookmarks); reaktivně obnovíme obojí.
        window.addEventListener("ares-history-changed", function () { self.loadRecents(); self.loadBookmarks(); });
        this.refreshHsToken();

        // Když dorazí report → spočítej risk z reálných dat.
        this.$watch("report", function (r) {
          if (!r) return;
          self.computeRisk(r);
          // Reset MAPY při změně firmy — ať nedrží starý graf (např. AGROFERT),
          // když nová firma nemá vazby (1 IČO bez holdingu). Holding auto-seed ji
          // pak naplní, pokud dceřinky existují.
          if (r.ico !== self._lastGraphIco) {
            self._lastGraphIco = r.ico;
            self.resetGraph();
          }
        });

        // Deep-link: ve v2 jsme benevolentní — stačí ?ico=<platné IČO> v URL
        // (i bez action=profil). Stará ddSection.init() auto-načte jen když je
        // i action=profil|dd; tady to subsumujeme. run() pak dopíše action=profil.
        try {
          var params = new URLSearchParams(window.location.search);
          var urlIco = (params.get("ico") || "").trim().replace(/^CZ\s*/i, "").replace(/\s|-|\./g, "");
          if (/^\d{7,8}$/.test(urlIco)) self.run(urlIco);
        } catch (e) {}

        // Fáze D — sdílené vyšetřovací plátno: ?v=<id> → načti uložený stav
        // (GET /api/investigations/:id přes graphSection.loadInvestigation) a přepni
        // workspace do read-only. Bez ?v= zůstává normální editovatelný režim.
        try {
          var vid = (new URLSearchParams(window.location.search).get("v") || "").trim();
          if (/^[A-Za-z0-9_-]{1,32}$/.test(vid)) {
            self.readonly = true;
            self.loadSharedInvestigation(vid);
          }
        } catch (e) {}
      },

      // --- Fáze D: read-only sdílené plátno (?v=<id>) ---
      // graphSection() (mapa v pravém panelu) je samostatná Alpine komponenta a v době
      // v2App.init() ještě nemusí být mountnutá → krátké pollování, než se objeví její
      // instance s loadInvestigation. shared=true zamkne ruční vstup + ukládání UVNITŘ
      // graphSection (recyklované x-show="!shared" z app.js); readonly (root) skryje
      // akční lištu, ⚙️ a banner pustí.
      loadSharedInvestigation: function (id) {
        var self = this;
        var tries = 0;
        (function attempt() {
          var d = null;
          try {
            var sec = document.querySelector('[x-data*="graphSection"]');
            d = sec && window.Alpine && window.Alpine.$data(sec);
          } catch (e) {}
          if (d && typeof d.loadInvestigation === "function") {
            d.shared = true;          // read-only: skryje ruční mapu + chipy + ukládání
            d.loadInvestigation(id);  // GET /api/investigations/:id → obnoví stav + run()
            return;
          }
          if (tries++ < 40) setTimeout(attempt, 50); // čekej na mount graphSection
        })();
      },
      // „Otevřít v editoru" — zruší read-only, odemkne graphSection (shared=false) a
      // sundá ?v=<id> z URL (uloží se pak jako NOVÉ vyšetřování).
      exitReadonly: function () {
        this.readonly = false;
        try {
          var sec = document.querySelector('[x-data*="graphSection"]');
          var d = sec && window.Alpine && window.Alpine.$data(sec);
          if (d) { d.shared = false; d.shareUrl = ""; }
        } catch (e) {}
        try { window.history.replaceState(null, "", "/v2"); } catch (e) {}
      },

      onKey: function (e) {
        var mod = e.metaKey || e.ctrlKey;
        if (mod && (e.key === "k" || e.key === "K")) { e.preventDefault(); this.openPalette(); return; }
        if (mod && e.key === ".") { e.preventDefault(); this.toggleTheme(); return; }
        if (mod && (e.key === "g" || e.key === "G")) { e.preventDefault(); this.focusTool("graph"); return; }
        // Esc zavírá (v pořadí) fullscreen graf → nástrojový modal → Nastavení →
        // historie (funguje i z inputu). Paleta má vlastní @keydown.escape.window.
        if (e.key === "Escape") {
          if (this.graphFull) { this.toggleGraphFull(); return; }
          if (this.toolModal) { this.closeToolModal(); return; }
          if (this.settingsOpen) { this.closeSettings(); return; }
          if (this.favOpen) { this.favOpen = false; return; }
          if (this.histOpen) { this.histOpen = false; return; }
        }
        if (this.palette) return;
        var tag = (e.target && e.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") return;
        if (e.key >= "1" && e.key <= "6") { this.active = this.groups[parseInt(e.key, 10) - 1].id; }
      },

      openPalette: function () {
        var self = this;
        this.palette = true;
        this.$nextTick(function () { if (self.$refs.pq) self.$refs.pq.focus(); });
      },

      toggleTheme: function () {
        this.dark = !this.dark;
        document.documentElement.classList.toggle("dark", this.dark);
        document.documentElement.style.colorScheme = this.dark ? "dark" : "light";
        try { localStorage.setItem("icovazby:theme", this.dark ? "dark" : "light"); } catch (e) {}
        // sdílíme se starou appkou + překreslí Mermaid/graf
        window.dispatchEvent(new CustomEvent("ares-theme-changed", { detail: { dark: this.dark } }));
        if (typeof window.__mermaidReinit === "function") { try { window.__mermaidReinit(); } catch (e) {} }
      },

      // --- historie naposledy prohlížených firem ---
      // Čteme PŘÍMO z localStorage (loadList z app.js není ve scope v2.js).
      // Klíč icovazby:recent = pole {ico, obchodniJmeno, at}, nejnovější první.
      loadRecents: function () {
        try {
          var raw = localStorage.getItem("icovazby:recent");
          var arr = raw ? JSON.parse(raw) : [];
          this.recents = Array.isArray(arr) ? arr.filter(function (r) { return r && r.ico; }) : [];
        } catch (e) { this.recents = []; }
      },
      // jednotný klikací helper pro všechna 3 místa — načti firmu ve workspace
      // (NE nová záložka) a zavři historii / paletu / modaly.
      openCompany: function (ico) {
        if (!ico) return;
        this.histOpen = false;
        this.favOpen = false;
        this.palette = false;
        this.toolModal = null;
        this.sugClose();
        this.error = "";
        this.run(String(ico));
      },
      clearHistory: function () {
        try { localStorage.removeItem("icovazby:recent"); } catch (e) {}
        window.dispatchEvent(new Event("ares-history-changed"));
        this.loadRecents();
      },

      // --- oblíbené firmy (★) — sdílené se starou appkou přes icovazby:bookmarks ---
      // Stejný tvar položky jako app.js: {ico, obchodniJmeno, at}, dedup dle ico,
      // nejnovější první, bez limitu. Čteme PŘÍMO z localStorage (helpery z app.js
      // nejsou ve scope v2.js).
      loadBookmarks: function () {
        try {
          var raw = localStorage.getItem("icovazby:bookmarks");
          var arr = raw ? JSON.parse(raw) : [];
          this.bookmarks = Array.isArray(arr) ? arr.filter(function (b) { return b && b.ico; }) : [];
        } catch (e) { this.bookmarks = []; }
      },
      isBookmarked: function (ico) {
        if (!ico) return false;
        return (this.bookmarks || []).some(function (b) { return b.ico === ico; });
      },
      // přepne AKTUÁLNÍ firmu (report) do/z oblíbených
      toggleBookmark: function () {
        var r = this.report;
        if (!r || !r.ico) return;
        if (this.isBookmarked(r.ico)) {
          this.removeBookmark(r.ico);
        } else {
          var list = (this.bookmarks || []).filter(function (b) { return b.ico !== r.ico; });
          list.unshift({ ico: r.ico, obchodniJmeno: r.obchodniJmeno, at: Date.now() });
          this._saveBookmarks(list);
        }
      },
      removeBookmark: function (ico) {
        if (!ico) return;
        this._saveBookmarks((this.bookmarks || []).filter(function (b) { return b.ico !== ico; }));
      },
      _saveBookmarks: function (list) {
        try { localStorage.setItem("icovazby:bookmarks", JSON.stringify(list)); } catch (e) {}
        // ať se změna projeví i ve staré appce (historyBar poslouchá tento event)
        window.dispatchEvent(new Event("ares-history-changed"));
        this.loadBookmarks();
      },
      // hezký relativní čas („před 3 h", „včera"…)
      relTime: function (at) {
        var t = Number(at);
        if (!isFinite(t) || t <= 0) return "";
        var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
        if (s < 60) return "právě teď";
        var m = Math.floor(s / 60);
        if (m < 60) return "před " + m + " min";
        var h = Math.floor(m / 60);
        if (h < 24) return "před " + h + " h";
        var d = Math.floor(h / 24);
        if (d === 1) return "včera";
        if (d < 30) return "před " + d + " dny";
        var mo = Math.floor(d / 30);
        return "před " + mo + " měs.";
      },

      // --- search (IČO → přímo; název → našeptávač /api/search/companies) ---
      submitSearch: function () {
        var cleaned = (this.q || "").trim().replace(/^CZ\s*/i, "").replace(/\s|-|\./g, "");
        // čisté IČO → načti rovnou
        if (/^\d{7,8}$/.test(cleaned)) { this.error = ""; this.sugClose(); this.run(cleaned); return; }
        // máme návrhy → vyber zvýrazněný (nebo první)
        if (this.suggestions && this.suggestions.length) {
          var pick = this.sugActive >= 0 ? this.suggestions[this.sugActive] : this.suggestions[0];
          if (pick && pick.ico) { this.error = ""; this.pickSuggestion(pick.ico); return; }
        }
        // zatím žádné návrhy → spusť dohledání podle názvu
        var term = (this.q || "").trim();
        if (term.length >= 2) { this.onSearchInput(); return; }
        this.error = "Zadej IČO nebo název firmy.";
      },

      // input handler s debounce (~250 ms)
      onSearchInput: function () {
        var self = this;
        this.error = "";
        var cleaned = (this.q || "").trim().replace(/^CZ\s*/i, "").replace(/\s|-|\./g, "");
        // čisté IČO → návrhy netřeba, Enter ho načte
        if (/^\d{7,8}$/.test(cleaned)) { this.sugClose(); return; }
        if (this._sugTimer) clearTimeout(this._sugTimer);
        var term = (this.q || "").trim();
        if (term.length < 2) { this.sugClose(); return; }
        // Okamžité shody z HISTORIE (substring, bez diakritiky). ARES dělá
        // whole-word match → „slepené" názvy typu SimpleSolar nenajde pro „simple".
        // Historie to obejde: co jsi už prohlížel, najdeš i podle části názvu.
        var norm = function (s) { return (s || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase(); };
        var nt = norm(term);
        var histHits = (self.recents || [])
          .filter(function (r) { return r && r.ico && norm(r.obchodniJmeno).indexOf(nt) >= 0; })
          .map(function (r) { return { ico: r.ico, obchodniJmeno: r.obchodniJmeno, _hist: true }; });
        if (histHits.length) { self.suggestions = histHits.slice(0, 8); self.sugOpen = true; self.sugActive = -1; }
        this._sugTimer = setTimeout(function () {
          var seq = ++self._sugSeq;
          self.sugLoading = true;
          self.sugOpen = true;
          self.sugActive = -1;
          fetch("/api/search/companies?obchodniJmeno=" + encodeURIComponent(term) + "&limit=8")
            .then(function (r) { return r.ok ? r.json() : { vysledky: [] }; })
            .then(function (data) {
              if (seq !== self._sugSeq) return; // zastaralá odpověď — ignoruj
              var ares = (data && data.vysledky) || [];
              // Merge: historie nahoře, pak ARES; dedup dle IČO.
              var seen = {}, merged = [];
              histHits.concat(ares).forEach(function (x) {
                if (!x || !x.ico || seen[x.ico]) return; seen[x.ico] = 1; merged.push(x);
              });
              self.suggestions = merged.slice(0, 8);
              self.sugLoading = false;
              self.sugOpen = true;
            })
            .catch(function () {
              if (seq !== self._sugSeq) return;
              self.suggestions = histHits.slice(0, 8);
              self.sugLoading = false;
              self.sugOpen = true;
            });
        }, 250);
      },

      // výběr návrhu → načti firmu ve workspace (NE nová záložka)
      pickSuggestion: function (ico) {
        if (!ico) return;
        this.sugClose();
        this.error = "";
        this.run(String(ico));
      },

      // klávesnice ↑/↓ v seznamu návrhů
      sugMove: function (dir) {
        if (!this.sugOpen || !this.suggestions.length) return;
        var n = this.suggestions.length;
        this.sugActive = (this.sugActive + dir + n) % n;
      },

      sugClose: function () {
        if (this._sugTimer) { clearTimeout(this._sugTimer); this._sugTimer = null; }
        this._sugSeq++; // invaliduj probíhající fetch
        this.sugOpen = false;
        this.sugActive = -1;
      },

      // zavři po blur (s malým delayem, ať proběhne klik na položku)
      sugBlur: function () {
        var self = this;
        setTimeout(function () { self.sugOpen = false; self.sugActive = -1; }, 150);
      },

      // klik na oblastní semafor / skóre → rozbal Zjištění podle priority
      toggleFindings: function () { this.showFindings = !this.showFindings; },
      goGroup: function (id) { this.active = id; },

      // klik na statutára/UBO → otevři modal Vazby osoby s předvyplněným jménem/DOB.
      // Modal mountuje personVazbySection (x-if), jejíž init() registruje listener
      // na ares-open-person-vazby → musíme dispatch poslat až PO zamountování.
      openPerson: function (jmeno, dob) {
        if (!jmeno) return;
        var d = "";
        if (dob && /^\d{4}-\d{2}-\d{2}/.test(dob)) d = dob.slice(0, 10);
        else if (dob && /^\d{4}$/.test(dob)) d = dob + "-01-01";
        this.openToolModal("osoby");
        this.$nextTick(function () {
          setTimeout(function () {
            window.dispatchEvent(new CustomEvent("ares-open-person-vazby", {
              detail: { jmeno: jmeno, datumNarozeni: d },
            }));
          }, 60);
        });
      },

      // Fyzická osoba / OSVČ? (právní formy 100/101/105/107/108…) — taková entita
      // NENÍ ve VR, nemá statutáře ani vlastnictví → mapa propojení by byla prázdná.
      // Místo prázdna nabídneme „Vazby osoby" (firmy, kde osoba figuruje jinde).
      isFyzickaOsoba: function (report) {
        var pf = String((report && report.identification && report.identification.pravniForma) || "");
        if (["100", "101", "102", "105", "107", "108", "109"].indexOf(pf) >= 0) return true;
        var n = parseInt(pf, 10);
        return Number.isFinite(n) && n >= 100 && n < 111;
      },

      focusTool: function (id) {
        this.palette = false;
        if (id === "graph") {
          // fokus pravého panelu + doscroll na plátno (NE window.open). Drawer kvůli mobilu.
          this.drawer = true;
          this.$nextTick(function () {
            var el = document.getElementById("cytoscape-container");
            if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
          });
        } else if (id === "osoby" || id === "address" || id === "compare" || id === "bulk" || id === "saved") {
          // v2-nativní nástroje v modálním overlay (žádný bounce do staré appky)
          this.openToolModal(id);
        }
      },

      // --- Rozkrýt holding (akční lišta) — REÁLNĚ spustí discovery, ne jen scroll.
      // Najde SKRYTOU holdingDiscovery() instanci (index.html ~842), zavolá její
      // run(ico) → POST /api/holding/discover → dispatch `ares-seed-graph`, na který
      // graphSection() (mapa v pravém panelu) poslouchá a naseeduje plátno. Funguje
      // i pro OSVČ / firmy bez statutára, kde se auto-trigger přeskočí. ---
      revealHolding: function () {
        var self = this;
        if (!this.report || !this.report.ico) return;
        this.focusTool("graph"); // ukaž mapu (drawer + doscroll)
        var hd = null;
        try {
          var el = document.querySelector('[x-data*="holdingDiscovery"]');
          hd = el && window.Alpine && window.Alpine.$data(el);
        } catch (e) {}
        if (!hd || typeof hd.run !== "function") return;
        this.holdingLoading = true;
        Promise.resolve(hd.run(this.report.ico)).then(
          function () { self.holdingLoading = false; },
          function () { self.holdingLoading = false; }
        );
      },

      // Vynuluj mapu (cy + výsledek + vyšetřovací stavy) — volá se při změně firmy,
      // ať graf nedrží starou firmu, když nová nemá vazby. NEvolá se v read-only.
      resetGraph: function () {
        if (this.readonly) return;
        try {
          var sec = document.querySelector('[x-data*="graphSection"]');
          var d = sec && window.Alpine && window.Alpine.$data(sec);
          if (d) {
            d.result = null;
            if (d.cy) { try { d.cy.destroy(); } catch (e) {} d.cy = null; }
            if (Array.isArray(d.egoPersons)) d.egoPersons = [];
            if ("primaryKey" in d) d.primaryKey = null;
            if ("connectionMsg" in d) d.connectionMsg = "";
            if ("intersectMode" in d) d.intersectMode = false;
            if ("raw" in d) d.raw = "";
          }
          var el = document.getElementById("cytoscape-container");
          if (el) el.innerHTML = "";
        } catch (e) {}
      },

      // --- nástrojový modal (Adresa / Porovnat / Bulk DD / Uložené) ---
      openToolModal: function (id) { this.palette = false; this.toolModal = id; },
      closeToolModal: function () { this.toolModal = null; },

      // --- Nastavení (⚙️) overlay — HS token + AI klíč (REUSE staré komponenty) ---
      openSettings: function () {
        var self = this;
        this.palette = false;
        this.refreshHsToken();
        this.settingsOpen = true;
        // a11y: fokus na první input (HS token) po otevření.
        // Input žije v nested x-data="hsTokenSettings()" scope → query přes DOM id.
        this.$nextTick(function () {
          var el = document.getElementById("v2s-hs-input");
          if (el) { try { el.focus(); } catch (e) {} }
        });
      },
      closeSettings: function () { this.settingsOpen = false; this.refreshHsToken(); },

      // ⚙️ indikátor stavu klíčů: HS token (z localStorage, obnovuj při open/close
      // Nastavení) + AI klíč (reaktivně z $store.aiAccess). keysOk = obojí vyplněno
      // → ikona zezelená; jinak amber tečka (signál „něco chybí").
      refreshHsToken: function () {
        try { this.hsTokenSet = (localStorage.getItem("icovazby:hs-token") || "").trim().length > 0; }
        catch (e) { this.hsTokenSet = false; }
      },
      keysOk: function () {
        var ai = this.$store && this.$store.aiAccess;
        var aiSet = !!(ai && ai.apiKey && ai.apiKey.length > 0);
        return this.hsTokenSet && aiSet;
      },

      // --- fullscreen graf (přemístí TÝŽ #v2-map-box, žádná nová Cytoscape instance) ---
      cyInstance: function () {
        try {
          var sec = document.querySelector('[x-data*="graphSection"]');
          var d = sec && window.Alpine && window.Alpine.$data(sec);
          return d && d.cy ? d.cy : null;
        } catch (e) { return null; }
      },
      toggleGraphFull: function () {
        var self = this;
        // BOX NEPŘESOUVÁME — jinak vypadne z Alpine stromu a :class/x-show přestanou
        // reagovat. Na desktopu (lg+) pravý panel nemá transform, takže `fixed` na
        // #v2-map-box pokrývá celý viewport. :class="graphFull ? 'fixed inset-0 …'"
        // v index.html se postará o vzhled. Na <lg drawer mívá transform → fullscreen
        // dočasně zruším transform na pravém panelu, ať fixed sedí i tam.
        this.graphFull = !this.graphFull;
        var aside = document.querySelector('aside.flex.flex-col.border-l');
        if (aside) aside.style.transform = this.graphFull ? "none" : "";
        // Po přepnutí přepočítej plátno (týž cy, jen jiné rozměry).
        this.$nextTick(function () {
          setTimeout(function () {
            var cy = self.cyInstance();
            if (cy) { cy.resize(); try { cy.fit(undefined, 30); } catch (e) {} }
          }, 120);
        });
      },

      // ======================================================================
      // RISK ENGINE — agreguje report.risk.findings + lazy loadery do jednoho
      // seznamu „Zjištění podle priority" (red → amber → green).
      // ======================================================================
      computeRisk: function (report) {
        var self = this;
        var ico = report.ico;

        // INDETERMINATE stav — dokud nedoběhne celá derivace, NEukazuj finální
        // skóre ani „vše zelené". ready:false → box ukáže spinner „počítám
        // prověrku…" + šedé (neutrální) oblastní tečky. Žádný skok ze 100.
        this.riskState = {
          loading: true, ready: false,
          findings: [], counts: { red: 0, amber: 0, green: 0 },
          score: null, level: null, areas: {},
        };
        this.showFindings = false;

        // server findings (synchronně z reportu)
        var serverFs = [];
        var rf = (report.risk && report.risk.findings) || [];
        rf.forEach(function (f) { serverFs.push(self.classifyServer(f)); });

        // instancuj lazy loadery (recyklují jsonFetch + HS token z app.js)
        var adis = window.ddAdisLoader ? window.ddAdisLoader() : null;
        var isir = window.ddIsirLoader ? window.ddIsirLoader() : null;
        var ubo = window.ddUboLoader ? window.ddUboLoader() : null;
        var dot = window.ddDotaceLoader ? window.ddDotaceLoader() : null;
        var sml = window.ddSmlouvyLoader ? window.ddSmlouvyLoader() : null;
        var eu = window.ddEuSanctionsLoader ? window.ddEuSanctionsLoader() : null;
        var sl = window.ddSbirkaListinLoader ? window.ddSbirkaListinLoader() : null;
        var forn = window.ddForensikaLoader ? window.ddForensikaLoader() : null;
        var ps = window.ddPepSankceLoader ? window.ddPepSankceLoader() : null;

        // Každý zdroj = jeden promise. „Dorazila odpověď" (i prázdná / chyba /
        // HS-token-gated ok:false) = HOTOVO pro tento zdroj → resolve i reject
        // počítáme jako dokončení, ať se to nezasekne na „počítám" donekonečna.
        var tasks = [];
        if (adis) tasks.push(adis.load(ico));
        if (isir) tasks.push(isir.load(ico));
        if (ubo) tasks.push(ubo.load(ico));
        if (dot) tasks.push(dot.load(ico));
        if (sml) tasks.push(sml.load(ico));
        if (eu) tasks.push(eu.screen(report));
        if (sl) tasks.push(sl.load(ico));
        // Forenzní — JEDNO načtení; výsledek uložíme do self.forensika (karta i skóre
        // čtou z toho samého). Task pořád resolvuje pro finalize().
        if (forn) {
          self.forensika = null;
          self.forensikaLoading = true;
          tasks.push(
            forn.load(ico, report.sidloText || (report.sidlo && report.sidlo.textovaAdresa)).then(
              function () { self.forensika = forn.data; self.forensikaLoading = false; },
              function () { self.forensikaLoading = false; },
            ),
          );
        }
        if (ps) {
          self.pepSankce = null;
          self.pepSankceLoading = true;
          tasks.push(
            ps.load(ico).then(
              function () { self.pepSankce = ps.data; self.pepSankceLoading = false; },
              function () { self.pepSankceLoading = false; },
            ),
          );
        }

        var total = tasks.length;
        var done = 0;
        var watchdogCleared = false;

        // finalize je IDEMPOTENTNÍ a RE-RUNNABLE: watchdog dá rychlé částečné skóre
        // v 8 s, a až dojedou pomalé loadery (PEP/sankce, forenzika), tick zavolá
        // finalize znovu a skóre se PŘEPOČÍTÁ s plnými daty (jinak by je minulo).
        function finalize() {
          if (!watchdogCleared) { clearTimeout(watchdog); watchdogCleared = true; }

          // ochrana proti race (uživatel mezitím přepnul firmu)
          if (!self.report || self.report.ico !== ico) return;

          var fs = serverFs.slice();
          if (adis) fs = fs.concat(self.fromAdis(adis.adis));
          if (isir) fs = fs.concat(self.fromIsir(isir.isir));
          if (ubo) fs = fs.concat(self.fromUbo(ubo.ubo));
          if (dot) fs = fs.concat(self.fromDotace(dot.dotace));
          if (sml) fs = fs.concat(self.fromSmlouvy(sml.smlouvy));
          if (eu) fs = fs.concat(self.fromSanctions(eu.result, report));
          if (sl) fs = fs.concat(self.fromSbirkaListin(sl.sl));
          if (forn) fs = fs.concat(self.fromForensika(forn.data));
          if (ps) fs = fs.concat(self.fromPepSankce(ps.data));

          fs = fs.filter(Boolean);
          // generický green „bez signálů" zahoď, pokud máme konkrétní nálezy
          var hasSpecific = fs.some(function (f) { return !f._generic; });
          if (hasSpecific) fs = fs.filter(function (f) { return !f._generic; });

          // dedupe podle titulku
          var seen = {}; var uniq = [];
          fs.forEach(function (f) { if (seen[f.title]) return; seen[f.title] = 1; uniq.push(f); });
          // sort red → amber → green
          uniq.sort(function (a, b) { return ORD[a.level] - ORD[b.level]; });

          var counts = { red: 0, amber: 0, green: 0 };
          uniq.forEach(function (f) { counts[f.level]++; });

          var areaIds = ["identita", "vlastnictvi", "finance", "rizika"];
          var areas = {};
          areaIds.forEach(function (a) { areas[a] = "green"; });
          uniq.forEach(function (f) {
            if (areaIds.indexOf(f.group) >= 0 && ORD[f.level] < ORD[areas[f.group]]) areas[f.group] = f.level;
          });

          // Skóre s VÁHAMI: tvrdá fakta (insolvence, sankce…) = red −45 / amber −12;
          // „měkké" forenzní signály (sídlo, bílý kůň…) lehčí = red −20 / amber −6,
          // protože jsou „signál, ne důkaz" (false positives: byznys centra, advokáti).
          var pen = 0;
          uniq.forEach(function (f) {
            if (f.level === "red") pen += f.soft ? 20 : 45;
            else if (f.level === "amber") pen += f.soft ? 6 : 12;
          });
          var score = Math.max(0, 100 - pen);

          // Neúplné? Když některý zdroj vrátil chybu (typicky HS výpadek/rate-limit),
          // skóre je počítáno z částečných dat → označ, ať nevypadá falešně dokonale.
          var missing = [];
          function failed(l, f, label) { if (l && l[f]) missing.push(label); }
          failed(adis, "adisError", "DPH/ADIS");
          failed(isir, "isirError", "Insolvence");
          failed(ubo, "uboError", "Skuteční majitelé");
          failed(dot, "dotaceError", "Dotace");
          failed(sml, "smlouvyError", "Registr smluv");
          if (eu && eu.error) missing.push("EU sankce");
          if (sl && (sl.slError || (sl.sl && sl.sl.error))) missing.push("Účetní závěrky");
          failed(forn, "forError", "Forenzní indikátory");
          failed(ps, "psError", "PEP/sankce");

          self.riskState = {
            loading: false, ready: true,
            findings: uniq,
            counts: counts,
            score: score,
            level: (report.risk && report.risk.level) || null,
            areas: areas,
            incomplete: missing.length > 0,
            missing: missing,
          };
        }

        // počitadlo dokončených zdrojů — jakmile dorazí poslední, finalizuj
        function tick() { done++; if (done >= total) finalize(); }

        // watchdog (~8 s) — pojistka proti zaseknutému loaderu
        var watchdog = setTimeout(finalize, 8000);

        if (total === 0) { finalize(); return; }
        tasks.forEach(function (p) {
          if (p && typeof p.then === "function") p.then(tick, tick);
          else tick();
        });
      },

      F: function (level, title, desc, group) {
        return { level: level, title: title, desc: desc, group: group, groupLabel: this.gLabel(group) };
      },

      classifyServer: function (f) {
        var m = f.message || "";
        var lvl = f.level === "yellow" ? "amber" : (f.level === "red" ? "red" : "green");
        var group = "rizika", title = m;
        if (/insolven|úpadek/i.test(m)) { group = "rizika"; title = (lvl === "red") ? "Aktivní insolvenční řízení" : "Historie insolvenčního řízení"; }
        else if (/zanikl/i.test(m)) { group = "identita"; title = "Subjekt zanikl"; }
        else if (/statutární orgán/i.test(m)) { group = "vlastnictvi"; title = "Chybí aktivní statutární orgán"; }
        else if (/DPH/i.test(m)) { group = "finance"; title = "DIČ bez aktivní registrace k DPH"; }
        else if (/živnost/i.test(m)) { group = "identita"; title = "Živnostenská oprávnění ukončena"; }
        else if (/sankc/i.test(m)) { group = "rizika"; title = "Shoda na sankčním seznamu EU"; }
        else if (/Žádné varovné/i.test(m)) {
          return { level: "green", title: "Bez varovných signálů v ARES", desc: m, group: "identita", groupLabel: this.gLabel("identita"), _generic: true };
        }
        return { level: lvl, title: title, desc: m, group: group, groupLabel: this.gLabel(group) };
      },

      fromAdis: function (a) {
        if (!a) return [];
        if (a.isUnreliable || a.nespolehlivyPlatceRaw === "ANO")
          return [this.F("red", "Nespolehlivý plátce DPH", "Označen jako nespolehlivý plátce — riziko ručení za DPH dle §109 ZDPH.", "finance")];
        if (a.isVatPayer) {
          var n = (a.bankAccounts || []).length;
          return [this.F("green", "Spolehlivý plátce DPH", "Bez příznaku nespolehlivosti; " + n + " zveřejněných účtů.", "finance")];
        }
        return [];
      },
      fromIsir: function (i) {
        if (!i || !i.available) return [];
        if ((i.activeCount || 0) > 0)
          return [this.F("red", "Aktivní insolvenční řízení", "V ISIR vedeno " + i.activeCount + " aktivních řízení jako dlužník.", "rizika")];
        return [this.F("green", "Žádné insolvenční řízení", "V ISIR nevedeno jako dlužník.", "rizika")];
      },
      fromUbo: function (u) {
        if (!u || !u.available) return [];
        var act = u.active || [];
        // Sken všech textových polí aktivních záznamů (postaveni/udajTyp/jmeno/slovniVyjadreni).
        var blob = function (x) {
          return (x.postaveni || "") + " " + (x.udajTyp || "") + " " + (x.jmeno || "") + " " + (x.slovniVyjadreni || "");
        };
        var fund = act.some(function (x) { return /svěřensk|\btrust\b|svěřen|\bfond/i.test(blob(x)); });
        var indirect = act.some(function (x) { return /nepřím/i.test(blob(x)); });
        if (fund)
          return [this.F("amber", "Ovládání přes svěřenský fond", "Skutečný majitel je deklarován přes svěřenský fond — vrstvená (méně transparentní) struktura vlastnictví.", "vlastnictvi")];
        if (indirect)
          return [this.F("amber", "Nepřímé (vrstvené) ovládání", "Skutečný majitel ovládá firmu nepřímo přes vrstvenou strukturu — ne přímým podílem.", "vlastnictvi")];
        if ((u.activeCount || 0) === 0)
          return [this.F("red", "Skutečný majitel nedohledán", "V evidenci skutečných majitelů není aktivní zápis — netransparentní struktura.", "vlastnictvi")];
        return [];
      },
      fromDotace: function (d) {
        if (!d || !d.available) return [];
        var top = d.topPayedCZK || 0;
        var fmt = window.formatCZK ? window.formatCZK(top) : (top + " Kč");
        if ((d.totalDotaci || 0) > 0 && top >= 10000000)
          return [this.F("amber", "Vysoká závislost na veřejných penězích", "Souhrn dotací " + fmt + " a " + (d.totalDotaci || 0) + " záznamů.", "finance")];
        return [];
      },
      fromSmlouvy: function (s) {
        if (!s || !s.available) return [];
        var rc = s.recentContracts || [];
        var pep = rc.filter(function (c) { return c.vazbaNaPolitiky; }).length;
        if (pep > 0)
          return [this.F("amber", "Politické vazby u veřejných zakázek", "U " + pep + " smluv příznak vazby na politicky exponované osoby.", "finance")];
        return [];
      },
      // Sbírka listin — compliance signál podle stavu účetních závěrek (jen PO).
      fromSbirkaListin: function (s) {
        if (!s || !s.applicable || s.error) return [];
        if (s.status === "nikdy") return [this.F("red", "Nepodává účetní závěrky", s.message, "finance")];
        if (s.status === "zaostava") return [this.F("red", "Účetní závěrky zaostávají", s.message, "finance")];
        if (s.status === "chybi") return [this.F("amber", "Chybí poslední účetní závěrka", s.message, "finance")];
        if (s.pozdniPodani) return [this.F("amber", "Účetní závěrka podána pozdě", "Poslední závěrka uložena se zpožděním >15 měsíců po konci období.", "finance")];
        return [this.F("green", "Účetní závěrky podávány řádně", s.message, "finance")];
      },
      fromSanctions: function (r, report) {
        if (!r) return [];
        var hits = (r.hits || []).length;
        var jmen = ((report.statutary && report.statutary.clenove) || []).length + 1;
        if (hits > 0)
          return [this.F("red", "Shoda na sankčním seznamu EU", hits + " shoda v konsolidovaném sankčním listu EU — ověř datum narození a zemi.", "rizika")];
        return [this.F("green", "Nula shod na sankčních seznamech EU", "Screening " + jmen + " jmen bez zásahu.", "rizika")];
      },
      // Forenzní indikátory (Fáze 1) — signál, ne důkaz; vždy s číslem a kontextem.
      fromForensika: function (d) {
        if (!d) return [];
        var out = [];
        var s = d.sidlo;
        if (s && s.level !== "green" && s.pocet >= 40) {
          out.push(this.F(s.level, "Sídlo sdílí " + s.pocet + " firem", s.pocet + " subjektů na stejné adrese — možné hromadné/virtuální sídlo (znak schránkové firmy). Pozor na byznys centra (false positive).", "identita"));
        }
        (d.statutari || []).forEach(function (p) {
          if (p.level === "green") return;
          out.push(this.F(p.level, p.jmeno + " — angažmá v " + p.pocetFirem + " firmách", "Statutár/UBO spojen s ≥" + p.pocetFirem + " firmami (z indexu) — možný bílý kůň / poskytovatel sídel. Ověř kontext (advokát, likvidátor, manažer holdingu).", "vlastnictvi"));
        }, this);
        if (d.kruhove && d.kruhove.nalezeno) {
          out.push(this.F("red", "Kruhové vlastnictví", "Cyklus ve vlastnické struktuře (" + (d.kruhove.cesta || []).join(" → ") + ") — možné zastírání skutečného majitele.", "vlastnictvi"));
        }
        // „měkký" signál — do skóre s nižší vahou než tvrdé fakty (insolvence apod.).
        return out.map(function (f) { f.soft = true; return f; });
      },
      // PEP — řídicí osoba je politicky exponovaná (AML: rozšířená kontrola/EDD).
      // Sankce se NEpřidávají (už je řeší ddEuSanctionsLoader → ať se nedublují).
      fromPepSankce: function (d) {
        if (!d) return [];
        var out = [];
        (d.pep || []).forEach(function (p) {
          var f = this.F("amber", "PEP: " + p.jmeno, p.jmeno + " (" + (p.funkce || "osoba ve firmě") + ") je politicky exponovaná osoba — " + p.duvod + ". AML vyžaduje rozšířenou kontrolu (EDD). Signál, ne důkaz; ověř profil v Hlídači státu.", "rizika");
          f.soft = true; // PEP = regulatorní nudge, ne tvrdé negativum
          out.push(f);
        }, this);
        // Sankce mimo EU (OFAC/UN/UK) — tvrdý red. EU řeší samostatný loader (nezdvojovat).
        (d.sankce || []).forEach(function (s) {
          if (s.source === "EU") return;
          out.push(this.F("red", "Sankce " + s.source + ": " + s.query, s.query + " — shoda na sankčním seznamu " + s.source + " (" + s.matchedAs + (s.programme ? ", " + s.programme : "") + "). Ověř datum narození a zemi u zdroje.", "rizika"));
        }, this);
        return out;
      },

      // --- command palette ---
      paletteItems: function () {
        var self = this;
        var groups = this.groups.map(function (g, i) {
          return { id: "g-" + g.id, icon: g.icon, label: g.label, kind: "skupina", key: String(i + 1), act: function () { self.active = g.id; } };
        });
        var tools = this.tools.map(function (t) {
          return { id: "t-" + t.id, icon: t.icon, label: t.label, kind: "nástroj", key: "", act: function () { self.focusTool(t.id); } };
        });
        // „Uložená vyhledávání" žijí trvale pod každou skupinou (ve střední části),
        // takže je v ⌘K paletě záměrně neduplikujeme (předešlá dvojí savedSection instance).
        var actions = [
          { id: "a-theme", icon: "🌗", label: "Přepnout téma (světlé/tmavé)", kind: "akce", key: "⌘.", act: function () { self.toggleTheme(); } },
          { id: "a-holding", icon: "🔍", label: "Rozkrýt holding do mapy", kind: "akce", key: "⌘G", act: function () { self.focusTool("graph"); } },
        ];
        var items = groups.concat(tools, actions);
        var q = this.pq.trim().toLowerCase();
        var cleaned = q.replace(/^cz\s*/i, "").replace(/\s|-|\./g, "");
        if (/^\d{7,8}$/.test(cleaned)) {
          items.unshift({ id: "load-" + cleaned, icon: "🔎", label: "Načíst firmu IČO " + cleaned, kind: "firma", key: "↵", act: function () { self.openCompany(cleaned); } });
        }
        if (!q) {
          // prázdný dotaz → předřaď nedávno prohlížené firmy jako rychlé položky
          var rec = (this.recents || []).slice(0, 6).map(function (r) {
            return {
              id: "rec-" + r.ico,
              icon: "🕘",
              label: (r.obchodniJmeno || "Firma") + " · " + r.ico,
              kind: "nedávné",
              key: "",
              act: function () { self.openCompany(r.ico); },
            };
          });
          return rec.concat(items);
        }
        return items.filter(function (c) { return c.label.toLowerCase().indexOf(q) >= 0 || c.kind.indexOf(q) >= 0; });
      },
      runPalette: function (c) { if (c && c.act) c.act(); this.palette = false; this.pq = ""; },
    };

    // Spoj ddSection (báze) + shell (override init aj.). shell má přednost.
    return Object.assign({}, dd, shell);
  }

  window.v2App = v2App;
})();

/* ── Přetahovatelné rozměry workspace /v2 ────────────────────────────────────
 * Sloupce: --cl / --cr na #v2-grid (myš, localStorage, dvojklik = reset, jen ≥1024px).
 * Výška grafu: --gh na #cytoscape-container (tažení dolů) + cy.resize()/fit(). */
(function () {
  function px(v, fb) { var n = parseInt(v, 10); return isFinite(n) ? n : fb; }
  function cyApi() {
    try {
      var sec = document.querySelector('[x-data*="graphSection"]');
      var d = sec && window.Alpine && window.Alpine.$data(sec);
      return d && d.cy ? d.cy : null;
    } catch (e) { return null; }
  }
  function initResizers() {
    // — šířky sloupců —
    var grid = document.getElementById("v2-grid");
    if (grid) {
      var KEY = { left: "iv:cl", right: "iv:cr" };
      var DEF = { left: 290, right: 520 };
      var CLAMP = { left: [220, 560], right: [300, 860] };
      try {
        var sl = localStorage.getItem(KEY.left); if (sl) grid.style.setProperty("--cl", sl);
        var sr = localStorage.getItem(KEY.right); if (sr) grid.style.setProperty("--cr", sr);
      } catch (e) {}
      grid.querySelectorAll('[data-resize="left"],[data-resize="right"]').forEach(function (h) {
        var side = h.getAttribute("data-resize");
        h.addEventListener("mousedown", function (e) {
          if (window.innerWidth < 1024) return;
          e.preventDefault();
          var startX = e.clientX;
          var cs = getComputedStyle(grid);
          var start = side === "left" ? px(cs.getPropertyValue("--cl"), DEF.left) : px(cs.getPropertyValue("--cr"), DEF.right);
          document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
          function move(ev) {
            var raw = side === "left" ? start + (ev.clientX - startX) : start - (ev.clientX - startX);
            var c = CLAMP[side];
            grid.style.setProperty(side === "left" ? "--cl" : "--cr", Math.min(c[1], Math.max(c[0], raw)) + "px");
          }
          function up() {
            document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
            document.body.style.cursor = ""; document.body.style.userSelect = "";
            try { localStorage.setItem(KEY[side], grid.style.getPropertyValue(side === "left" ? "--cl" : "--cr")); } catch (e) {}
          }
          document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
        });
        h.addEventListener("dblclick", function () {
          grid.style.setProperty(side === "left" ? "--cl" : "--cr", DEF[side] + "px");
          try { localStorage.removeItem(KEY[side]); } catch (e) {}
        });
      });
    }
    // — výška grafu (Mapa propojení) — měníme výšku RÁMEČKU mapy (vždy přítomný),
    // ne cytoscape-containeru (ten je x-show podmíněný), ať jde tahat i při chybě grafu.
    var gh = document.getElementById("v2-map-box");
    var gHandle = document.querySelector('[data-resize="graph-h"]');
    if (gh && gHandle) {
      var GKEY = "iv:gh", GDEF = 300, GCLAMP = [140, 700];
      try { var sg = localStorage.getItem(GKEY); if (sg) gh.style.setProperty("--gh", sg); } catch (e) {}
      gHandle.addEventListener("mousedown", function (e) {
        e.preventDefault();
        var startY = e.clientY;
        var startH = parseInt(getComputedStyle(gh).height, 10) || GDEF;
        document.body.style.cursor = "row-resize"; document.body.style.userSelect = "none";
        function move(ev) {
          var hpx = Math.min(GCLAMP[1], Math.max(GCLAMP[0], startH + (ev.clientY - startY)));
          gh.style.setProperty("--gh", hpx + "px");
          var cy = cyApi(); if (cy) cy.resize();
        }
        function up() {
          document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
          document.body.style.cursor = ""; document.body.style.userSelect = "";
          var cy = cyApi(); if (cy) { cy.resize(); try { cy.fit(undefined, 30); } catch (e) {} }
          try { localStorage.setItem(GKEY, gh.style.getPropertyValue("--gh")); } catch (e) {}
        }
        document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
      });
      gHandle.addEventListener("dblclick", function () {
        gh.style.setProperty("--gh", GDEF + "px");
        try { localStorage.removeItem(GKEY); } catch (e) {}
        var cy = cyApi(); if (cy) { cy.resize(); try { cy.fit(undefined, 30); } catch (e) {} }
      });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initResizers);
  else initResizers();
})();
