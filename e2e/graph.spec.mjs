import { test, expect } from "@playwright/test";

const BASE = "https://icovazby.cz";
const JEDLICKA = { jmeno: "Ing. MICHAL JEDLIČKA", dob: "1978-01-06" };
const CINGR = { jmeno: "Ing. PETR CINGR", dob: "1968-05-18" };

async function resolveIcos(request, p) {
  const r = await request.post(`${BASE}/api/persons/vazby`, {
    data: { jmeno: p.jmeno, datumNarozeni: p.dob, includeHistorical: true, resolveIco: true },
  });
  const j = await r.json();
  return [...new Set((j.vazby || [])
    .filter((v) => v.resolvedIco && v.ambiguousMatchCount <= 1)
    .map((v) => v.resolvedIco))];
}

/** Přečte graphSection.egoPersons přes Alpine (= co reálně vidí UI jako subjekty). */
async function egoLabels(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[x-data*="graphSection"]');
    if (!el || !window.Alpine) return null;
    const d = window.Alpine.$data(el);
    return d && d.egoPersons ? d.egoPersons.map((e) => e.label) : null;
  });
}

test("subjekt přežije přidání další osoby (ego Jedlička → ➕ Cingr)", async ({ page, request }) => {
  const jIcos = await resolveIcos(request, JEDLICKA);
  const cIcos = await resolveIcos(request, CINGR);
  console.log("Jedlička icos:", jIcos, "| Cingr icos:", cIcos);

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.Alpine && !!document.querySelector('[x-data*="graphSection"]'));
  await page.waitForTimeout(800);

  // 1) Ego Jedlička (stejné eventy jako tlačítko „Ego-graf osoby")
  await page.evaluate(({ p, icos }) => {
    window.dispatchEvent(new CustomEvent("ares-focus-person", { detail: { jmeno: p.jmeno, datumNarozeni: p.dob } }));
    window.dispatchEvent(new CustomEvent("ares-seed-graph", { detail: { icos } }));
  }, { p: JEDLICKA, icos: jIcos });

  await page.waitForTimeout(5000); // cross-persons fetch + cose layout
  const after1 = await egoLabels(page);
  console.log("→ egoPersons po ego Jedlička:", after1);
  expect(after1, "po ego má být 1 subjekt (Jedlička)").not.toBeNull();
  expect(after1.length).toBe(1);

  // Zaháknu renderCytoscape — uvidím KAŽDÝ render + jeho pending/ego stav.
  await page.evaluate(() => {
    const el = document.querySelector('[x-data*="graphSection"]');
    const d = window.Alpine.$data(el);
    window.__renders = [];
    const orig = d.renderCytoscape.bind(d);
    d.renderCytoscape = function () {
      window.__renders.push({ pending: this.pendingFocusPerson, egoBefore: this.egoPersons.map((e) => e.label) });
      return orig();
    };
  });

  // 2) Přidej Cingra (stejný event jako „➕ Přidat do mapy")
  await page.evaluate(({ p, icos }) => {
    window.dispatchEvent(new CustomEvent("ares-add-to-graph", { detail: { icos, person: { jmeno: p.jmeno, datumNarozeni: p.dob } } }));
  }, { p: CINGR, icos: cIcos });

  await page.waitForTimeout(5000);
  const dump = await page.evaluate(() => {
    const el = document.querySelector('[x-data*="graphSection"]');
    const d = window.Alpine.$data(el);
    return {
      egoPersons: d.egoPersons.map((e) => e.label),
      pendingFocusPerson: d.pendingFocusPerson,
      fullKeys: d.fullKeys,
      rawIcoCount: (d.raw || "").split(/\s+/).filter(Boolean).length,
      cyNodes: d.cy ? d.cy.nodes().length : null,
      hasJedlicka: d.cy ? d.cy.getElementById("P-Ing. MICHAL JEDLIČKA|1978-01-06").length : null,
      hasCingr: d.cy ? d.cy.getElementById("P-Ing. PETR CINGR|1968-05-18").length : null,
    };
  });
  const renders = await page.evaluate(() => window.__renders || []);
  console.log("→ RENDERY po přidání Cingra:", JSON.stringify(renders, null, 2));
  console.log("→ STAV po přidání Cingra:", JSON.stringify(dump, null, 2));
  const after2 = dump.egoPersons;

  // OČEKÁVÁNÍ: oba subjekty zůstanou
  expect(after2, "Jedlička nesmí zmizet").toEqual(
    expect.arrayContaining([expect.stringContaining("JEDLIČKA")]),
  );
  expect(after2).toEqual(expect.arrayContaining([expect.stringContaining("CINGR")]));
  expect(after2.length).toBe(2);
});

test("primární subjekt — klik na chip zaměří jen jeho (#2)", async ({ page, request }) => {
  const jIcos = await resolveIcos(request, JEDLICKA);
  const cIcos = await resolveIcos(request, CINGR);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.Alpine && !!document.querySelector('[x-data*="graphSection"]'));
  await page.waitForTimeout(800);

  // postav 2-subjektový graf (ego Jedlička + ➕ Cingr)
  await page.evaluate(({ p, icos }) => {
    window.dispatchEvent(new CustomEvent("ares-focus-person", { detail: { jmeno: p.jmeno, datumNarozeni: p.dob } }));
    window.dispatchEvent(new CustomEvent("ares-seed-graph", { detail: { icos } }));
  }, { p: JEDLICKA, icos: jIcos });
  await page.waitForTimeout(5000);
  await page.evaluate(({ p, icos }) => {
    window.dispatchEvent(new CustomEvent("ares-add-to-graph", { detail: { icos, person: { jmeno: p.jmeno, datumNarozeni: p.dob } } }));
  }, { p: CINGR, icos: cIcos });
  await page.waitForTimeout(5000);
  expect((await egoLabels(page)).length).toBe(2);

  // klik na chip Jedličky → primární (jen zvýraznění, kontext zůstává)
  const res = await page.evaluate(() => {
    const d = window.Alpine.$data(document.querySelector('[x-data*="graphSection"]'));
    const jKey = d.egoPersons.find((e) => e.label.includes("JEDLIČKA")).key;
    const cKey = d.egoPersons.find((e) => e.label.includes("CINGR")).key;
    d.setPrimary(jKey);
    return {
      primaryKey: d.primaryKey, jKey,
      jHasPrimary: d.cy.getElementById(jKey).hasClass("primary"),
      cingrFaded: d.cy.getElementById(cKey).hasClass("faded"),
    };
  });
  console.log("→ primary:", JSON.stringify(res));
  expect(res.primaryKey).toBe(res.jKey);
  expect(res.jHasPrimary).toBe(true);  // primární má .primary ring
  expect(res.cingrFaded).toBe(false);  // druhý subjekt ZŮSTANE viditelný (kontext + vazba)

  // klik znovu → zpět na multi
  const off = await page.evaluate(() => {
    const d = window.Alpine.$data(document.querySelector('[x-data*="graphSection"]'));
    d.setPrimary(d.primaryKey);
    return { primaryKey: d.primaryKey, anyPrimaryClass: d.cy.nodes(".primary").length };
  });
  expect(off.primaryKey).toBeNull();
  expect(off.anyPrimaryClass).toBe(0);
});
