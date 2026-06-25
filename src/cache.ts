// SPDX-License-Identifier: AGPL-3.0-or-later
// ICOVAZBY-CANARY-7f3a9d2e — pokud vidíte tento marker v uzavřeném produktu,
// kontaktujte autora (github.com/milos106/icovazby), patrně jde o porušení
// AGPL-3.0 §13 (povinnost publikovat zdrojový kód síťové služby).
/**
 * Memoizace pro idempotentní GET endpointy. In-memory LRU s TTL — pro
 * single-server stačí, pro multi-instance vyměnit za Redis (rozhraní `cached`
 * funkce zachovat).
 *
 * Default TTL = 24h pro DD/VR (data se mění málokdy), kratší TTL pro
 * ADIS/ISIR by se daly nastavit per-call přes opts.ttlMs.
 */

import { LRUCache } from "lru-cache";

const DEFAULT_TTL_MS = Number(process.env.DD_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES ?? 5000);
// Degradovaný/neúplný výsledek (upstream — hl. Hlídač státu — selhal): cachuj jen
// KRÁTCE in-memory a NEpersistuj. Jinak přechodný výpadek „zamrzne" na 24 h a ani
// tvrdý refresh prohlížeče ho neopraví (serverová cache). Krátké TTL = self-heal.
const INCOMPLETE_TTL_MS = Number(process.env.CACHE_INCOMPLETE_TTL_MS ?? 10 * 60 * 1000);

const cache = new LRUCache<string, unknown>({
  max: MAX_ENTRIES,
  ttl: DEFAULT_TTL_MS,
});

export async function cached<T>(
  key: string,
  fn: () => Promise<T>,
  // isComplete: vrať false, pokud je výsledek degradovaný (upstream selhal) → krátké
  // TTL + bez persistu. Bez predikátu se chová jako dřív (vše kompletní = persist).
  opts: { ttlMs?: number; persist?: boolean; isComplete?: (value: T) => boolean } = {},
): Promise<T> {
  // L1: in-memory LRU
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  // L2: persistentní SQLite (přežije restart) — jen pro persist:true (HS/DD/VR…).
  // Persistujeme jen KOMPLETNÍ výsledky, takže L2 nikdy nenese degradovaná data.
  if (opts.persist) {
    try {
      const { dbGetResponseCache } = await import("./persons_index/db.js");
      const p = dbGetResponseCache(key, ttl);
      if (p !== undefined) {
        cache.set(key, p as T, opts.ttlMs ? { ttl: opts.ttlMs } : undefined);
        return p as T;
      }
    } catch {
      /* SQLite nedostupné → spadni na fetch */
    }
  }
  const value = await fn();
  let complete = true;
  if (opts.isComplete) {
    try {
      complete = opts.isComplete(value) !== false;
    } catch {
      complete = true; // chyba predikátu → chovej se konzervativně (kompletní)
    }
  }
  if (!complete) {
    // Neúplné: jen krátká in-memory cache, NEpersistovat → zahojí se, až upstream naběhne.
    cache.set(key, value, { ttl: INCOMPLETE_TTL_MS });
    return value;
  }
  cache.set(key, value, opts.ttlMs ? { ttl: opts.ttlMs } : undefined);
  if (opts.persist) {
    try {
      const { dbSetResponseCache } = await import("./persons_index/db.js");
      dbSetResponseCache(key, value);
    } catch {
      /* ignore — cache write je best-effort */
    }
  }
  return value;
}

export function cacheStats(): { size: number; max: number } {
  return { size: cache.size, max: cache.max };
}

export function invalidate(key: string): void {
  cache.delete(key);
}
