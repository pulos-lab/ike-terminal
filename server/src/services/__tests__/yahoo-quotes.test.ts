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
  parseQuoteEnvelope,
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
let guard: ReturnType<typeof createSourceGuard>;

beforeEach(() => {
  testCache.clear();
  ttlByKey.clear();
  vi.mocked(invalidateYahooAuth).mockClear();
  // Batch jest wyłączony globalnie w vitest.config (żeby testy silnika nie biły
  // do sieci) — ten plik testuje właśnie batch, więc włącza go u siebie.
  delete process.env.YAHOO_BATCH_QUOTES;
  guard = createSourceGuard({ name: 'yahoo-test', store: createMemoryGuardStore() });
  setYahooGuardForTests(guard);
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

  // ── Odporność koperty ──────────────────────────────────────────────────────
  // Regresja: twarda ścieżka `quoteResponse.result` zamieniała każdą zmianę
  // opakowania w ciche zero notowań przy HTTP 200 (alarm „zmiana markupu").

  it('czyta ten sam wynik z koperty `finance` co z `quoteResponse`', () => {
    const moved = { finance: { result: QUOTE_JSON.quoteResponse.result, error: null } };
    expect(parseQuoteResponse(moved).get('AAPL')?.price).toBe(304.81);
  });

  it('znajduje listę notowań pod nieznaną kopertą (byle wiersze miały symbol)', () => {
    const exotic = { data: { v7: { quoteList: QUOTE_JSON.quoteResponse.result } } };
    expect(parseQuoteResponse(exotic).get('CDR.WA')?.price).toBe(253.8);
  });

  it('gołą tablicę wierszy też przyjmuje', () => {
    expect(parseQuoteResponse(QUOTE_JSON.quoteResponse.result).size).toBe(4);
  });

  it('liczby owinięte w {raw, fmt} (formatted=true) czyta jak gołe', () => {
    const formatted = {
      quoteResponse: {
        result: [
          {
            symbol: 'AAPL',
            regularMarketPrice: { raw: 304.81, fmt: '304.81' },
            regularMarketPreviousClose: { raw: 308.91, fmt: '308.91' },
            currency: 'USD',
            marketState: 'REGULAR',
            regularMarketTime: { raw: 1_785_786_314, fmt: '4:00PM EDT' },
          },
        ],
      },
    };
    expect(parseQuoteResponse(formatted).get('AAPL')).toEqual({
      price: 304.81,
      currency: 'USD',
      previousClose: 308.91,
      marketState: 'REGULAR',
      quoteTime: 1_785_786_314_000,
    });
  });

  it('czas w milisekundach i w ISO daje ten sam moment co sekundy epoch', () => {
    const ms = 1_785_786_314_000;
    const rows = [
      { symbol: 'A', regularMarketPrice: 1, regularMarketTime: ms },
      { symbol: 'B', regularMarketPrice: 1, regularMarketTime: new Date(ms).toISOString() },
    ];
    const quotes = parseQuoteResponse(rows);
    expect(quotes.get('A')?.quoteTime).toBe(ms);
    expect(quotes.get('B')?.quoteTime).toBe(ms);
  });

  it('bierze wyłącznie regularMarketPrice — bid/ask/previousClose nie udają ceny', () => {
    const rows = [{ symbol: 'A', bid: 10, ask: 11, regularMarketPreviousClose: 9 }];
    expect(parseQuoteResponse(rows).size).toBe(0);
  });
});

describe('parseQuoteEnvelope — status koperty', () => {
  it('rozpoznane wiersze to `rows`, nawet gdy lista jest pusta', () => {
    expect(parseQuoteEnvelope(QUOTE_JSON).status).toBe('rows');
    expect(parseQuoteEnvelope({ quoteResponse: { result: [] } }).status).toBe('rows');
  });

  it('błąd przy HTTP 200 to `error`, nie „popsuty parser”', () => {
    // Tak Yahoo oddaje wygasłą parę cookie+crumb — ze statusem 200.
    const parsed = parseQuoteEnvelope({
      finance: { result: null, error: { code: 'Unauthorized', description: 'Invalid Crumb' } },
    });
    expect(parsed.status).toBe('error');
    expect(parsed.error).toEqual({ code: 'Unauthorized', description: 'Invalid Crumb' });
  });

  it('odpowiedź bez wierszy i bez błędu to `unrecognized` — jedyny powód alarmu', () => {
    expect(parseQuoteEnvelope({ somethingElse: { totally: 'new' } }).status).toBe('unrecognized');
    expect(parseQuoteEnvelope(null).status).toBe('unrecognized');
  });
});

