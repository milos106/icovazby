// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Periodicky obíhá verifikované subscriptions, dělá fresh DD, diffuje proti
 * snapshotu a posílá e-mail při významné změně. Interval ALERTS_CHECK_MIN
 * (default 360 = 6h).
 *
 * Pro produkční nasazení by tohle mělo běžet v separátním worker procesu
 * (bullmq + Redis), ale pro single-instance je setInterval OK.
 */

import { AresClient } from "../ares/client.js";
import { fullDueDiligenceService, getAdisVatStatusService } from "../services.js";
import { listVerified, updateSnapshot, type SubscriptionSnapshot } from "./store.js";
import { sendMail } from "./mailer.js";

const BASE_URL = (process.env.PUBLIC_BASE_URL ?? "https://icovazby.cz").replace(/\/$/, "");

function buildSnapshot(
  report: Awaited<ReturnType<typeof fullDueDiligenceService>>,
  adis: { isUnreliable?: boolean | null } | null,
): SubscriptionSnapshot {
  const statutary = (report.statutary?.clenove ?? []) as { jmeno?: string; datumNarozeni?: string }[];
  return {
    obchodniJmeno: report.obchodniJmeno ?? null,
    datumZaniku: report.identification?.datumZaniku ?? null,
    isInsolvent: report.insolvenci?.isInsolvent ?? false,
    statutariKeys: statutary
      .map((m) => `${(m.jmeno ?? "").trim()}|${m.datumNarozeni ?? ""}`)
      .filter((k) => k !== "|")
      .sort(),
    sidloText: report.identification?.sidloText ?? null,
    platceDph: report.vat?.platceDph ?? false,
    // ADIS nedostupné → necháme undefined (diff na to nesáhne, žádný falešný alert)
    nespolehlivyPlatce: adis ? adis.isUnreliable === true : undefined,
  };
}

export function diff(prev: SubscriptionSnapshot, curr: SubscriptionSnapshot): string[] {
  const changes: string[] = [];
  if (!prev.isInsolvent && curr.isInsolvent) {
    changes.push("⚠ Bylo zahájeno insolvenční řízení.");
  }
  if (!prev.datumZaniku && curr.datumZaniku) {
    changes.push(`⚠ Subjekt zanikl (${curr.datumZaniku}).`);
  }
  const prevSet = new Set(prev.statutariKeys);
  const currSet = new Set(curr.statutariKeys);
  const removed = [...prevSet].filter((k) => !currSet.has(k));
  const added = [...currSet].filter((k) => !prevSet.has(k));
  for (const k of removed) changes.push(`Odešel ze statutáru: ${k.split("|")[0]}`);
  for (const k of added) changes.push(`Nový statutární orgán: ${k.split("|")[0]}`);
  // Změna sídla — jen když známe obě hodnoty (starý snapshot pole nemá → nealertuj).
  if (prev.sidloText && curr.sidloText && prev.sidloText !== curr.sidloText) {
    changes.push(`Změna sídla: „${prev.sidloText}" → „${curr.sidloText}".`);
  }
  // Registrace k DPH — zrušení je signál (obnova méně, ale hlásíme obojí).
  if (prev.platceDph === true && curr.platceDph === false) {
    changes.push("Zrušena registrace k DPH (přestal být plátcem).");
  } else if (prev.platceDph === false && curr.platceDph === true) {
    changes.push("Nová registrace k DPH (stal se plátcem).");
  }
  // Nespolehlivý plátce DPH — přechod na ANO (red flag pro účetní, ručení za DPH).
  if (prev.nespolehlivyPlatce === false && curr.nespolehlivyPlatce === true) {
    changes.push("⚠ Zařazen mezi NESPOLEHLIVÉ plátce DPH (ADIS) — pozor na ručení za DPH.");
  } else if (prev.nespolehlivyPlatce === true && curr.nespolehlivyPlatce === false) {
    changes.push("Vyřazen ze seznamu nespolehlivých plátců DPH.");
  }
  return changes;
}

export async function runCheck(client: AresClient): Promise<{ checked: number; alerts: number }> {
  const subs = await listVerified();
  let alertCount = 0;
  for (const sub of subs) {
    try {
      const report = await fullDueDiligenceService(client, sub.ico);
      // Robustnost: pokud je DD degradované (ARES/Hlídač při téhle kontrole selhal),
      // PŘESKOČ — neaktualizuj snapshot ani neposílej alert. Jinak hrozí FALEŠNÝ
      // poplach (např. „insolvence zahájena" / „statutár odešel", když se data jen
      // dočasně ztratila). Necháme starý snapshot a počkáme na příští běh.
      const reliable =
        !!report.obchodniJmeno &&
        (report.insolvenci as { available?: boolean } | undefined)?.available !== false;
      if (!reliable) {
        console.warn(`[alerts] přeskočeno (degradovaná data) pro ${sub.ico}`);
        continue;
      }
      // ADIS nespolehlivý plátce (1 SOAP, cache 1h) — best-effort, výpadek nevadí.
      const adis = await getAdisVatStatusService(sub.ico).catch(() => null);
      const snapshot = buildSnapshot(report, adis);
      if (sub.snapshot) {
        const changes = diff(sub.snapshot, snapshot);
        if (changes.length > 0) {
          alertCount++;
          await sendMail({
            to: sub.email,
            subject: `IČO vazby: změna u ${snapshot.obchodniJmeno ?? sub.ico}`,
            text: [
              `Detekovali jsme změnu u firmy ${snapshot.obchodniJmeno ?? "(neznámá)"} (IČO ${sub.ico}):`,
              "",
              ...changes.map((c) => "  • " + c),
              "",
              `Detail: ${BASE_URL}/?ico=${sub.ico}`,
              "",
              `Pro odhlášení: ${BASE_URL}/api/alerts/unsubscribe/${sub.id}`,
            ].join("\n"),
          });
        }
      }
      await updateSnapshot(sub.id, snapshot);
    } catch (e) {
      console.error(`[alerts] check failed for ${sub.ico}`, (e as Error).message);
    }
  }
  return { checked: subs.length, alerts: alertCount };
}

let timer: NodeJS.Timeout | null = null;

function tick(client: AresClient): void {
  runCheck(client)
    .then((r) => console.log(`[alerts] kontrola dokončena: zkontrolováno=${r.checked}, odeslaných alertů=${r.alerts}`))
    .catch((e) => console.error("[alerts] runCheck error", e));
}

export function startScheduler(client: AresClient): void {
  if (timer) return;
  const minutes = Number(process.env.ALERTS_CHECK_MIN ?? 360);
  // První běh za 1 minutu po startu, pak periodicky.
  setTimeout(() => tick(client), 60_000);
  timer = setInterval(() => tick(client), minutes * 60_000);
}
