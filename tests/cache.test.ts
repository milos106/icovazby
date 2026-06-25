// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock persistentní vrstvy (better-sqlite3) — testujeme jen rozhodování cached().
const { dbSet, dbGet } = vi.hoisted(() => ({
  dbSet: vi.fn(),
  dbGet: vi.fn(() => undefined as unknown),
}));
vi.mock("../src/persons_index/db.js", () => ({
  dbGetResponseCache: dbGet,
  dbSetResponseCache: dbSet,
}));

import { cached } from "../src/cache.js";

// degradace = služba vrátila { available:false } (upstream/HS selhal)
const notFailed = (v: unknown) => (v as { available?: unknown }).available !== false;
let n = 0;
const k = (p: string) => `${p}:${++n}`; // unikátní klíč → žádný in-memory hit mezi testy

describe("cached() — necachovat degradované výsledky (isComplete)", () => {
  beforeEach(() => {
    dbSet.mockClear();
    dbGet.mockClear();
  });

  it("NEpersistuje degradovaný výsledek (isComplete → false)", async () => {
    const r = await cached(k("inc"), async () => ({ available: false, reason: "HS down" }), {
      persist: true,
      isComplete: notFailed,
    });
    expect(r).toEqual({ available: false, reason: "HS down" });
    expect(dbSet).not.toHaveBeenCalled();
  });

  it("persistuje kompletní výsledek (isComplete → true)", async () => {
    const r = await cached(k("ok"), async () => ({ available: true, x: 1 }), {
      persist: true,
      isComplete: notFailed,
    });
    expect(r).toEqual({ available: true, x: 1 });
    expect(dbSet).toHaveBeenCalledTimes(1);
  });

  it("bez isComplete persistuje vždy (zpětná kompatibilita)", async () => {
    await cached(k("nopred"), async () => ({ anything: true }), { persist: true });
    expect(dbSet).toHaveBeenCalledTimes(1);
  });

  it("degradovaný se vrací z krátké in-memory cache (fn se podruhé nevolá)", async () => {
    const key = k("incmem");
    const v1 = await cached(key, async () => ({ available: false }), { persist: true, isComplete: notFailed });
    let secondCalled = false;
    const v2 = await cached(
      key,
      async () => {
        secondCalled = true;
        return { available: true };
      },
      { persist: true, isComplete: notFailed },
    );
    expect(v1).toEqual({ available: false });
    expect(v2).toEqual({ available: false }); // in-memory drží degradovaný (krátce), self-heal po TTL
    expect(secondCalled).toBe(false);
    expect(dbSet).not.toHaveBeenCalled();
  });
});