describe('quoteTtlSeconds', () => {
  /** Moment w czasie warszawskim (lato = CEST, UTC+2). */
  function warsaw(hh: number, mm = 0): number {
    return Date.parse(
      `2026-08-05T${String(hh - 2).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`,
    );
  }

  it('sesja krótko, pre/post średnio, nieznany stan zachowawczo', () => {
    // 12:00 CEST: do najbliższego otwarcia (15:30 = NYSE) daleko, więc klamra
    // nie ogranicza i widać wartości bazowe.
    expect(quoteTtlSeconds('REGULAR', warsaw(12))).toBe(config.cache.quoteTtl.regular);
    expect(quoteTtlSeconds('PRE', warsaw(12))).toBe(config.cache.quoteTtl.prePost);
    expect(quoteTtlSeconds('POST', warsaw(12))).toBe(config.cache.quoteTtl.prePost);
    expect(quoteTtlSeconds(null, warsaw(12))).toBe(config.cache.quoteTtl.unknown);
  });

  it('PRE tuż przed otwarciem USA nie przeciąga się na sesję (było: 15:29 → 15:59)', () => {
    // Bez klamry na PRE akcje amerykańskie pokazywały wczorajsze zamknięcie
    // jeszcze ~29 min po starcie sesji.
    expect(quoteTtlSeconds('PRE', warsaw(15, 10))).toBe(20 * 60); // dokładnie do 15:30
    expect(quoteTtlSeconds('PRE', warsaw(15, 29))).toBe(5 * 60); // podłoga
  });

  it('otwarcie GPW nie jest jedynym punktem odniesienia — liczy się najbliższy rynek', () => {
    // 14:00 CEST: GPW dawno otwarte, ale NYSE startuje o 15:30 — klamra celuje tam.
    expect(quoteTtlSeconds('CLOSED', warsaw(14))).toBe(90 * 60);
  });

  it('PREPRE (spółki USA w europejskie przedpołudnie) liczy się jak zamknięty rynek', () => {
    // Bez tego stanu na liście wpadał w gałąź „nieznany" = 1 h, czyli 6 zbędnych
    // fal requestów na dobę dla portfeli amerykańskich.
    const wieczorem = warsaw(23);
    expect(quoteTtlSeconds('PREPRE', wieczorem)).toBe(quoteTtlSeconds('CLOSED', wieczorem));
  });

  it('po zamknięciu wieczorem trzyma długo, ale nie dłużej niż do otwarcia', () => {
    // 23:00 → do 9:00 zostało 10 h, więc ogranicza nas sufit 6 h.
    expect(quoteTtlSeconds('CLOSED', warsaw(23))).toBe(config.cache.quoteTtl.closed);
    // 5:00 → do otwarcia GPW 4 h; 6-godzinny TTL przeskoczyłby start sesji.
    expect(quoteTtlSeconds('CLOSED', warsaw(5))).toBe(4 * 3600);
  });

  it('tuż przed otwarciem NIE zamraża ceny na godziny (regresja: cena z 8:50 na 6 h)', () => {
    const ttl = quoteTtlSeconds('CLOSED', warsaw(8, 50));
    expect(ttl).toBe(10 * 60); // dokładnie do 9:00
    expect(ttl).toBeLessThan(config.cache.quoteTtl.closed);
  });

  it('ma podłogę — nawet minutę przed otwarciem nie odpytujemy w kółko', () => {
    expect(quoteTtlSeconds('CLOSED', warsaw(8, 59))).toBe(5 * 60);
  });

  it('stan zamknięty nigdy nie przekracza twardego sufitu', () => {
    expect(quoteTtlSeconds('CLOSED', warsaw(23))).toBeLessThanOrEqual(config.cache.quoteTtl.cap);
    expect(quoteTtlSeconds('POSTPOST', warsaw(23))).toBeLessThanOrEqual(config.cache.quoteTtl.cap);
  });
});

