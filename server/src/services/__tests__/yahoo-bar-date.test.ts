import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const testCache = new Map<string, unknown>();
vi.mock('../price-cache.js', () => ({
  getCached: (key: string) => testCache.get(key),
  setCached: (key: string, value: unknown) => {
    testCache.set(key, value);
  },
}));

// Historia trzymana w pamięci — bez dotykania price_history.db.
type Row = { date: string; close: number };
const persisted = new Map<string, Map<string, number>>();
function rowsOf(ticker: string): Row[] {
  return [...(persisted.get(ticker) ?? new Map<string, number>())]
    .map(([date, close]) => ({ date, close }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
vi.mock('../history-cache.js', () => ({
  // Jak `INSERT OR REPLACE` z kluczem (ticker, date): późniejszy zapis wygrywa.
  storeHistoricalPrices: (ticker: string, rows: Row[], _source: string) => {
    const byDate = persisted.get(ticker) ?? new Map<string, number>();
    for (const r of rows) byDate.set(r.date, r.close);
    persisted.set(ticker, byDate);
  },
  loadHistoricalPrices: (ticker: string) => rowsOf(ticker),
  getLastCachedDate: (ticker: string) => rowsOf(ticker).at(-1)?.date ?? null,
  getFirstCachedDate: (ticker: string) => rowsOf(ticker)[0]?.date ?? null,
  invalidateCachedPrices: () => {},
}));

vi.mock('../yahoo-auth.js', () => ({
  getYahooAuth: vi.fn(async () => ({ crumb: 'C', cookies: 'A=1' })),
  invalidateYahooAuth: vi.fn(),
}));

import { fetchYahooHistory, fetchYahooHistoryDirect } from '../yahoo-finance.js';
import { setYahooGuardForTests } from '../yahoo-guard.js';
import { setLiveQuoteStoreForTests } from '../live-quote-store.js';
import { createSourceGuard, createMemoryGuardStore } from '../source-guard.js';
import { isSettledYahooBar, utcDateOfTimestamp, yahooBarDate } from '../yahoo-bar-date.js';

/** Sekundy epoch z zapisu ISO — tak, jak stempluje słupki Yahoo. */
const ts = (iso: string): number => Date.parse(iso) / 1000;

/** Odpowiedź v8 chart z jednym wynikiem; `timeZone` ląduje w `meta`. */
function stubChart(bars: Array<[string, number | null]>, timeZone?: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        chart: {
          result: [
            {
              meta: timeZone ? { exchangeTimezoneName: timeZone, gmtoffset: 0 } : {},
              timestamp: bars.map(([iso]) => ts(iso)),
              indicators: { quote: [{ close: bars.map(([, close]) => close) }] },
            },
          ],
        },
      }),
      text: async () => '',
    })),
  );
}

/** Zamraża wyłącznie `Date` — kod pod testem czyta „dziś" z zegara. */
function freezeClock(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  testCache.clear();
  persisted.clear();
  setYahooGuardForTests(createSourceGuard({ name: 'yahoo-test', store: createMemoryGuardStore() }));
  setLiveQuoteStoreForTests({ upsert: () => {}, get: () => null, getMany: () => new Map() });
});

