import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Izolowany cache — realny price-cache to współdzielony NodeCache, który
// przeciekałby stanem między testami. Zapamiętujemy też TTL, bo to on jest tu
// sednem: „jak długo ta cena może leżeć".
const testCache = new Map<string, unknown>();
const ttlByKey = new Map<string, number | undefined>();
vi.mock('../price-cache.js', () => ({
  getCached: (key: string) => testCache.get(key),
  setCached: (key: string, value: unknown, ttl?: number) => {
    testCache.set(key, value);
    ttlByKey.set(key, ttl);
  },
}));

vi.mock('../yahoo-auth.js', () => ({
  getYahooAuth: vi.fn(async () => ({ crumb: 'CRUMB', cookies: 'A=1' })),
  invalidateYahooAuth: vi.fn(),
}));

import {
  parseQuoteResponse,
  quoteTtlSeconds,
  primeYahooQuotes,
  summarizeQuoteFreshness,
} from '../yahoo-quotes.js';
import { setYahooGuardForTests } from '../yahoo-guard.js';
import { setLiveQuoteStoreForTests } from '../live-quote-store.js';
import { createSourceGuard, createMemoryGuardStore } from '../source-guard.js';
import { invalidateYahooAuth } from '../yahoo-auth.js';
import { config } from '../../config.js';

/** Odpowiedź v7 1:1 z kształtem Yahoo: mix stanów rynku, GBp, para FX. */
const QUOTE_JSON = {
  quoteResponse: {
    result: [
      {
        symbol: 'AAPL',
        regularMarketPrice: 304.81,
        regularMarketPreviousClose: 308.91,
        currency: 'USD',
        marketState: 'REGULAR',
        regularMarketTime: 1_785_786_314,
      },
      {
        symbol: 'CDR.WA',
        regularMarketPrice: 253.8,
        regularMarketPreviousClose: 249.9,
        currency: 'PLN',
        marketState: 'CLOSED',
        regularMarketTime: 1_785_769_344,
      },
      {
        symbol: 'SHEL.L',
        regularMarketPrice: 2850.5,
        regularMarketPreviousClose: 2840,
        currency: 'GBp',
        marketState: 'POST',
        regularMarketTime: 1_785_769_000,
      },
      {
        symbol: 'USDPLN=X',
        regularMarketPrice: 3.74495,
        currency: 'PLN',
        marketState: 'REGULAR',
        regularMarketTime: 1_785_786_314,
      },
      // Bez ceny — Yahoo tak oddaje symbole, których nie zna.
      { symbol: 'GHOST', currency: 'USD', marketState: 'REGULAR' },
    ],
  },
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  testCache.clear();
  ttlByKey.clear();
  vi.mocked(invalidateYahooAuth).mockClear();
  // Batch jest wyłączony globalnie w vitest.config (żeby testy silnika nie biły
  // do sieci) — ten plik testuje właśnie batch, więc włącza go u siebie.
  delete process.env.YAHOO_BATCH_QUOTES;
  setYahooGuardForTests(createSourceGuard({ name: 'yahoo-test', store: createMemoryGuardStore() }));
  setLiveQuoteStoreForTests({ upsert: () => {}, get: () => null, getMany: () => new Map() });
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  process.env.YAHOO_BATCH_QUOTES = 'off';
  setYahooGuardForTests(null);
  setLiveQuoteStoreForTests(null);
  vi.unstubAllGlobals();
});

describe('parseQuoteResponse', () => {
  it('mapuje symbole z ceną i pomija te bez niej', () => {
    const quotes = parseQuoteResponse(QUOTE_JSON);
    expect([...quotes.keys()].sort()).toEqual(['AAPL', 'CDR.WA', 'SHEL.L', 'USDPLN=X']);
    expect(quotes.get('AAPL')).toEqual({
      price: 304.81,
      currency: 'USD',
      previousClose: 308.91,
      marketState: 'REGULAR',
      quoteTime: 1_785_786_314_000,
    });
  });

  it('zostawia GBp surowe — normalizacja pensów należy do silnika', () => {
    expect(parseQuoteResponse(QUOTE_JSON).get('SHEL.L')?.currency).toBe('GBp');
  });

  it('brak previousClose → null, nie zero', () => {
    expect(parseQuoteResponse(QUOTE_JSON).get('USDPLN=X')?.previousClose).toBeNull();
  });

  it('śmieciowa odpowiedź → pusta mapa (bez wyjątku)', () => {
    expect(parseQuoteResponse({ nope: true }).size).toBe(0);
    expect(parseQuoteResponse(null).size).toBe(0);
  });
});

describe('quoteTtlSeconds', () => {
  it('sesja krótko, po sesji długo, nieznany stan zachowawczo', () => {
    expect(quoteTtlSeconds('REGULAR')).toBe(config.cache.quoteTtl.regular);
    expect(quoteTtlSeconds('PRE')).toBe(config.cache.quoteTtl.prePost);
    expect(quoteTtlSeconds('POST')).toBe(config.cache.quoteTtl.prePost);
    expect(quoteTtlSeconds(null)).toBe(config.cache.quoteTtl.unknown);
  });

  it('stan zamknięty nigdy nie przekracza twardego sufitu', () => {
    expect(quoteTtlSeconds('CLOSED')).toBeLessThanOrEqual(config.cache.quoteTtl.cap);
    expect(quoteTtlSeconds('POSTPOST')).toBeLessThanOrEqual(config.cache.quoteTtl.cap);
  });
});

