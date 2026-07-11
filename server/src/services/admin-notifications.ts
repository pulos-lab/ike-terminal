import { getAuthDb } from '../auth.js';
import { config, isProduction } from '../config.js';
import type { ImportProfileRow } from '../db/import-profiles-repo.js';
import { escapeHtml, sendEmail } from './email.js';

/**
 * Powiadomienia mailowe dla admina: nowy profil importu „nieznanego" brokera do
 * kuracji oraz nowe zgłoszenie błędu. Fire-and-forget — funkcje NIGDY nie rzucają
 * (błąd jest tylko logowany), żeby nie wpływać na ścieżkę żądania/importu.
 *
 * Odbiorca = admin (pierwszy zarejestrowany użytkownik — ta sama konwencja co
 * require-admin). Akcje SAMEGO admina są pomijane (nie powiadamiamy go o sobie).
 * Wyłącznik: ADMIN_NOTIFICATIONS=off. Transport reużywa Resend (services/email.ts);
 * bez RESEND_API_KEY w dev zamiar wysyłki trafia do konsoli.
 */

/** Czy powiadomienia są włączone (mirror isLlmEnabled — flaga; dev-log gdy brak klucza). */
export function isAdminNotificationsEnabled(): boolean {
  return (process.env.ADMIN_NOTIFICATIONS ?? '').toLowerCase() !== 'off';
}

interface AdminRecipient {
  id: string;
  email: string;
}

/** Admin = pierwszy user w auth.db (id + email). null gdy brak użytkowników/emaila. */
function getAdminRecipient(): AdminRecipient | null {
  const row = getAuthDb()
    .prepare('SELECT id, email FROM "user" ORDER BY createdAt ASC LIMIT 1')
    .get() as { id: string; email: string } | undefined;
  return row && row.email ? { id: row.id, email: row.email } : null;
}

/** E-mail użytkownika po id (kto wgrał plik) — best-effort. */
function getUserEmailById(userId: string | null | undefined): string | null {
  if (!userId) return null;
  const row = getAuthDb().prepare('SELECT email FROM "user" WHERE id = ?').get(userId) as
    | { email: string }
    | undefined;
  return row?.email ?? null;
}

/** Bazowy URL aplikacji do linków w mailu. */
function appBaseUrl(): string {
  return isProduction ? config.corsOrigin : `http://localhost:${config.port}`;
}

