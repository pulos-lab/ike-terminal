/**
 * Wiązanie produkcyjne source-guard dla biznesradar.pl — JEDNA instancja
 * współdzielona przez wszystkich konsumentów źródła (ceny live + historia
 * w biznesradar.ts, katalog tickerów w biznesradar-catalog.ts, kalendarz
 * dywidend w gpw-dividend-calendar.ts): jedna prawda o odcięciu, wspólny
 * dedup powiadomień, jeden stan w /api/health.
 *
 * Moduł jest celowo LEKKI (bez price-cache/history-cache), żeby katalog
 * i kalendarz mogły importować detekcję blokady bez ciągnięcia zależności
 * ścieżki cen.
 */

import path from 'path';
import { config } from '../config.js';
import {
  createSourceGuard,
  createSqliteGuardStore,
  type SourceGuard,
  type SourceGuardAlert,
} from './source-guard.js';

/**
 * Czy odpowiedź to blokada/anti-bot (a NIE zwykły brak spółki)?
 * 429/403 lub markery challenge (captcha, Cloudflare „Just a moment", access denied).
 * Strona 404 „nie istnieje" NIE jest blokadą — to po prostu nieznany ticker.
 */
export function detectBiznesradarBlock(status: number, html: string): boolean {
  if (status === 429 || status === 403 || status === 503) return true;
  const h = html.toLowerCase();
  return (
    h.includes('captcha') ||
    h.includes('just a moment') ||
    h.includes('cf-browser-verification') ||
    h.includes('attention required') ||
    h.includes('access denied') ||
    h.includes('zbyt wiele') // "zbyt wiele zapytań"
  );
}

/**
 * Powiadomienie admina przez DYNAMICZNY import — statyczny import
 * admin-notifications pociągnąłby auth.js, który inicjalizuje better-auth
 * (i auth.db) już przy imporcie modułu; wywalałby każdy test importujący
 * biznesradar.ts. Ładujemy dopiero przy pierwszym realnym alercie.
 */
async function notifyAdmin(alert: SourceGuardAlert): Promise<void> {
  const { notifySourceGuardAlert } = await import('./admin-notifications.js');
  await notifySourceGuardAlert(alert);
}

let defaultGuard: SourceGuard | null = null;
let testOverride: SourceGuard | null = null;

/** Wspólny guard biznesradar (lazy singleton; persystencja w price_history.db). */
export function getBiznesradarGuard(): SourceGuard {
  if (testOverride) return testOverride;
  if (!defaultGuard) {
    defaultGuard = createSourceGuard({
      name: 'biznesradar',
      store: createSqliteGuardStore('biznesradar', path.join(config.dataDir, 'price_history.db')),
      notify: notifyAdmin,
    });
  }
  return defaultGuard;
}

/** Testy podmieniają na świeżą instancję (memory store + spy); null przywraca default. */
export function setBiznesradarGuardForTests(guard: SourceGuard | null): void {
  testOverride = guard;
}
