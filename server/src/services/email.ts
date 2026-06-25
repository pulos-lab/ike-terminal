import { Resend } from 'resend';
import { config } from '../config.js';

/**
 * Współdzielony mailer (Resend) dla powiadomień transakcyjnych poza ścieżką auth.
 * better-auth ma własny klient do OTP (auth.ts) — tu NIE ruszamy ścieżki logowania.
 * Bez RESEND_API_KEY (dev) wysyłka jest logowana do konsoli, nie wykonywana —
 * spójnie z zachowaniem OTP w dev.
 */
const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

/** Wyślij e-mail (prod) lub zaloguj zamiar (dev/bez klucza). Rzuca przy błędzie API. */
export async function sendEmail({ to, subject, html }: SendEmailInput): Promise<void> {
  if (!resend) {
    console.log(`[DEV] e-mail do ${to}: ${subject}`);
    return;
  }
  await resend.emails.send({ from: config.emailFrom, to, subject, html });
}

/** Escape treści od użytkownika przed wstawieniem do HTML maila (anty-wstrzyknięcie). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
