/**
 * Wiązanie produkcyjne source-guard dla Yahoo Finance + globalny limiter
 * równoległości.
 *
 * Yahoo było jedynym źródłem bez jakichkolwiek zabezpieczeń: `yahooChart` rzucał
 * gołe `Error` przy każdym nie-2xx, a `fetchYahooPrice` łykał wyjątek i zwracał
 * `null` — 429 było nieodróżnialne od 404, a odcięcie objawiało się cichym
 * spadkiem wszystkich pozycji na cenę z ostatniej transakcji. Dokładnie tak
 * umarł Stooq, zanim dostał guard.
 *
 * Jedna instancja na proces obejmuje WSZYSTKIE ścieżki Yahoo (ceny live, batch
 * quotes, historia, dywidendy, splity, resolver ISIN, benchmark) — bo limit
 * nakłada Yahoo per IP, nie per funkcja.
 *
 * Backoff 15 min (krótszy niż 30 min biznesradaru): Yahoo jest źródłem dla
 * wszystkiego zagranicznego, więc dłuższa cisza kosztuje więcej niż ostrożność
 * przy scraperze GPW.
 */

import path from 'path';
import { config } from '../config.js';
import { createConcurrencyLimiter } from './concurrency.js';
import {
  createSourceGuard,
  createSqliteGuardStore,
  type SourceGuard,
  type SourceGuardAlert,
} from './source-guard.js';

/** Cisza po odcięciu — krótsza niż default 30 min (patrz nagłówek modułu). */
const YAHOO_BLOCK_BACKOFF_MS = 15 * 60 * 1000;

/**
 * Ile równoległych połączeń do Yahoo naraz.
 *
 * 4 to kompromis: pętla wyceny i tak jest sekwencyjna (batch ją omija), a
 * równoległe fetche historii w `computePortfolioHistory` szły dotąd BEZ limitu —
 * portfel z 40 tickerami otwierał 40 połączeń naraz, co jest najprostszym
 * sposobem na wylądowanie w rate-limicie.
 */
const YAHOO_MAX_CONCURRENT = 4;

/**
 * Czy odpowiedź to odcięcie (a NIE zwykły brak symbolu)?
 *
 * 429 = jawny rate limit; 999 = klasyczny kod Yahoo dla „za dużo ruchu";
 * 503 = przeciążenie. 404 NIE jest blokadą — to nieznany ticker (delisted,
 * literówka w mapie), zdarza się na produkcji stale.
 *
 * 401/403 świadomie NIE są tu ujęte: na ścieżkach z crumbem oznaczają wygasłą
 * parę cookie+crumb i mają własną obsługę (invalidate + jeden retry). Blokadę
 * rejestruje dopiero powtórka — inaczej rutynowa rotacja crumba co 6 h
 * otwierałaby bezpiecznik.
 */
export function detectYahooBlock(status: number, body: string): boolean {
  if (status === 429 || status === 999 || status === 503) return true;
  const b = body.toLowerCase();
  return (
    b.includes('too many requests') ||
    b.includes('rate limit') ||
    b.includes('will be right back') ||
    b.includes('unusual traffic')
  );
}

/**
 * Powiadomienie admina przez DYNAMICZNY import — statyczny import
 * admin-notifications pociągnąłby auth.js (inicjalizuje better-auth i auth.db
 * już przy imporcie modułu) i wywaliłby każdy test importujący yahoo-finance.
 */
async function notifyAdmin(alert: SourceGuardAlert): Promise<void> {
  const { notifySourceGuardAlert } = await import('./admin-notifications.js');
  await notifySourceGuardAlert(alert);
}

let defaultGuard: SourceGuard | null = null;
let testOverride: SourceGuard | null = null;

/** Wspólny guard Yahoo (lazy singleton; persystencja w price_history.db). */
export function getYahooGuard(): SourceGuard {
  if (testOverride) return testOverride;
  if (!defaultGuard) {
    defaultGuard = createSourceGuard({
      name: 'yahoo',
      store: createSqliteGuardStore('yahoo', path.join(config.dataDir, 'price_history.db')),
      notify: notifyAdmin,
      blockBackoffMs: YAHOO_BLOCK_BACKOFF_MS,
    });
  }
  return defaultGuard;
}

/** Testy podmieniają na świeżą instancję (memory store + spy); null przywraca default. */
export function setYahooGuardForTests(guard: SourceGuard | null): void {
  testOverride = guard;
}

/**
 * Globalny limiter równoległości Yahoo — opakowuje KAŻDY fetch do Yahoo.
 * Kolejkuje (nie odrzuca), więc na produkcji multi-tenant prime dużego portfela
 * spowalnia siebie, a nie wywala requestów innych najemców.
 */
export const withYahooLimit = createConcurrencyLimiter(YAHOO_MAX_CONCURRENT);