describe('primeYahooQuotes', () => {
  it('zapisuje ceny pod kluczem fetchYahooPrice z TTL wg stanu rynku', async () => {
    // Zegar zamrożony na 23:00 CEST: TTL zamkniętego rynku jest klamrowany do
    // najbliższego otwarcia GPW, więc bez tego asercja na 6 h byłaby czerwona
    // przy nocnym przebiegu testów.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-05T21:00:00Z'));
    try {
      fetchSpy.mockResolvedValue(jsonResponse(QUOTE_JSON));

      const { primed, missed } = await primeYahooQuotes(['AAPL', 'CDR.WA', 'GHOST']);

      expect(primed).toBe(2);
      expect(missed).toEqual(['GHOST']); // brak ceny w odpowiedzi = miss, nie błąd
      expect(testCache.get('yahoo_live_AAPL')).toMatchObject({ price: 304.81, currency: 'USD' });
      expect(ttlByKey.get('yahoo_live_AAPL')).toBe(config.cache.quoteTtl.regular);
      // Ta sama odpowiedź, inny rynek → inny TTL. To sedno zmiany.
      expect(ttlByKey.get('yahoo_live_CDR.WA')).toBe(config.cache.quoteTtl.closed);
    } finally {
      vi.useRealTimers();
    }
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

  // ── Sygnalizacja do guarda ────────────────────────────────────────────────
  // Alarm „podejrzenie zmiany markupu" ma się zapalać WYŁĄCZNIE wtedy, gdy
  // naprawdę nie rozumiemy odpowiedzi. Wygasły crumb i nieznane symbole to dwa
  // najczęstsze źródła fałszywych alarmów — oba mają tu swój test.

  it('koperta błędu przy HTTP 200 → odświeżenie crumba i powtórka, BEZ alarmu markupu', async () => {
    // Regresja: obsługa 401/403 nie łapała tej odmowy, bo status był 200 —
    // crumb nigdy się nie odświeżał, a guard dostawał parse-miss za parse-missem.
    fetchSpy.mockResolvedValue(
      jsonResponse({
        finance: { result: null, error: { code: 'Unauthorized', description: 'Invalid Crumb' } },
      }),
    );

    const { primed, missed } = await primeYahooQuotes(['AAPL']);

    expect(invalidateYahooAuth).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // pierwotny + jedna powtórka
    expect(primed).toBe(0);
    expect(missed).toEqual(['AAPL']);
    expect(guard.getState().suspectedMarkupChange).toBe(false);
  });

  it('kształt rozpoznany, ale symbole nieznane → brak alarmu (delisty to nie awaria API)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ quoteResponse: { result: [] } }));

    for (let i = 0; i < 4; i++) await primeYahooQuotes([`DELISTED${i}`]);

    expect(guard.getState().suspectedMarkupChange).toBe(false);
  });

  it('nierozpoznana koperta → alarm zmiany markupu (to jedyna droga do maila)', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ zupelnieNoweApi: { data: [] } }));

    // Próg strukturalny to 2 kolejne missy — jeden wyskok nie budzi admina.
    await primeYahooQuotes(['AAPL']);
    expect(guard.getState().suspectedMarkupChange).toBe(false);
    await primeYahooQuotes(['MSFT']);

    const state = guard.getState();
    expect(state.suspectedMarkupChange).toBe(true);
    expect(state.parseMissKeys).toContain('v7-quote');
  });

  it('poprawna odpowiedź gasi wcześniejszy alarm markupu', async () => {
    fetchSpy.mockResolvedValue(jsonResponse({ zupelnieNoweApi: {} }));
    await primeYahooQuotes(['AAPL']);
    await primeYahooQuotes(['MSFT']);
    expect(guard.getState().suspectedMarkupChange).toBe(true);

    fetchSpy.mockResolvedValue(jsonResponse(QUOTE_JSON));
    await primeYahooQuotes(['AAPL']);

    expect(guard.getState().suspectedMarkupChange).toBe(false);
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
