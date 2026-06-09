// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Časová osa firmy — sbírá history events z ARES + VR a sortí
 * chronologicky. Slouží UI pro vertical timeline vizualizaci.
 *
 * Žádné nové datové zdroje — všechno už ARES VR vrací, jen to sjednotíme
 * do uniform event tvaru.
 */

import type { AresClient } from "../ares/client.js";
import type { EkonomickySubjekt, VrOdpoved, VrZaznam } from "../ares/types.js";
import { validateIco as validateIcoFn } from "../ares/normalize.js";
import { InvalidInputError } from "../errors.js";

export type TimelineEventType =
  | "vznik"
  | "zanik"
  | "jmeno"
  | "jmeno-konec"
  | "statutar-vznik"
  | "statutar-zanik"
  | "akcionar-vznik"
  | "akcionar-zanik"
  | "kapital"
  | "kapital-konec";

export interface TimelineEvent {
  /** ISO YYYY-MM-DD. */
  date: string;
  type: TimelineEventType;
  /** Hlavní popisek (1 řádek). */
  title: string;
  /** Druhý řádek s detailem (organ, funkce, atd.). */
  detail?: string;
  /** Pro reverse lookup v UI — IČO osoby nebo právnické osoby. */
  refIco?: string;
}

function pushIfDate(events: TimelineEvent[], date: string | undefined | null, ev: Omit<TimelineEvent, "date">) {
  if (!date) return;
  const norm = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(norm)) return;
  events.push({ date: norm, ...ev });
}

function processZaznam(events: TimelineEvent[], zaznam: VrZaznam) {
  // Obchodní jméno historie
  for (const oj of zaznam.obchodniJmeno ?? []) {
    pushIfDate(events, oj.datumZapisu, {
      type: "jmeno",
      title: `Název: ${oj.hodnota ?? "?"}`,
    });
    pushIfDate(events, oj.datumVymazu, {
      type: "jmeno-konec",
      title: `Konec názvu: ${oj.hodnota ?? "?"}`,
    });
  }
  // Statutáři
  for (const organ of zaznam.statutarniOrgany ?? []) {
    const organName = organ.nazevOrganu ?? "Statutární orgán";
    for (const clen of organ.clenoveOrganu ?? []) {
      const fo = clen.fyzickaOsoba;
      const po = clen.pravnickaOsoba;
      const name = fo?.jmeno && fo?.prijmeni
        ? `${fo.jmeno} ${fo.prijmeni}`
        : po?.obchodniJmeno ?? "(neznámá osoba)";
      const funkce = clen.clenstvi?.funkce?.nazev ?? clen.nazevAngazma ?? "člen";
      pushIfDate(events, clen.datumZapisu, {
        type: "statutar-vznik",
        title: `${name} — ${funkce}`,
        detail: organName,
        refIco: po?.ico ?? undefined,
      });
      pushIfDate(events, clen.datumVymazu, {
        type: "statutar-zanik",
        title: `${name} — konec ${funkce}`,
        detail: organName,
        refIco: po?.ico ?? undefined,
      });
    }
  }
  // Akcionáři a.s. — vnořené bloky
  const akcionariRaw = (zaznam as unknown as { akcionari?: Array<{
    datumZapisu?: string;
    datumVymazu?: string | null;
    clenoveOrganu?: Array<{
      datumZapisu?: string;
      datumVymazu?: string | null;
      pravnickaOsoba?: { ico?: string; obchodniJmeno?: string };
      fyzickaOsoba?: { jmeno?: string; prijmeni?: string };
    }>;
  }> }).akcionari;
  for (const blok of akcionariRaw ?? []) {
    for (const clen of blok.clenoveOrganu ?? []) {
      const name = (clen.pravnickaOsoba?.obchodniJmeno
        ?? `${clen.fyzickaOsoba?.jmeno ?? ""} ${clen.fyzickaOsoba?.prijmeni ?? ""}`.trim())
        || "(neznámý akcionář)";
      pushIfDate(events, clen.datumZapisu ?? blok.datumZapisu, {
        type: "akcionar-vznik",
        title: `${name} se stal akcionářem`,
        refIco: clen.pravnickaOsoba?.ico,
      });
      pushIfDate(events, clen.datumVymazu ?? blok.datumVymazu, {
        type: "akcionar-zanik",
        title: `${name} přestal být akcionářem`,
        refIco: clen.pravnickaOsoba?.ico,
      });
    }
  }
  // Společníci s.r.o. — flat list
  const spolecniciRaw = (zaznam as unknown as { spolecnici?: Array<{
    datumZapisu?: string;
    datumVymazu?: string | null;
    pravnickaOsoba?: { ico?: string; obchodniJmeno?: string };
    fyzickaOsoba?: { jmeno?: string; prijmeni?: string };
  }> }).spolecnici;
  for (const clen of spolecniciRaw ?? []) {
    const name = (clen.pravnickaOsoba?.obchodniJmeno
      ?? `${clen.fyzickaOsoba?.jmeno ?? ""} ${clen.fyzickaOsoba?.prijmeni ?? ""}`.trim())
      || "(neznámý společník)";
    pushIfDate(events, clen.datumZapisu, {
      type: "akcionar-vznik",
      title: `${name} se stal společníkem`,
      refIco: clen.pravnickaOsoba?.ico,
    });
    pushIfDate(events, clen.datumVymazu, {
      type: "akcionar-zanik",
      title: `${name} přestal být společníkem`,
      refIco: clen.pravnickaOsoba?.ico,
    });
  }
  // Základní kapitál
  if (zaznam.zakladniKapital) {
    const k = zaznam.zakladniKapital;
    const formatted = k.hodnota != null
      ? `${k.hodnota.toLocaleString("cs-CZ")} ${k.mena ?? "Kč"}`
      : "(neznámá výše)";
    pushIfDate(events, k.datumZapisu, {
      type: "kapital",
      title: `Základní kapitál: ${formatted}`,
    });
    pushIfDate(events, k.datumVymazu, {
      type: "kapital-konec",
      title: `Konec kapitálu: ${formatted}`,
    });
  }
}

