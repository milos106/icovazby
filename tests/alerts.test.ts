// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { diff } from "../src/alerts/checker.js";
import type { SubscriptionSnapshot } from "../src/alerts/store.js";

const base = (o: Partial<SubscriptionSnapshot> = {}): SubscriptionSnapshot => ({
  obchodniJmeno: "Firma s.r.o.",
  datumZaniku: null,
  isInsolvent: false,
  statutariKeys: ["Jan Novák|1980-01-01"],
  sidloText: "Praha 1",
  platceDph: true,
  nespolehlivyPlatce: false,
  ...o,
});

describe("alerts diff() — detekce změn pro watchlist", () => {
  it("beze změny → žádný alert", () => {
    expect(diff(base(), base())).toEqual([]);
  });

  it("zahájení insolvence", () => {
    expect(diff(base(), base({ isInsolvent: true })).some((x) => /insolven/i.test(x))).toBe(true);
  });

  it("zánik subjektu", () => {
    expect(diff(base(), base({ datumZaniku: "2026-06-01" })).some((x) => /zanikl/i.test(x))).toBe(true);
  });

  it("nový i odešlý statutár", () => {
    const c = diff(base(), base({ statutariKeys: ["Petr Svoboda|1975-05-05"] }));
    expect(c.some((x) => /Nový statutární/i.test(x))).toBe(true);
    expect(c.some((x) => /Odešel/i.test(x))).toBe(true);
  });

  it("změna sídla jen když známe obě hodnoty (žádný falešný alert ze starého snapshotu)", () => {
    expect(diff(base({ sidloText: null }), base({ sidloText: "Brno" })).some((x) => /sídla/i.test(x))).toBe(false);
    expect(diff(base({ sidloText: "Praha 1" }), base({ sidloText: "Brno" })).some((x) => /sídla/i.test(x))).toBe(true);
  });

  it("registrace a zrušení DPH", () => {
    expect(diff(base({ platceDph: false }), base({ platceDph: true })).some((x) => /registrace k DPH/i.test(x))).toBe(true);
    expect(diff(base({ platceDph: true }), base({ platceDph: false })).some((x) => /Zrušena registrace/i.test(x))).toBe(true);
  });

  it("zařazení mezi nespolehlivé plátce DPH (ručení)", () => {
    expect(
      diff(base({ nespolehlivyPlatce: false }), base({ nespolehlivyPlatce: true })).some((x) => /NESPOLEHLIV/i.test(x)),
    ).toBe(true);
  });

  it("ADIS nedostupné (undefined) → žádný falešný alert", () => {
    expect(diff(base({ nespolehlivyPlatce: undefined }), base({ nespolehlivyPlatce: undefined }))).toEqual([]);
  });
});