describe('primeYahooQuotes', () => {
  it('zapisuje ceny pod kluczem fetchYahooPrice z TTL wg stanu rynku', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(QUOTE_JSON));

    const { primed, missed } = await primeYahooQuotes(['AAPL', 'CDR.WA', 'GHOST']);

    expect(primed).toBe(2);
    expect(missed).toEqual(['GHOST']); // brak ceny w odpowiedzi = miss, nie błąd
    expect(testCache.get('yahoo_live_AAPL')).toMatchObject({ price: 304.81, currency: 'USD' });
    expect(ttlByKey.get('yahoo_live_AAPL')).toBe(config.cache.quoteTtl.regular);
    // Ta sama odpowiedź, inny rynek → inny TTL. To sedno zmiany.
    expect(ttlByKey.get('yahoo_live_CDR.WA')).toBe(config.cache.quoteTtl.closed);
  });

  it('parę walutową zapisuje też pod kluczem kursu (fetchFxRate nie strzela osobno)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(QUOTE_JSON));
    await primeYahooQuotes(['USDPLN=X']);
    expect(testCache.get('fx_USDPLN')).toBe(3.74495);
  });

  it('pyta wyłącznie o symbole spoza cache’u', async () => {
    testCache.set('yahoo_live_AAPL', { price: 1, currency: 'USD', previousClose: null });
    fetchSpy.mockResolvedValue(jsonResponse(QUOTE_JSON));

    await primeYahooQuotes(['AAPL']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dzieli listę na paczki po 50 symboli', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ quoteResponse: { result: [] } }));
    const many = Array.from({ length: 120 }, (_, i) => `T${i}`);

    await primeYahooQuotes(many);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const call of fetchSpy.mock.calls) {
      const url = new URL(call[0] as string);
      expect(url.searchParams.get('symbols')!.split(',').length).toBeLessThanOrEqual(50);
    }
  });

  it('401 → odświeżenie crumba i JEDNA powtórka; drugie 401 to już odcięcie', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, 401));

    const { primed, missed } = await primeYahooQuotes(['AAPL']);

    expect(invalidateYahooAuth).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // pierwotny + jedna powtórka
    expect(primed).toBe(0);
    expect(missed).toEqual(['AAPL']);
  });

  it('3 × 429 otwiera bezpiecznik — czwarte wywołanie nie rusza sieci', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ error: 'Too Many Requests' }, 429));

    for (let i = 0; i < 3; i++) await primeYahooQuotes([`T${i}`]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const { missed } = await primeYahooQuotes(['T9']);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // bez nowego strzału
    expect(missed).toEqual(['T9']);
  });

  it('wyłącznik YAHOO_BATCH_QUOTES=off oddaje wszystko jako missed bez sieci', async () => {
    process.env.YAHOO_BATCH_QUOTES = 'off';
    const { primed, missed } = await primeYahooQuotes(['AAPL']);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(primed).toBe(0);
    expect(missed).toEqual(['AAPL']);
  });
});

describe('summarizeQuoteFreshness', () => {
  const HOUR = 3_600_000;

  function seed(ticker: string, marketState: string | null, quoteTime: number | null) {
    testCache.set(`yahoo_live_${ticker}`, {
      price: 1,
      currency: 'USD',
      previousClose: null,
      marketState,
      quoteTime,
    });
  }

  it('asOf bierze NAJŚWIEŻSZE notowanie — instrument o rzadkim handlu nie postarza całości', () => {
    const now = Date.now();
    // Opcja handlowana ostatnio kilka dni temu obok akcji z kursem sprzed minut.
    // Minimum pokazywałoby „Kursy z zeszłego tygodnia" mimo aktualnych danych —
    // to mierzyłoby płynność instrumentu, nie świeżość naszych cen.
    seed('OKLO271217P00015000', 'REGULAR', now - 96 * HOUR);
    seed('AAPL', 'REGULAR', now - 2 * 60_000);

    const { asOf } = summarizeQuoteFreshness(['OKLO271217P00015000', 'AAPL']);
    expect(Date.parse(asOf!)).toBe(now - 2 * 60_000);
  });

  it('TTL bierze MINIMUM — jedna pozycja w sesji dyktuje tempo całemu portfelowi', () => {
    seed('CDR.WA', 'CLOSED', Date.now());
    seed('AAPL', 'REGULAR', Date.now());

    const summary = summarizeQuoteFreshness(['CDR.WA', 'AAPL']);
    expect(summary.ttlSeconds).toBe(config.cache.quoteTtl.regular);
    expect(summary.marketOpen).toBe(true);
  });

  it('same rynki zamknięte → długi TTL i marketOpen=false', () => {
    seed('CDR.WA', 'CLOSED', Date.now());
    const summary = summarizeQuoteFreshness(['CDR.WA']);
    expect(summary.ttlSeconds).toBe(config.cache.quoteTtl.closed);
    expect(summary.marketOpen).toBe(false);
  });

  it('brak notowań w cache (portfel NC/Catalyst) → zachowawcza godzina, bez asOf', () => {
    const summary = summarizeQuoteFreshness(['NIEZNANY']);
    expect(summary.asOf).toBeNull();
    expect(summary.ttlSeconds).toBe(config.cache.quoteTtl.unknown);
    expect(summary.marketOpen).toBe(false);
  });
});
