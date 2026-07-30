/**
 * Kalendarz wyników spółek amerykańskich z api.nasdaq.com.
 *
 * Dlaczego Nasdaq, a nie SEC: EDGAR rejestruje wyłącznie ZŁOŻONE dokumenty — nie ma
 * w nim przyszłych terminów, a zapowiedź daty składa przez 8-K promil emitentów
 * (reszta ogłasza ją press-releasem IR, poza SEC). Nasdaq dodatkowo podaje porę sesji,
 * czego Yahoo nie robi.
 *
 * Endpoint jest per DATA, nie per ticker, więc terminarz budujemy zamiatając okno dni
 * w przód i indeksując wynik po symbolu. Wymaga przeglądarkowego User-Agenta.
 */
import type { SourceGuard } from '../source-guard.js';
import { detectEarningsSourceBlock } from './earnings-guards.js';
import type { EarningsRow } from './earnings-store.js';
import type { EarningsSession, EarningsConfidence } from 'shared';

const NASDAQ_URL = 'https://api.nasdaq.com/api/calendar/earnings';
const FETCH_TIMEOUT_MS = 15_000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const MONTH_TO_NUMBER: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

/**
 * Pora publikacji → pewność terminu.
 * Podana pora oznacza, że spółka ogłosiła termin (Nasdaq zna godzinę z jej komunikatu);
 * `time-not-supplied` to wpis kalendarzowy bez potwierdzenia — stąd `tentative`.
 */
export function mapNasdaqTime(time: unknown): {
  session: EarningsSession;
  confidence: EarningsConfidence;
} {
  switch (typeof time === 'string' ? time.trim() : '') {
    case 'time-pre-market':
      return { session: 'bmo', confidence: 'confirmed' };
    case 'time-after-hours':
      return { session: 'amc', confidence: 'confirmed' };
    default:
      return { session: 'unknown', confidence: 'tentative' };
  }
}

/** „$6.71" → 6.71; „($0.12)" → −0.12 (zapis księgowy); „" / „N/A" → null. */
export function parseNasdaqEps(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text || text.toUpperCase() === 'N/A') return null;
  const negative = text.startsWith('(') && text.endsWith(')');
  const value = parseFloat(text.replace(/[()$,\s]/g, ''));
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/**
 * „Jun/2026" → „Q2 26"; nierozpoznane → surowa wartość lub null.
 *
 * Nasdaq podaje MIESIĄC KOŃCA kwartału fiskalnego, nie jego numer, więc numerujemy
 * po kwartale KALENDARZOWYM. Dla spółki z przesuniętym rokiem obrotowym etykieta
 * może się różnić od jej własnej numeracji (Apple kończy rok we wrześniu, więc jego
 * „fiscal Q3" to nasze Q2) — ale okres, którego dotyczy raport, jest ten sam.
 */
export function formatFiscalLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  const match = text.match(/^([A-Za-z]{3})\/(\d{4})$/);
  if (!match) return text;
  const month = MONTH_TO_NUMBER[match[1].toLowerCase()];
  if (!month) return text;
  const quarter = Math.ceil(Number.parseInt(month, 10) / 3);
  return `Q${quarter} ${match[2].slice(2)}`;
}

interface NasdaqRow {
  time?: unknown;
  symbol?: unknown;
  fiscalQuarterEnding?: unknown;
  epsForecast?: unknown;
}

/**
 * Czysty parser odpowiedzi dla JEDNEGO dnia.
 * `data.rows === null` to normalna odpowiedź dla weekendu/święta — nie błąd.
 */
export function parseNasdaqEarningsDay(json: unknown, date: string): EarningsRow[] {
  const rows = (json as { data?: { rows?: unknown } } | null)?.data?.rows;
  if (!Array.isArray(rows)) return [];

  const out: EarningsRow[] = [];
  const seen = new Set<string>();
  for (const raw of rows as NasdaqRow[]) {
    const symbol = typeof raw?.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);

    const { session, confidence } = mapNasdaqTime(raw.time);
    out.push({
      market: 'US',
      symbolKey: symbol,
      reportDate: date,
      confidence,
      session,
      fiscalLabel: formatFiscalLabel(raw.fiscalQuarterEnding),
      reportKind: 'quarterly',
      source: 'nasdaq',
      epsForecast: parseNasdaqEps(raw.epsForecast),
    });
  }
  return out;
}

export interface FetchNasdaqOptions {
  fetchFn?: typeof fetch;
  guard?: SourceGuard;
  /** Przerwa między dniami — Nasdaq nie ma publicznego limitu, więc zachowujemy grzeczność. */
  politenessDelayMs?: number;
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Zamiata okno dat sekwencyjnie. Zwraca wiersze ze WSZYSTKICH udanych dni oraz
 * informację, czy zamiatanie było kompletne — niekompletnego nie wolno użyć do
 * podmiany terminarza, bo skasowałoby terminy z dni, których nie udało się pobrać.
 */
export async function fetchNasdaqWindow(
  dates: string[],
  options: FetchNasdaqOptions = {},
): Promise<{ rows: EarningsRow[]; complete: boolean; fetchedDays: number }> {
  const fetchFn = options.fetchFn ?? fetch;
  const guard = options.guard;
  const politenessDelayMs = options.politenessDelayMs ?? 300;

  const rows: EarningsRow[] = [];
  let failures = 0;
  let fetchedDays = 0;

  for (const [index, date] of dates.entries()) {
    if (guard?.isBlocked()) {
      console.warn('[earnings/nasdaq] bezpiecznik otwarty — przerywam zamiatanie');
      failures += dates.length - index;
      break;
    }
    if (index > 0) await sleep(politenessDelayMs);

    try {
      const resp = await fetchFn(`${NASDAQ_URL}?date=${encodeURIComponent(date)}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const text = await resp.text().catch(() => '');
      if (detectEarningsSourceBlock(resp.status, text)) {
        guard?.registerBlock();
        console.warn(`[earnings/nasdaq] blokada anti-bot (HTTP ${resp.status}) dla ${date}`);
        failures += 1;
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const dayRows = parseNasdaqEarningsDay(JSON.parse(text), date);
      rows.push(...dayRows);
      fetchedDays += 1;
    } catch (err) {
      console.warn(`[earnings/nasdaq] nie udało się pobrać ${date}:`, err);
      failures += 1;
    }
  }

  // Parse-miss zgłaszamy raz na całe zamiatanie, nie per dzień: pojedynczy dzień
  // BYWA legalnie pusty (weekend, święto), ale całe okno kilkudziesięciu dni bez
  // ani jednej publikacji oznacza, że zmienił się kształt odpowiedzi.
  if (guard && fetchedDays > 0) {
    if (rows.length === 0) guard.registerParseMiss('calendar:us', { structural: true });
    else guard.registerSuccess('calendar:us');
  }

  return { rows, complete: failures === 0, fetchedDays };
}
