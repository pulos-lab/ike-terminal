import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const testCache = new Map<string, unknown>();
vi.mock('../price-cache.js', () => ({
  getCached: (key: string) => testCache.get(key),
  setCached: (key: string, value: unknown) => {
    testCache.set(key, value);
  },
}));

// Historia w pamięci (realna to SQLite price_history.db) — upsert po dacie.
const persisted = new Map<string, Map<string, number>>();
const rowsOf = (ticker: string) =>
  [...(persisted.get(ticker) ?? new Map<string, number>()).entries()]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date));
vi.mock('../history-cache.js', () => ({
  storeHistoricalPrices: (ticker: string, rows: Array<{ date: string; close: number }>) => {
    const m = persisted.get(ticker) ?? new Map<string, number>();
    for (const r of rows) m.set(r.date, r.close);
    persisted.set(ticker, m);
  },
  loadHistoricalPrices: (ticker: string, start?: string) =>
    rowsOf(ticker).filter((r) => !start || r.date >= start),
  getLastCachedDate: (ticker: string) => rowsOf(ticker).at(-1)?.date ?? null,
  getFirstCachedDate: (ticker: string) => rowsOf(ticker)[0]?.date ?? null,
  invalidateCachedPrices: () => {},
}));

vi.mock('../yahoo-auth.js', () => ({
  getYahooAuth: vi.fn(async () => ({ crumb: 'C', cookies: 'A=1' })),
  invalidateYahooAuth: vi.fn(),
}));

import { fetchYahooHistory } from '../yahoo-finance.js';
import { setYahooGuardForTests } from '../yahoo-guard.js';
import { setLiveQuoteStoreForTests } from '../live-quote-store.js';
import { createSourceGuard, createMemoryGuardStore } from '../source-guard.js';
import { resetHistoryTailChecks } from '../history-tail-freshness.js';

const TICKER = 'CDR.WA';

/** Dni robocze od `from` do `to` włącznie (YYYY-MM-DD). */
function weekdays(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().split('T')[0]);
  }
  return out;
}

const START = '2026-10-26';

/** Zasiej cache sesjami od START do `lastDate` (≥ 11 punktów — próg „cache używalny"). */
function seedCacheThrough(lastDate: string): void {
  const m = new Map<string, number>();
  for (const date of weekdays(START, lastDate)) m.set(date, 100);
  persisted.set(TICKER, m);
}

/**
 * Yahoo, które „zna" sesje do `marketThrough` włącznie; ostatnia może być
 * częściowym słupkiem dnia bieżącego — odfiltrowanie go to zadanie kodu.
 */
function stubYahoo(marketThrough: string) {
  const dates = weekdays(START, marketThrough);
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      chart: {
        result: [
          {
            timestamp: dates.map((d) => Math.floor(new Date(`${d}T08:00:00Z`).getTime() / 1000)),
            indicators: { quote: [{ close: dates.map(() => 101) }] },
          },
        ],
      },
    }),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  // Tylko Date — limiter Yahoo używa prawdziwych timerów.
  vi.useFakeTimers({ toFake: ['Date'] });
  testCache.clear();
  persisted.clear();
  resetHistoryTailChecks();
  setYahooGuardForTests(createSourceGuard({ name: 'yahoo-test', store: createMemoryGuardStore() }));
  setLiveQuoteStoreForTests({ upsert: () => {}, get: () => null, getMany: () => new Map() });
});

afterEach(() => {
  vi.useRealTimers();
  setYahooGuardForTests(null);
  setLiveQuoteStoreForTests(null);
  vi.unstubAllGlobals();
});

describe('fetchYahooHistory — świeżość ogona serii', () => {
  it('REGRESJA: cache do poniedziałku, środa → dociąga wtorkowe zamknięcie (stary próg ≤3 dni je pomijał)', async () => {
    seedCacheThrough('2026-11-16'); // poniedziałek
    vi.setSystemTime(new Date('2026-11-18T10:00:00Z')); // środa, sesja trwa
    const fetchMock = stubYahoo('2026-11-18'); // Yahoo dokłada częściowy słupek środy

    const data = await fetchYahooHistory(TICKER, START);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data.at(-1)).toEqual({ date: '2026-11-17', close: 101 });
    expect(data.map((d) => d.date)).not.toContain('2026-11-18');
  });

  it('po dociągnięciu wczorajszej sesji kolejne żądania tego dnia nie ruszają sieci', async () => {
    seedCacheThrough('2026-11-16');
    vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
    const fetchMock = stubYahoo('2026-11-18');

    await fetchYahooHistory(TICKER, START);
    testCache.clear(); // inny klucz cache pamięciowego (np. inny portfel)
    await fetchYahooHistory(TICKER, START);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cache do piątku: sobota, niedziela i poniedziałek bez ruchu sieciowego', async () => {
    seedCacheThrough('2026-11-20'); // piątek
    const fetchMock = stubYahoo('2026-11-20');

    for (const now of ['2026-11-21T09:00:00Z', '2026-11-22T09:00:00Z', '2026-11-23T09:00:00Z']) {
      vi.setSystemTime(new Date(now));
      testCache.clear();
      await fetchYahooHistory(TICKER, START);
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('święto: źródło odpowiada bez nowej sesji → jedno sprawdzenie na 6 h, nie przy każdym żądaniu', async () => {
    seedCacheThrough('2026-11-10'); // wtorek; środa 11.11 bez sesji
    const fetchMock = stubYahoo('2026-11-10');

    vi.setSystemTime(new Date('2026-11-12T08:00:00Z')); // czwartek rano
    await fetchYahooHistory(TICKER, START);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-12T09:00:00Z'));
    testCache.clear();
    await fetchYahooHistory(TICKER, START);
    expect(fetchMock).toHaveBeenCalledTimes(1); // w oknie — bez sieci

    vi.setSystemTime(new Date('2026-11-12T14:00:01Z'));
    testCache.clear();
    await fetchYahooHistory(TICKER, START);
    expect(fetchMock).toHaveBeenCalledTimes(2); // okno minęło — pytamy ponownie
  });

  it('błąd źródła NIE liczy się jako sprawdzenie — następne żądanie ponawia', async () => {
    seedCacheThrough('2026-11-16');
    vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'Internal Server Error',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await fetchYahooHistory(TICKER, START);
    const second = await fetchYahooHistory(TICKER, START);

    expect(first.at(-1)?.date).toBe('2026-11-16'); // oddaje to, co w cache
    expect(second.at(-1)?.date).toBe('2026-11-16');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});
