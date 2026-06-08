// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SMTP odesílač přes nodemailer. Konfigurace přes env:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *
 * Bez konfigurace mailer jen loguje do konzole (vhodné pro dev a první
 * release — uživatel pak doplní credentials až bude opravdu odesílat).
 */

import nodemailer, { type Transporter } from "nodemailer";

let cached: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (cached) return cached;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  cached = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user, pass },
  });
  return cached;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const t = getTransporter();
  const from = process.env.SMTP_FROM ?? "noreply@icovazby.local";
  if (!t) {
    console.warn(
      `[mailer] SMTP nenakonfigurován (chybí SMTP_HOST/USER/PASS). E-mail by šel komu/co/kdy: ${opts.to} / ${opts.subject}`,
    );
    return { sent: false, reason: "smtp-not-configured" };
  }
  try {
    await t.sendMail({ from, to: opts.to, subject: opts.subject, text: opts.text, html: opts.html });
    return { sent: true };
  } catch (e) {
    console.error("[mailer] send error", e);
    return { sent: false, reason: (e as Error).message };
  }
}