export interface TimelineResult {
  ico: string;
  obchodniJmeno: string | null;
  events: TimelineEvent[];
  eventCount: number;
  /** Pole let pro UI bucket grouping. Sorted descending. */
  years: number[];
}

export async function buildTimeline(
  client: AresClient,
  icoInput: string,
): Promise<TimelineResult> {
  const { valid, normalized, reason } = validateIcoFn(icoInput);
  if (!valid || !normalized) throw new InvalidInputError(`Invalid IČO: ${icoInput}`, { reason });

  const [subjectRes, vrRes] = await Promise.allSettled([
    client.getEconomicSubject(normalized),
    client.getVrRecord(normalized),
  ]);
  if (subjectRes.status === "rejected") throw subjectRes.reason;
  const subject: EkonomickySubjekt = subjectRes.value;
  const vr: VrOdpoved | null = vrRes.status === "fulfilled" ? vrRes.value : null;

  const events: TimelineEvent[] = [];

  // Vznik / zánik z subject
  pushIfDate(events, subject.datumVzniku, {
    type: "vznik",
    title: "Vznik firmy",
    detail: subject.obchodniJmeno ?? "",
  });
  pushIfDate(events, subject.datumZaniku, {
    type: "zanik",
    title: "Zánik firmy",
    detail: subject.obchodniJmeno ?? "",
  });

  // VR records — kompletní historie statutářů, akcionářů, kapitálu, názvu
  if (vr) {
    for (const zaznam of vr.zaznamy ?? []) processZaznam(events, zaznam);
  }

  // Dedup — některé akce mohou být v primárním + sekundárním zaznamu duplicitně
  const seen = new Set<string>();
  const dedup = events.filter((e) => {
    const sig = `${e.date}|${e.type}|${e.title}|${e.detail ?? ""}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });

  // Sort descending (newest first)
  dedup.sort((a, b) => b.date.localeCompare(a.date));

  const years = [...new Set(dedup.map((e) => Number(e.date.slice(0, 4))))].sort((a, b) => b - a);

  return {
    ico: normalized,
    obchodniJmeno: subject.obchodniJmeno ?? null,
    events: dedup,
    eventCount: dedup.length,
    years,
  };
}
