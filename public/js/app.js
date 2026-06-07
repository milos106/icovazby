/**
 * ares-web — Alpine.js controllers and API glue.
 * Vanilla, no build step. Loaded from /public/js/app.js.
 */

const ICO_RE = /^\d{7,8}$/;

async function jsonFetch(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data.message || data.error || `HTTP ${r.status}`);
  }
  return data;
}

function searchSection() {
  return {
    query: "",
    loading: false,
    error: "",
    profile: null,
    results: [],
    totalFound: 0,
    async run() {
      this.error = "";
      this.profile = null;
      this.results = [];
      this.totalFound = 0;
      const q = (this.query || "").trim().replace(/\s+/g, " ");
      if (!q) return;
      this.loading = true;
      try {
        const cleaned = q.replace(/^CZ\s*/i, "").replace(/\s|-|\./g, "");
        if (ICO_RE.test(cleaned)) {
          this.profile = await jsonFetch(`/api/company/${encodeURIComponent(cleaned)}`);
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
  };
}

function ddSection() {
  return {
    ico: "",
    loading: false,
    error: "",
    report: null,
    async run(maybeIco) {
      this.error = "";
      this.report = null;
      const i = (maybeIco || this.ico || "").trim().replace(/^CZ\s*/i, "").replace(/\s|-|\./g, "");
      if (!ICO_RE.test(i)) {
        this.error = "Zadej platné IČO (7-8 číslic).";
        return;
      }
      this.ico = i;
      this.loading = true;
      try {
        this.report = await jsonFetch(`/api/dd/${encodeURIComponent(i)}`);
        document.getElementById("dd")?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
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
      } catch (e) {
        this.error = e.message;
      } finally {
        this.loading = false;
      }
    },
  };
}

// Expose factories on window for Alpine
window.searchSection = searchSection;
window.ddSection = ddSection;
window.graphSection = graphSection;
window.addressSection = addressSection;
