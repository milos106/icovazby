// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tests pro timeline service — extrakce events z ARES VR.
 */

import { describe, expect, it } from "vitest";
import { buildTimeline } from "../src/timeline/service.js";
import { loadFixture, makeMockClient } from "./mockClient.js";
import type { EkonomickySubjekt, VrOdpoved } from "../src/ares/types.js";

const subject = loadFixture<EkonomickySubjekt>("subjekt_agrofert.json");
const vr = loadFixture<VrOdpoved>("vr_45193258_liberty.json");

describe("buildTimeline", () => {
  it("returns events with vznik + statutář history", async () => {
    const client = makeMockClient({
      subjects: { "26185610": subject },
      vr: { "26185610": vr },
    });
    const result = await buildTimeline(client, "26185610");
    expect(result.ico).toBe("26185610");
    expect(result.eventCount).toBeGreaterThan(0);
    // vznik should be present
    const vznikEvent = result.events.find((e) => e.type === "vznik");
    expect(vznikEvent).toBeTruthy();
    // years should be sorted desc
    if (result.years.length >= 2) {
      expect(result.years[0]).toBeGreaterThanOrEqual(result.years[1]!);
    }
  });

  it("rejects invalid IČO", async () => {
    const client = makeMockClient({});
    await expect(buildTimeline(client, "invalid")).rejects.toThrow();
  });

  it("events sorted descending by date", async () => {
    const client = makeMockClient({
      subjects: { "26185610": subject },
      vr: { "26185610": vr },
    });
    const result = await buildTimeline(client, "26185610");
    for (let i = 0; i < result.events.length - 1; i++) {
      expect(result.events[i]!.date >= result.events[i + 1]!.date).toBe(true);
    }
  });
});