afterEach(() => {
  setYahooGuardForTests(null);
  setLiveQuoteStoreForTests(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('yahooBarDate — data sesji w strefie giełdy', () => {
  // Stemple i strefy zmierzone na żywej odpowiedzi v8 chart (2026-11-23).
  it('para walutowa latem: stempel 23:00 UTC to sesja dnia NASTĘPNEGO', () => {
    // Poniedziałek 2026-07-13 w Londynie zaczyna się w niedzielę o 23:00 UTC.
    expect(utcDateOfTimestamp(ts('2026-07-12T23:00:00Z'))).toBe('2026-07-12');
    expect(yahooBarDate(ts('2026-07-12T23:00:00Z'), 'Europe/London')).toBe('2026-07-13');
    // Piątek — przy datowaniu po UTC wypadał z serii (lądował pod czwartkiem).
    expect(yahooBarDate(ts('2026-07-16T23:00:00Z'), 'Europe/London')).toBe('2026-07-17');
  });

  it('para walutowa zimą: stempel 00:00 UTC, data bez zmian', () => {
    expect(yahooBarDate(ts('2026-01-16T00:00:00Z'), 'Europe/London')).toBe('2026-01-16');
  });

  it('przejścia czasu w Londynie nie gubią ani nie dublują sesji', () => {
    // Marzec: piątek jeszcze w GMT, poniedziałek już w BST.
    expect(yahooBarDate(ts('2026-03-27T00:00:00Z'), 'Europe/London')).toBe('2026-03-27');
    expect(yahooBarDate(ts('2026-03-29T23:00:00Z'), 'Europe/London')).toBe('2026-03-30');
    // Październik: piątek jeszcze w BST, poniedziałek już w GMT.
    expect(yahooBarDate(ts('2026-10-22T23:00:00Z'), 'Europe/London')).toBe('2026-10-23');
    expect(yahooBarDate(ts('2026-10-26T00:00:00Z'), 'Europe/London')).toBe('2026-10-26');
  });

  it('ASX: przesunięcie tylko w czasie letnim Sydney (AEDT)', () => {
    expect(yahooBarDate(ts('2026-01-12T23:00:00Z'), 'Australia/Sydney')).toBe('2026-01-13');
    expect(yahooBarDate(ts('2026-07-14T00:00:00Z'), 'Australia/Sydney')).toBe('2026-07-14');
  });

  it('NZX: przesunięcie przez cały rok', () => {
    expect(yahooBarDate(ts('2026-01-12T21:00:00Z'), 'Pacific/Auckland')).toBe('2026-01-13');
    expect(yahooBarDate(ts('2026-07-13T22:00:00Z'), 'Pacific/Auckland')).toBe('2026-07-14');
  });

  it('rynki, których data UTC i data sesji są tym samym dniem', () => {
    expect(yahooBarDate(ts('2026-07-14T13:30:00Z'), 'America/New_York')).toBe('2026-07-14'); // AAPL
    expect(yahooBarDate(ts('2026-07-14T04:00:00Z'), 'America/New_York')).toBe('2026-07-14'); // GC=F
    expect(yahooBarDate(ts('2026-01-13T08:00:00Z'), 'Europe/Warsaw')).toBe('2026-01-13'); // PKN.WA
    expect(yahooBarDate(ts('2026-07-14T00:00:00Z'), 'Asia/Tokyo')).toBe('2026-07-14'); // 7203.T
    expect(yahooBarDate(ts('2026-07-18T00:00:00Z'), 'UTC')).toBe('2026-07-18'); // BTC-USD
  });

  it('brak strefy albo strefa nieznana środowisku → data UTC, jak dotąd', () => {
    const stamp = ts('2026-07-12T23:00:00Z');
    expect(yahooBarDate(stamp, undefined)).toBe('2026-07-12');
    expect(yahooBarDate(stamp, null)).toBe('2026-07-12');
    expect(yahooBarDate(stamp, '')).toBe('2026-07-12');
    expect(yahooBarDate(stamp, 'Mars/Olympus_Mons')).toBe('2026-07-12');
  });
});

describe('isSettledYahooBar — słupek trwającej sesji', () => {
  it('słupek stemplowany bieżącym czasem notowania (waluty w ciągu dnia)', () => {
    // Środa 10:00 UTC: słupek dzisiejszej doby londyńskiej niesie kurs śróddzienny.
    expect(isSettledYahooBar(ts('2026-07-22T09:59:30Z'), 'Europe/London', '2026-07-22')).toBe(
      false,
    );
    // Wtorkowa doba londyńska (stempel pon. 23:00 UTC) jest już zamknięta.
    expect(isSettledYahooBar(ts('2026-07-20T23:00:00Z'), 'Europe/London', '2026-07-22')).toBe(true);
  });

  it('słupek stemplowany początkiem sesji, która w UTC zaczęła się wczoraj (NZX)', () => {
    // Wtorek 00:30 UTC = 13:30 w Auckland, sesja wtorkowa trwa od 21:00 UTC w pon.
    // Data UTC stempla to poniedziałek — sam warunek na UTC by go przepuścił.
    const liveBar = ts('2026-11-23T21:00:00Z');
    expect(utcDateOfTimestamp(liveBar) < '2026-11-24').toBe(true);
    expect(isSettledYahooBar(liveBar, 'Pacific/Auckland', '2026-11-24')).toBe(false);
    // Sesja poniedziałkowa (stempel niedz. 21:00 UTC) jest zamknięta.
    expect(isSettledYahooBar(ts('2026-11-22T21:00:00Z'), 'Pacific/Auckland', '2026-11-24')).toBe(
      true,
    );
  });

  it('waluty latem między 23:00 a północą UTC: doba londyńska datowana na dziś czeka', () => {
    // Czwartek 23:30 UTC, w Londynie już piątek. Doba czwartkowa właśnie się
    // skończyła, ale jej data to dzisiejsza data UTC — zapis po północy UTC.
    expect(isSettledYahooBar(ts('2026-07-15T23:00:00Z'), 'Europe/London', '2026-07-16')).toBe(
      false,
    );
    expect(isSettledYahooBar(ts('2026-07-15T23:00:00Z'), 'Europe/London', '2026-07-17')).toBe(true);
    // Słupek doby piątkowej (bieżący czas notowania) — odpada warunkiem na UTC.
    expect(isSettledYahooBar(ts('2026-07-16T23:29:00Z'), 'Europe/London', '2026-07-16')).toBe(
      false,
    );
  });

  it('bez strefy zachowuje się jak dawny filtr `data UTC < dziś`', () => {
    expect(isSettledYahooBar(ts('2026-07-21T12:00:00Z'), undefined, '2026-07-22')).toBe(true);
    expect(isSettledYahooBar(ts('2026-07-22T12:00:00Z'), undefined, '2026-07-22')).toBe(false);
  });
});

describe('fetchYahooHistory — seria walutowa latem (stempel 23:00 UTC)', () => {
  // Wycinek realnej odpowiedzi dla USDPLN=X; ostatni słupek to trwająca doba.
  const SUMMER_USDPLN: Array<[string, number]> = [
    ['2026-07-12T23:00:00Z', 3.79437], // poniedziałek 13.07
    ['2026-07-13T23:00:00Z', 3.80429], // wtorek 14.07
    ['2026-07-14T23:00:00Z', 3.78316], // środa 15.07
    ['2026-07-15T23:00:00Z', 3.76565], // czwartek 16.07
    ['2026-07-16T23:00:00Z', 3.77825], // piątek 17.07
    ['2026-07-19T23:00:00Z', 3.79734], // poniedziałek 20.07
    ['2026-07-20T23:00:00Z', 3.79431], // wtorek 21.07
    ['2026-07-22T09:59:30Z', 3.8012], // środa 22.07 — kurs śróddzienny
  ];

  it('zapisuje sesje pod ich datą: poniedziałek zamiast niedzieli, piątek obecny', async () => {
    freezeClock('2026-07-22T10:00:00Z');
    stubChart(SUMMER_USDPLN, 'Europe/London');

    const series = await fetchYahooHistory('USDPLN=X', '2026-07-13');

    expect(series).toEqual([
      { date: '2026-07-13', close: 3.79437 },
      { date: '2026-07-14', close: 3.80429 },
      { date: '2026-07-15', close: 3.78316 },
      { date: '2026-07-16', close: 3.76565 },
      { date: '2026-07-17', close: 3.77825 },
      { date: '2026-07-20', close: 3.79734 },
      { date: '2026-07-21', close: 3.79431 },
    ]);
    const weekdays = series.map((r) => new Date(`${r.date}T00:00:00Z`).getUTCDay());
    expect(weekdays).not.toContain(0); // żadnej niedzieli
    expect(weekdays.filter((d) => d === 5)).toHaveLength(1); // piątek 17.07
  });

  it('kurs z dnia D to zamknięcie sesji D, nie sesji D+1', async () => {
    freezeClock('2026-07-22T10:00:00Z');
    stubChart(SUMMER_USDPLN, 'Europe/London');

    const series = await fetchYahooHistory('USDPLN=X', '2026-07-13');
    const byDate = new Map(series.map((r) => [r.date, r.close]));

    // Przy datowaniu po UTC pod 13.07 leżało zamknięcie wtorkowe (3.80429),
    // czyli kurs, którego w poniedziałek jeszcze nie było.
    expect(byDate.get('2026-07-13')).toBe(3.79437);
    expect(byDate.get('2026-07-16')).toBe(3.76565);
  });

  it('nie zapisuje słupka trwającej doby', async () => {
    freezeClock('2026-07-22T10:00:00Z');
    stubChart(SUMMER_USDPLN, 'Europe/London');

    const series = await fetchYahooHistory('USDPLN=X', '2026-07-13');

    expect(series.map((r) => r.date)).not.toContain('2026-07-22');
    expect(series.map((r) => r.close)).not.toContain(3.8012);
  });
});

describe('fetchYahooHistory — słupek trwającej sesji stemplowany jej początkiem', () => {
  it('NZX po północy UTC: kurs śróddzienny NIE trafia pod wczorajszą datę', async () => {
    // Wtorek 00:30 UTC. Yahoo oddaje sesję poniedziałkową (zamkniętą) i wtorkową
    // (trwającą), obie ze stemplem 21:00 UTC dnia poprzedniego.
    freezeClock('2026-11-24T00:30:00Z');
    stubChart(
      [
        ['2026-11-19T21:00:00Z', 49.29], // piątek 20.11
        ['2026-11-22T21:00:00Z', 48.02], // poniedziałek 23.11 — zamknięcie
        ['2026-11-23T21:00:00Z', 48.74], // wtorek 24.11 — w trakcie sesji
      ],
      'Pacific/Auckland',
    );

    const series = await fetchYahooHistory('FPH.NZ', '2026-11-20');

    // Przy datowaniu po UTC wychodziło: 19.11 → 49.29, 22.11 (niedziela) → 48.02
    // oraz 23.11 → 48.74, czyli kurs śróddzienny jako poniedziałkowe zamknięcie.
    expect(series).toEqual([
      { date: '2026-11-20', close: 49.29 },
      { date: '2026-11-23', close: 48.02 },
    ]);
  });
});

describe('fetchYahooHistory — odpowiedź bez strefy giełdy', () => {
  it('datuje po UTC, jak przed zmianą', async () => {
    freezeClock('2026-07-22T10:00:00Z');
    stubChart([
      ['2026-07-20T13:30:00Z', 100],
      ['2026-07-21T13:30:00Z', 101],
      ['2026-07-22T09:00:00Z', 99.5],
    ]);

    const series = await fetchYahooHistory('AAPL', '2026-07-20');

    expect(series).toEqual([
      { date: '2026-07-20', close: 100 },
      { date: '2026-07-21', close: 101 },
    ]);
  });
});

describe('fetchYahooHistoryDirect — kurs z konkretnego dnia', () => {
  it('dla pary walutowej latem zwraca zamknięcie sesji z TEGO dnia', async () => {
    // Yahoo dla period1 = 13.07 00:00 UTC oddaje też słupek doby zawierającej
    // ten moment, czyli stemplowany 12.07 23:00 UTC (zmierzone).
    stubChart(
      [
        ['2026-07-12T23:00:00Z', 3.79437], // poniedziałek 13.07
        ['2026-07-13T23:00:00Z', 3.80429], // wtorek 14.07
      ],
      'Europe/London',
    );

    expect(await fetchYahooHistoryDirect('USDPLN=X', '2026-07-13')).toBe(3.79437);
  });
});
