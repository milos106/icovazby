// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tests pro SQLite db.ts wrapper. Používá in-memory database přes
 * ARES_WEB_DATA_DIR aby se nedotýkalo produkčních dat.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "icovazby-db-test-"));
  process.env.ARES_WEB_DATA_DIR = tmpDir;
});

afterAll(() => {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("db.ts SQLite layer", () => {
  it("creates schema and inserts/reads subjects", async () => {
    const { dbUpsertSubject, dbListSubjects } = await import("../src/persons_index/db.js");
    dbUpsertSubject("26185610", "AGROFERT, a.s.");
    dbUpsertSubject("45274649", "ČEZ, a.s.");
    const subjects = dbListSubjects();
    expect(subjects.length).toBeGreaterThanOrEqual(2);
    const ag = subjects.find((s) => s.ico === "26185610");
    expect(ag?.obchodniJmeno).toBe("AGROFERT, a.s.");
  });

  it("upserts memberships with idempotency", async () => {
    const { dbUpsertMembership, dbFindPerson } = await import("../src/persons_index/db.js");
    const input = {
      personKey: "petr|tippelt|1968-06-21",
      displayName: "PETR TIPPELT",
      jmeno: "PETR",
      prijmeni: "TIPPELT",
      titulPred: null,
      datumNarozeni: "1968-06-21",
      ico: "27342085",
      obchodniJmeno: "SAZKA, a.s.",
      funkce: "člen správní rady",
      organ: "Správní rada",
      datumZapisu: null,
      datumVymazu: null,
      source: "ARES_VR",
    };
    dbUpsertMembership(input);
    dbUpsertMembership(input); // znovu — měl by být no-op
    const p = dbFindPerson("petr|tippelt|1968-06-21");
    expect(p).toBeTruthy();
    expect(p?.memberships.length).toBe(1);
    expect(p?.memberships[0]?.ico).toBe("27342085");
  });

  it("ownership getChildrenByParent honors includeHistorical", async () => {
    const { dbUpsertOwnership, dbGetChildrenByParent } = await import("../src/persons_index/db.js");
    dbUpsertOwnership({
      childIco: "45148210",
      parentIco: "26185610",
      validFrom: "2017-01-01",
      validTo: null,
      source: "ARES_VR_akcionari",
    });
    dbUpsertOwnership({
      childIco: "99999999",
      parentIco: "26185610",
      validFrom: "2010-01-01",
      validTo: "2018-12-31",
      source: "ARES_VR_akcionari",
    });
    const active = dbGetChildrenByParent("26185610", false);
    expect(active).toContain("45148210");
    expect(active).not.toContain("99999999");
    const all = dbGetChildrenByParent("26185610", true);
    expect(all).toContain("45148210");
    expect(all).toContain("99999999");
  });

  it("tentative bucket key-less lookup", async () => {
    const { dbUpsertTentativeMembership, dbFindTentative } = await import("../src/persons_index/db.js");
    dbUpsertTentativeMembership({
      tentativeKey: "jiri|bartasek",
      displayName: "JIŘÍ BARTÁSEK",
      jmeno: "JIŘÍ",
      prijmeni: "BARTÁSEK",
      ico: "27342085",
      obchodniJmeno: "SAZKA, a.s.",
      funkce: "předseda správní rady",
      organ: "Správní rada",
      datumZapisu: "2020-02-19",
      datumVymazu: "2023-11-09",
      source: "ARES_VR",
    });
    const p = dbFindTentative("jiri|bartasek");
    expect(p).toBeTruthy();
    expect(p?.jmeno).toBe("JIŘÍ");
    expect(p?.memberships.length).toBe(1);
    expect(p?.memberships[0]?.datumVymazu).toBe("2023-11-09");
  });

  it("audit log writes + reads", async () => {
    const { dbAudit, dbAuditQuery } = await import("../src/persons_index/db.js");
    dbAudit({ ip: "1.2.3.4", action: "dd", targetIco: "26185610", userAgent: "test" });
    dbAudit({ ip: "1.2.3.4", action: "holding/discover", targetIco: "26185610", userAgent: "test" });
    const rows = dbAuditQuery({ since: 0, limit: 100 });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.action).toBeDefined();
    expect(rows[0]?.target_ico).toBe("26185610");
  });

  it("stats returns counters", async () => {
    const { dbStats } = await import("../src/persons_index/db.js");
    const s = dbStats();
    expect(s.subjectsCount).toBeGreaterThan(0);
    expect(s.personsCount).toBeGreaterThan(0);
    expect(s.ownershipEdgesCount).toBeGreaterThan(0);
    expect(s.tentativeCount).toBeGreaterThan(0);
    expect(s.path).toContain("persons-index.sqlite");
  });
});
