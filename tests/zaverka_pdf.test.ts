// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseRozvaha, parseRozvahaMulti } from "../src/justice_sl/pdf.js";

// Reálný vzor AGROFERT 2024: listina obsahuje KONSOLIDOVANOU (IFRS) i
// NEKONSOLIDOVANOU (individuální) rozvahu. Konsolidovaná nemá „Cizí zdroje"
// (jen dílčí „…závazky celkem") → parsování spojeného textu vezme aktiva/VK z
// konsolidované, ale cizí zdroje z jiného výkazu → aktiva ≠ pasiva.
const KONSOL = [
  "Konsolidovaná rozvaha",
  "Aktiva celkem                        203 562 776    214 770 588",
  "Vlastní kapitál a závazky celkem     203 562 776    214 770 588",
  "Vlastní kapitál celkem               116 310 447    108 674 679",
  "Dlouhodobé finanční závazky celkem    17 144 305     54 756 527",
  "Nekonsolidované tržby koncernu dosáhly hodnoty 316 730 mil. Kč.",
].join("\n");

// Nekonsolidovaná (česká vyhláška) — SEDÍ: 70 591 055 = 60 569 758 + 10 020 936.
const INDIV = [
  "Účetní závěrka byla sestavena jako nekonsolidovaná.",
  "AKTIVA CELKEM        73 604 329   -3 013 275    70 591 055    70 733 595",
  "PASIVA CELKEM                                    70 591 055    70 733 595",
  "A.        VLASTNÍ KAPITÁL                        60 569 758    50 521 646",
  "B. + C.   CIZÍ ZDROJE                            10 020 936    20 211 459",
].join("\n");

describe("parseRozvahaMulti — výběr konzistentní bilance z více listin", () => {
  it("vybere nekonsolidovanou (balancuje), ne křížově pomíchanou konsolidovanou", () => {
    const r = parseRozvahaMulti([KONSOL, INDIV], "url", 2024)!;
    expect(r.confidence).toBe("high");
    expect(r.aktivaCelkem[0]).toBe(70591055);
    expect(r.vlastniKapital[0]).toBe(60569758);
    expect(r.ciziZdroje[0]).toBe(10020936);
  });

  it("je nezávislý na pořadí souborů", () => {
    const r = parseRozvahaMulti([INDIV, KONSOL], "url", 2024)!;
    expect(r.aktivaCelkem[0]).toBe(70591055);
    expect(r.confidence).toBe("high");
  });

  it("REGRESE (starý bug): spojený text pomíchá pole → aktiva ≠ pasiva → low", () => {
    const bug = parseRozvaha(KONSOL + "\n" + INDIV, "url", 2024)!;
    expect(bug.aktivaCelkem[0]).toBe(203562776); // z konsolidované
    expect(bug.ciziZdroje[0]).toBe(17144305); // z jiného výkazu
    expect(bug.confidence).toBe("low"); // self-check to nachytá (nezobrazí se jako jisté)
  });

  it("tržby/VH se doplní z ODDĚLENÉHO výkazu zisku a ztráty", () => {
    const vysledovka = [
      "VÝKAZ ZISKU A ZTRÁTY",
      "Tržby z prodeje výrobků a služeb     12 345 678    11 111 111",
      "Výsledek hospodaření za účetní období   987 654       555 444",
    ].join("\n");
    const r = parseRozvahaMulti([INDIV, vysledovka], "url", 2023)!;
    expect(r.aktivaCelkem[0]).toBe(70591055);
    expect(r.trzby[0]).toBe(12345678);
    expect(r.vysledekHospodareni[0]).toBe(987654);
    expect(r.confidence).toBe("high");
  });

  it("jednoduchý jednosouborový případ = beze změny (žádná regrese)", () => {
    const r = parseRozvahaMulti([INDIV], "url", 2022)!;
    expect(r.aktivaCelkem[0]).toBe(70591055);
    expect(r.confidence).toBe("high");
  });

  it("když NIC nebalancuje → fallback na spojený text (staré chování, low)", () => {
    const r = parseRozvahaMulti([KONSOL], "url", 2024)!;
    expect(r.aktivaCelkem[0]).toBe(203562776);
    expect(r.confidence).toBe("low");
  });
});

describe("tržby — rozšířené pokrytí Výkazu zisku a ztráty", () => {
  it("nová forma: Tržby za prodej zboží (č.ř. 02, obchodní firma)", () => {
    const vzz = "VÝKAZ ZISKU A ZTRÁTY\nII.    Tržby za prodej zboží     02     5 000 000    4 000 000";
    const r = parseRozvahaMulti([INDIV, vzz], "url", 2023)!;
    expect(r.trzby[0]).toBe(5000000);
  });

  it("plná forma: Tržby za prodej vlastních výrobků a služeb", () => {
    const vzz = "I.  Tržby za prodej vlastních výrobků a služeb     1 234 567     1 111 111";
    const r = parseRozvahaMulti([INDIV, vzz], "url", 2021)!;
    expect(r.trzby[0]).toBe(1234567);
  });

  it("stará forma: Výkony", () => {
    const vzz = "II.   Výkony     04     9 000 000     8 000 000";
    const r = parseRozvahaMulti([INDIV, vzz], "url", 2022)!;
    expect(r.trzby[0]).toBe(9000000);
  });

  it("„Výkonová spotřeba“ (náklad) se NEbere jako tržby", () => {
    const vzz = "A.  Výkonová spotřeba     2 000 000     1 900 000";
    const r = parseRozvahaMulti([INDIV, vzz], "url", 2020)!;
    expect(r.trzby[0]).toBeNull();
  });
});
