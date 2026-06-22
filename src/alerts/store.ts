// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Subscription store pro e-mail alerts. JSON soubor v data/subscriptions.json,
 * dostatečné pro MVP / single-instance. Pro produkční SaaS vyměnit za Postgres.
 *
 * Co alertujeme:
 *  - změna v statutárním orgánu (přidaný / odstraněný jednatel)
 *  - nová insolvence (isInsolvent přešel z false na true)
 *  - zánik subjektu (datumZaniku se objeví)
 *  - změna sídla (textová adresa)
 *  - změna registrace k DPH (zrušení / obnova plátcovství)
 *  - nespolehlivý plátce DPH (přešel na ANO)
 *
 * Snapshot předchozího stavu držíme spolu s subscription — diff oproti
 * aktuální prověrce dělá `checkSubscriptions()`.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const STORE_PATH = process.env.ALERTS_FILE ?? "data/subscriptions.json";

export interface SubscriptionSnapshot {
  obchodniJmeno?: string | null;
  datumZaniku?: string | null;
  isInsolvent?: boolean;
  statutariKeys: string[]; // "jmeno|datumNarozeni" pro každého aktivního
  sidloText?: string | null; // textová adresa sídla — diff = stěhování
  platceDph?: boolean; // aktivní registrace k DPH
  nespolehlivyPlatce?: boolean; // ADIS — nespolehlivý plátce DPH (ANO)
}

export interface Subscription {
  id: string;
  email: string;
  ico: string;
  createdAt: string;
  verifiedAt?: string;
  verificationToken?: string;
  verificationSentAt?: string; // kdy naposled odešel ověřovací e-mail (anti-bombing)
  lastCheckedAt?: string;
  snapshot?: SubscriptionSnapshot;
}

// Anti-abuse: nejvýš N nepotvrzených odběrů na e-mail a re-send až po cooldownu.
const MAX_PENDING_PER_EMAIL = 5;
const RESEND_COOLDOWN_MS = 60 * 60 * 1000; // 1 h
export type SubscribeAction = "send" | "skip" | "blocked";

interface Store {
  version: 1;
  subscriptions: Subscription[];
}

let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const txt = await readFile(STORE_PATH, "utf-8");
    cache = JSON.parse(txt) as Store;
  } catch {
    cache = { version: 1, subscriptions: [] };
  }
  return cache;
}

async function persist(store: Store): Promise<void> {
  await mkdir(dirname(STORE_PATH), { recursive: true }).catch(() => {});
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
  cache = store;
}

/**
 * Vrací subscription + zda se má poslat ověřovací e-mail. Anti-abuse:
 *  - `skip`: už ověřeno, NEBO čeká na potvrzení a ověřovák odešel < cooldown
 *    (brání e-mail bombingu opakovaným POSTem stejné dvojice);
 *  - `blocked`: na e-mail je už příliš mnoho nepotvrzených odběrů
 *    (brání bombingu varírováním IČO na cizí adresu);
 *  - `send`: nový odběr / re-send po cooldownu → pošli ověřovák.
 */
export async function subscribe(email: string, ico: string): Promise<{ sub: Subscription; action: SubscribeAction }> {
  const store = await load();
  const now = Date.now();
  const existing = store.subscriptions.find((s) => s.email === email && s.ico === ico);
  if (existing) {
    if (existing.verifiedAt) return { sub: existing, action: "skip" }; // už aktivní
    const sentAt = existing.verificationSentAt ? Date.parse(existing.verificationSentAt) : 0;
    if (now - sentAt < RESEND_COOLDOWN_MS) return { sub: existing, action: "skip" };
    existing.verificationToken = randomUUID();
    existing.verificationSentAt = new Date().toISOString();
    await persist(store);
    return { sub: existing, action: "send" };
  }
  const pending = store.subscriptions.filter((s) => s.email === email && !s.verifiedAt).length;
  if (pending >= MAX_PENDING_PER_EMAIL) {
    return { sub: { id: "", email, ico, createdAt: new Date().toISOString() }, action: "blocked" };
  }
  const sub: Subscription = {
    id: randomUUID(),
    email,
    ico,
    createdAt: new Date().toISOString(),
    verificationToken: randomUUID(),
    verificationSentAt: new Date().toISOString(),
  };
  store.subscriptions.push(sub);
  await persist(store);
  return { sub, action: "send" };
}

export async function verify(token: string): Promise<Subscription | null> {
  const store = await load();
  const sub = store.subscriptions.find((s) => s.verificationToken === token);
  if (!sub) return null;
  sub.verifiedAt = new Date().toISOString();
  sub.verificationToken = undefined;
  await persist(store);
  return sub;
}

export async function unsubscribe(id: string): Promise<boolean> {
  const store = await load();
  const idx = store.subscriptions.findIndex((s) => s.id === id);
  if (idx < 0) return false;
  store.subscriptions.splice(idx, 1);
  await persist(store);
  return true;
}

export async function listVerified(): Promise<Subscription[]> {
  const store = await load();
  return store.subscriptions.filter((s) => s.verifiedAt);
}

export async function updateSnapshot(id: string, snapshot: SubscriptionSnapshot): Promise<void> {
  const store = await load();
  const sub = store.subscriptions.find((s) => s.id === id);
  if (!sub) return;
  sub.snapshot = snapshot;
  sub.lastCheckedAt = new Date().toISOString();
  await persist(store);
}

export async function listAll(): Promise<Subscription[]> {
  const store = await load();
  return [...store.subscriptions];
}
