// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pre-seed subjects inventory at server startup with top Czech companies.
 *
 * Účel: lokální fallback search (substring match v subjects inventory) najde
 * známé firmy i pro neúplné zadání jako "agrofer", "ČEZ", "škoda…" — bez
 * nutnosti aby je předtím někdo vyhledával přes app.
 *
 * Strategie:
 * - Seznam `top-cz-companies.json` udržujeme ručně (~100 nejznámějších brandů).
 * - Při bootu pro každé IČO zavoláme ARES (přes p-limit, šetrně k rate limitu).
 * - Pokud ARES potvrdí, uložíme reálné obchodniJmeno do subjects (preferenčně
 *   ARES je authoritativní, naše hand-list může mít překlepy).
 * - Pokud IČO neexistuje (NOT_FOUND), preskočíme bez chyby.
 * - Idempotentní — pokud subjekt už v inventory je, upsert ho jen aktualizuje.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pLimit from "p-limit";
import type { AresClient } from "../ares/client.js";
import { flattenMembers, memberDisplayName } from "../ares/vr.js";
import { upsertMembership, upsertSubject } from "../persons_index/store.js";

interface SeedEntry {
  ico: string;
  obchodniJmeno: string;
}

// tsup bundluje preseed do dist/server.js → import.meta.url ukazuje na dist/,
// ne na src/seed/. JSON file kopírujeme do dist/seed/ přes tsup onSuccess.
const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(HERE, "seed", "top-cz-companies.json");

export async function preseedTopCompanies(client: AresClient): Promise<{ added: number; skipped: number; total: number }> {
  let raw: string;
  try {
    raw = await readFile(SEED_PATH, "utf-8");
  } catch (e) {
    console.warn(`[preseed] Nepodařilo se načíst ${SEED_PATH}:`, (e as Error).message);
    return { added: 0, skipped: 0, total: 0 };
  }

  let seeds: SeedEntry[];
  try {
    seeds = JSON.parse(raw);
  } catch (e) {
    console.warn(`[preseed] Špatný JSON v ${SEED_PATH}:`, (e as Error).message);
    return { added: 0, skipped: 0, total: 0 };
  }

  // Deduplikace v seed listu (manuální list může mít omyly).
  const unique = new Map<string, SeedEntry>();
  for (const s of seeds) if (s.ico && !unique.has(s.ico)) unique.set(s.ico, s);
  const list = [...unique.values()];

  const limit = pLimit(2); // šetrně k ARES rate limit
  let added = 0;
  let skipped = 0;
  let memberships = 0;
  const deepSeed = process.env.PRESEED_DEEP !== "0";

  await Promise.all(
    list.map((s) =>
      limit(async () => {
        try {
          const subject = await client.getEconomicSubject(s.ico);
          // ARES je authoritativní — preferuj jeho jméno před naším hand-listem
          const name = subject.obchodniJmeno ?? s.obchodniJmeno;
          upsertSubject(s.ico, name);
          added++;

          // Deep seed: pro každou firmu načíst VR a uložit jednatele do
          // persons_index. Tím holding discovery najde sdílené statutáry
          // mezi firmami i bez user history. Vypnutí: PRESEED_DEEP=0.
          if (deepSeed) {
            try {
              const vr = await client.getVrRecord(s.ico);
              for (const m of flattenMembers(vr, { activeOnly: true })) {
                const fo = m.fyzickaOsoba;
                if (!fo?.jmeno || !fo.prijmeni || !fo.datumNarozeni) continue;
                upsertMembership({
                  jmeno: fo.jmeno,
                  prijmeni: fo.prijmeni,
                  titulPred: fo.titulPredJmenem ?? null,
                  displayName: memberDisplayName(m),
                  datumNarozeni: fo.datumNarozeni,
                  ico: s.ico,
                  obchodniJmeno: name,
                  funkce: m.funkce ?? null,
                  organ: m.organName ?? null,
                  datumZapisu: m.datumZapisu ?? null,
                  datumVymazu: null,
                  source: "ARES_VR",
                });
                memberships++;
              }
            } catch {
              /* VR neexistuje (OSVČ apod.) — skip */
            }
          }
        } catch {
          // NOT_FOUND nebo síťová chyba — jen skip
          skipped++;
        }
      }),
    ),
  );

  return { added, skipped, total: list.length, memberships };
}
