import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const testCache = new Map<string, unknown>();
vi.mock('../price-cache.js', () => ({
  getCached: (key: string) => testCache.get(key),
  setCached: (key: string, value: unknown) => {
    testCache.set(key, value);
  },
}));

// Historia trzymana w pamięci — bez dotykania price_history.db.
const stored: Array<{ ticker: string; rows: Array<{ date: string; close: number }> }> = [];
const persisted = new Map<string, Array<{ date: string; close: number }>>();
vi.mock('../history-cache.js', () => ({
  storeHistoricalPrices: (
    ticker: string,
    rows: Array<{ date: string; close: number }>,
    _source: string,
  ) => {
    stored.push({ ticker, rows });
    const arr = persisted.get(ticker) ?? [];
    arr.push(...rows);
    persisted.set(ticker, arr);
  },
  loadHistoricalPrices: (ticker: string) => persisted.get(ticker) ?? [],
  getLastCachedDate: (ticker: string) => persisted.get(ticker)?.at(-1)?.date ?? null,
  getFirstCachedDate: (ticker: string) => persisted.get(ticker)?.[0]?.date ?? null,
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

const DAY_MS = 86_400_000;
function iso(d: Date): string {
  return d.toISOString().split('T')[0];
}
/** Sekundy epoch dla południa UTC danego dnia — jak timestampy dzienne Yahoo. */
function ts(d: Date): number {
  return Math.floor(new Date(`${iso(d)}T12:00:00Z`).getTime() / 1000);
}

beforeEach(() => {
  testCache.clear();
  stored.length = 0;
  persisted.clear();
  setYahooGuardForTests(createSourceGuard({ name: 'yahoo-test', store: createMemoryGuardStore() }));
  setLiveQuoteStoreForTests({ upsert: () => {}, get: () => null, getMany: () => new Map() });
});

afterEach(() => {
  setYahooGuardForTests(null);
  setLiveQuoteStoreForTests(null);
  vi.unstubAllGlobals();
});

describe('fetchYahooHistory — częściowy słupek bieżącego dnia', () => {
  it('NIE zapisuje do historii słupka datowanego na dziś', async () => {
    const today = new Date();
    const d1 = new Date(today.getTime() - 2 * DAY_MS);
    const d2 = new Date(today.getTime() - DAY_MS);

    // Yahoo przy period2 = dziś dokłada słupek trwającej sesji: `close` to cena
    // śróddzienna, nie zamknięcie. Zapisany do price_history byłby przez regułę
    // „≤3 dni = cache świeży" serwowany jako oficjalne zamknięcie i wchodził
    // w łańcuch TWR oraz na wykres.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          chart: {
            result: [
              {
                timestamp: [ts(d1), ts(d2), ts(today)],
                indicators: { quote: [{ close: [100, 101, 99.5] }] },
              },
            ],
          },
        }),
        text: async () => '',
      })),
    );

    await fetchYahooHistory('AAPL', iso(d1));

    const written = stored.flatMap((s) => s.rows.map((r) => r.date));
    expect(written).toEqual([iso(d1), iso(d2)]);
    expect(written).not.toContain(iso(today));
  });
});
