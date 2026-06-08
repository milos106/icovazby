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
import { fullDueDiligenceService } from "../services.js";
import { listVerified, updateSnapshot, type SubscriptionSnapshot } from "./store.js";
import { sendMail } from "./mailer.js";

function buildSnapshot(report: Awaited<ReturnType<typeof fullDueDiligenceService>>): SubscriptionSnapshot {
  const statutary = (report.statutary?.clenove ?? []) as { jmeno?: string; datumNarozeni?: string }[];
  return {
    obchodniJmeno: report.obchodniJmeno ?? null,
    datumZaniku: report.identification?.datumZaniku ?? null,
    isInsolvent: report.insolvenci?.isInsolvent ?? false,
    statutariKeys: statutary
      .map((m) => `${(m.jmeno ?? "").trim()}|${m.datumNarozeni ?? ""}`)
      .filter((k) => k !== "|")
      .sort(),
  };
}

function diff(prev: SubscriptionSnapshot, curr: SubscriptionSnapshot): string[] {
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
  return changes;
}

export async function runCheck(client: AresClient): Promise<{ checked: number; alerts: number }> {
  const subs = await listVerified();
  let alertCount = 0;
  for (const sub of subs) {
    try {
      const report = await fullDueDiligenceService(client, sub.ico);
      const snapshot = buildSnapshot(report);
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
              `Detail: https://icovazby.local/?ico=${sub.ico}`,
              "",
              "Pro odhlášení: https://icovazby.local/alerts/unsubscribe/" + sub.id,
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

export function startScheduler(client: AresClient): void {
  if (timer) return;
  const minutes = Number(process.env.ALERTS_CHECK_MIN ?? 360);
  // První běh za 1 minutu po startu, pak periodicky.
  setTimeout(() => {
    runCheck(client).catch((e) => console.error("[alerts] runCheck error", e));
  }, 60_000);
  timer = setInterval(() => {
    runCheck(client).catch((e) => console.error("[alerts] runCheck error", e));
  }, minutes * 60_000);
}