/** Wspólny szablon HTML (spójny z mailem OTP). */
function emailShell(title: string, bodyHtml: string, linkPath: string, linkLabel: string): string {
  const url = `${appBaseUrl()}${linkPath}`;
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
      <h2 style="color: #16a34a; margin: 0 0 16px;">TIX Terminal</h2>
      <p style="color: #111; font-weight: 600; margin: 0 0 12px;">${title}</p>
      <div style="color: #333; font-size: 14px; line-height: 1.6;">${bodyHtml}</div>
      <p style="margin: 24px 0 0;"><a href="${url}" style="color: #16a34a;">${linkLabel}</a></p>
    </div>`;
}

/**
 * Powiadom admina o nowym profilu importu do kuracji (AI lub ręczne mapowanie).
 * Pomija edycje admina (generatedBy='admin') i akcje samego admina. Nigdy nie rzuca.
 */
export async function notifyNewImportProfile(row: ImportProfileRow): Promise<void> {
  try {
    if (!isAdminNotificationsEnabled()) return;
    if (row.generatedBy === 'admin') return; // edycja admina — nie powiadamiamy
    const admin = getAdminRecipient();
    if (!admin) return;
    if (row.createdByUserId && row.createdByUserId === admin.id) return; // skip-own

    const broker = row.brokerLabel?.trim() || `format ${row.fingerprint.slice(0, 8)}`;
    const source = row.generatedBy === 'llm' ? 'AI (wygenerowane)' : 'ręczne mapowanie';
    const uploader = getUserEmailById(row.createdByUserId);
    const body = `
      <p style="margin:0 0 8px;">Nowy profil importu czeka na przegląd:</p>
      <ul style="margin:0; padding-left:18px;">
        <li>Broker: <b>${escapeHtml(broker)}</b></li>
        <li>Źródło mapowania: ${source}</li>
        <li>Wersja: v${row.version}</li>
        ${uploader ? `<li>Wgrał: ${escapeHtml(uploader)}</li>` : ''}
      </ul>`;
    await sendEmail({
      to: admin.email,
      subject: `Nowy profil importu do przeglądu: ${broker}`,
      html: emailShell(
        'Nowy profil importu',
        body,
        '/app/admin/import-profiles',
        'Przejdź do kuracji profili',
      ),
    });
  } catch (err) {
    console.error('[admin-notifications] notifyNewImportProfile failed:', err);
  }
}

export interface UnknownTypeReportNotification {
  broker: string;
  rawType: string;
  kind: 'classified' | 'unsupported';
  reporterUserId: string;
}

/**
 * Powiadom admina o NOWYM agregacie zgłoszenia nieznanego typu operacji
 * (skrzynka "Do wyjaśnienia"). Wołane tylko gdy upsert utworzył wiersz —
 * kolejne zgłoszenia tego samego (broker, typ) inkrementują licznik bez maila.
 */
export async function notifyNewUnknownTypeReport(
  report: UnknownTypeReportNotification,
): Promise<void> {
  try {
    if (!isAdminNotificationsEnabled()) return;
    const admin = getAdminRecipient();
    if (!admin) return;
    if (report.reporterUserId === admin.id) return; // skip-own

    const isGap = report.kind === 'unsupported';
    const reporter = getUserEmailById(report.reporterUserId);
    const body = `
      <p style="margin:0 0 8px;">${
        isGap
          ? 'Użytkownik zgłosił wiersz importu, którego aplikacja prawdopodobnie nie obsługuje:'
          : 'Użytkownik sklasyfikował nierozpoznany typ operacji — kandydat na alias/obsługę w parserze:'
      }</p>
      <ul style="margin:0; padding-left:18px;">
        <li>Broker: <b>${escapeHtml(report.broker)}</b></li>
        <li>Typ operacji: <b>${escapeHtml(report.rawType)}</b></li>
        ${reporter ? `<li>Zgłosił: ${escapeHtml(reporter)}</li>` : ''}
      </ul>`;
    await sendEmail({
      to: admin.email,
      subject: isGap
        ? `Nieobsługiwana funkcjonalność: ${report.broker} / „${report.rawType}"`
        : `Nieznany typ operacji: ${report.broker} / „${report.rawType}"`,
      html: emailShell(
        isGap ? 'Zgłoszenie nieobsługiwanej funkcjonalności' : 'Nieznany typ operacji',
        body,
        '/app/admin/type-aliases',
        'Otwórz panel typów operacji',
      ),
    });
  } catch (err) {
    console.error('[admin-notifications] notifyNewUnknownTypeReport failed:', err);
  }
}

export interface BugReportNotification {
  category: string;
  description: string;
  reporterEmail: string | null;
  reporterUserId: string;
}

/** Powiadom admina o nowym zgłoszeniu błędu. Pomija własne zgłoszenia admina. Nigdy nie rzuca. */
export async function notifyNewBugReport(report: BugReportNotification): Promise<void> {
  try {
    if (!isAdminNotificationsEnabled()) return;
    const admin = getAdminRecipient();
    if (!admin) return;
    if (report.reporterUserId === admin.id) return; // skip-own

    const body = `
      <p style="margin:0 0 8px;">Nowe zgłoszenie błędu:</p>
      <ul style="margin:0 0 8px; padding-left:18px;">
        <li>Kategoria: <b>${escapeHtml(report.category)}</b></li>
        ${report.reporterEmail ? `<li>Zgłaszający: ${escapeHtml(report.reporterEmail)}</li>` : ''}
      </ul>
      <p style="margin:0; white-space:pre-wrap;">${escapeHtml(report.description)}</p>`;
    await sendEmail({
      to: admin.email,
      subject: `Nowe zgłoszenie błędu: ${report.category}`,
      html: emailShell('Zgłoszenie błędu', body, '/app/admin/bugs', 'Otwórz panel zgłoszeń'),
    });
  } catch (err) {
    console.error('[admin-notifications] notifyNewBugReport failed:', err);
  }
}
