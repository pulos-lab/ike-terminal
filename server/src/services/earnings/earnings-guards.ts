/**
 * Wiązania produkcyjne source-guard dla źródeł terminarza wyników.
 *
 * Osobne instancje per źródło (Nasdaq ≠ bankier): odcięcie jednego nie może
 * uciszać drugiego, a stan każdego widać osobno w /api/health. Wzorzec i powody
 * dynamicznego importu powiadomień — patrz `biznesradar-guard.ts`.
 */
import path from 'path';
import { config } from '../../config.js';
import {
  createSourceGuard,
  createSqliteGuardStore,
  type SourceGuard,
  type SourceGuardAlert,
} from '../source-guard.js';

/**
 * Blokada anti-bot vs. zwykły brak danych.
 * Nasdaq przy odcięciu oddaje 403/429; bankier stoi za CDN-em, który przy
 * podejrzeniu bota serwuje challenge Cloudflare/Imperva w treści odpowiedzi.
 * 404 NIE jest blokadą — to nieznany slug spółki.
 */
export function detectEarningsSourceBlock(status: number, body: string): boolean {
  if (status === 429 || status === 403 || status === 503) return true;
  const b = body.toLowerCase();
  return (
    b.includes('captcha') ||
    b.includes('just a moment') ||
    b.includes('cf-browser-verification') ||
    b.includes('attention required') ||
    b.includes('access denied') ||
    b.includes('incapsula incident') ||
    b.includes('zbyt wiele')
  );
}

async function notifyAdmin(alert: SourceGuardAlert): Promise<void> {
  const { notifySourceGuardAlert } = await import('../admin-notifications.js');
  await notifySourceGuardAlert(alert);
}

const guards = new Map<string, SourceGuard>();
const overrides = new Map<string, SourceGuard>();

function getGuard(name: string): SourceGuard {
  const override = overrides.get(name);
  if (override) return override;
  let guard = guards.get(name);
  if (!guard) {
    guard = createSourceGuard({
      name,
      store: createSqliteGuardStore(name, path.join(config.dataDir, 'price_history.db')),
      notify: notifyAdmin,
    });
    guards.set(name, guard);
  }
  return guard;
}

export function getNasdaqGuard(): SourceGuard {
  return getGuard('nasdaq');
}

export function getBankierGuard(): SourceGuard {
  return getGuard('bankier');
}

/** Testy podmieniają na instancję z memory store; null przywraca default. */
export function setEarningsGuardForTests(
  name: 'nasdaq' | 'bankier',
  guard: SourceGuard | null,
): void {
  if (guard) overrides.set(name, guard);
  else overrides.delete(name);
}
