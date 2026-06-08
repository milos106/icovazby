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

const cache = new LRUCache<string, unknown>({
  max: MAX_ENTRIES,
  ttl: DEFAULT_TTL_MS,
});

export async function cached<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number } = {},
): Promise<T> {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const value = await fn();
  cache.set(key, value, opts.ttlMs ? { ttl: opts.ttlMs } : undefined);
  return value;
}

export function cacheStats(): { size: number; max: number } {
  return { size: cache.size, max: cache.max };
}

export function invalidate(key: string): void {
  cache.delete(key);
}
