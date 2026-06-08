// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * E-mail mailer s dvojím backendem:
 *
 *   1. Resend (preferovaný, pokud RESEND_API_KEY) — moderní transactional
 *      service, jeden API klíč, EU region (Ireland) pro GDPR. Free tier
 *      3000 mailů/měsíc, 100/den.
 *   2. Nodemailer SMTP (fallback) — pro self-hosted SMTP servery nebo
 *      pokud uživatel nechce Resend. Env: SMTP_HOST, SMTP_PORT, SMTP_USER,
 *      SMTP_PASS, SMTP_FROM.
 *   3. Žádná konfigurace → mailer jen loguje do konzole (dev/první spuštění).
 *
 * Resend prefer logic: pokud RESEND_API_KEY existuje, vždy se použije Resend.
 * SMTP fallback nastane jen pokud Resend není nakonfigurovaný.
 */

import nodemailer, { type Transporter } from "nodemailer";
import { Resend } from "resend";

let cachedSmtp: Transporter | null = null;
let cachedResend: Resend | null = null;

function getResend(): Resend | null {
  if (cachedResend) return cachedResend;
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) return null;
  cachedResend = new Resend(key);
  return cachedResend;
}

function getSmtp(): Transporter | null {
  if (cachedSmtp) return cachedSmtp;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  cachedSmtp = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user, pass },
  });
  return cachedSmtp;
}

function defaultFrom(): string {
  return (
    process.env.RESEND_FROM ??
    process.env.SMTP_FROM ??
    "noreply@icovazby.local"
  );
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ sent: boolean; reason?: string; backend?: "resend" | "smtp" }> {
  const from = defaultFrom();

  const resend = getResend();
  if (resend) {
    try {
      const result = await resend.emails.send({
        from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      });
      if (result.error) {
        console.error("[mailer/resend] error", result.error);
        return { sent: false, reason: result.error.message, backend: "resend" };
      }
      return { sent: true, backend: "resend" };
    } catch (e) {
      console.error("[mailer/resend] exception", e);
      return { sent: false, reason: (e as Error).message, backend: "resend" };
    }
  }

  const smtp = getSmtp();
  if (smtp) {
    try {
      await smtp.sendMail({
        from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
      });
      return { sent: true, backend: "smtp" };
    } catch (e) {
      console.error("[mailer/smtp] error", e);
      return { sent: false, reason: (e as Error).message, backend: "smtp" };
    }
  }

  console.warn(
    `[mailer] Ani Resend (RESEND_API_KEY) ani SMTP nenakonfigurováno. ` +
      `E-mail by šel komu/co/kdy: ${opts.to} / ${opts.subject}`,
  );
  return { sent: false, reason: "no-backend-configured" };
}
