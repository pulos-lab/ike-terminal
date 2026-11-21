/**
 * Split „w drodze" — stan przejściowy w dniu ex (zgłoszenie 2026-11-20, SNDK 8:1).
 *
 * Rano w dniu ex Yahoo ma już historię dzienną podzieloną przez ratio i zdarzenie split
 * z dzisiejszą datą, ale notowanie bieżące to nadal zamknięcie wczorajszej sesji, w starej
 * skali. Trzy skutki, każdy pokryty niżej:
 *  1. ilość ×8 mnożona przez kurs sprzed splitu → wartość i zysk 8× za wysokie,
 *  2. okno zapytania o zdarzenia kończyło się o północy, więc dzisiejszego zdarzenia nie
 *     było → data zastępcza „pierwszy zakup +1", późniejsze zakupy w starej skali,
 *  3. wpis z datą zastępczą zostawał na zawsze (i nie zapalał znaczka splitu).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DetectedSplit, Transaction, TickerMapEntry } from 'shared';

// DATA_DIR przed importem modułów (łańcuch db/config liczy ścieżkę przy imporcie)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-split-transit-'));
process.env.DATA_DIR = tmpDir;

vi.mock('../stooq.js', () => ({
  fetchStooqPrice: vi.fn().mockResolvedValue(null),
  fetchStooqPreviousClose: vi.fn().mockResolvedValue(null),
  fetchStooqHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../yahoo-finance.js', () => ({
  fetchYahooPrice: vi.fn().mockResolvedValue(null),
  fetchFxRate: vi.fn().mockResolvedValue(null),
  fetchYahooHistory: vi.fn().mockResolvedValue([]),
  fetchYahooHistoryDirect: vi.fn().mockResolvedValue(null),
  fetchYahooSplitEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock('../biznesradar.js', () => ({
  fetchBiznesradarPrice: vi.fn().mockResolvedValue(null),
  fetchBiznesradarHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../stockwatch-bonds.js', () => ({
  fetchStockwatchBondPrice: vi.fn().mockResolvedValue(null),
}));

const { normalizeLiveQuoteForSplits, pickSplitDateCorrection } =
  await import('../split-detector.js');
const { computeOpenPositions, resolveSplitEventDates } = await import('../portfolio-engine.js');
const { healSplitDatesFromYahoo } = await import('../portfolio-views.js');
const { getDb } = await import('../../db/connection.js');
const { getSplits } = await import('../../db/splits-repo.js');
const { getMetadata } = await import('../../db/operations-repo.js');
const yahoo = await import('../yahoo-finance.js');

const ISIN = 'US80004C2008';
const SNDK: TickerMapEntry = {
  isin: ISIN,
  ticker: 'SNDK',
  name: 'Sandisk Corporation',
  exchange: 'NASDAQ',
  currency: 'USD',
  priceSource: 'yahoo',
};
const tickerMap = new Map([[ISIN, SNDK]]);

const EX_DATE = '2026-11-20';
const split8: DetectedSplit = {
  ticker: 'SNDK',
  isin: ISIN,
  date: EX_DATE,
  ratio: 8,
  txPrice: 0,
  providerPrice: 0,
  source: 'auto',
};

function buy(date: string, quantity: number, price: number): Transaction {
  return {
    date: `${date}T10:00:00`,
    paperName: 'SANDISK',
    isin: ISIN,
    quantity,
    side: 'K',
    price,
    value: quantity * price,
    commission: 0,
    total: quantity * price,
    currency: 'USD',
    paymentCurrency: 'USD',
    category: 'stock',
    source: 'bossa',
  };
}

beforeEach(() => {
  vi.mocked(yahoo.fetchYahooPrice).mockReset().mockResolvedValue(null);
  vi.mocked(yahoo.fetchYahooHistoryDirect).mockReset().mockResolvedValue(null);
  vi.mocked(yahoo.fetchYahooSplitEvents).mockReset().mockResolvedValue([]);
});

describe('normalizeLiveQuoteForSplits', () => {
  it('notowanie z sesji SPRZED ex-date sprowadza do skali po splicie', () => {
    const out = normalizeLiveQuoteForSplits({
      splits: [split8],
      isin: ISIN,
      quoteDate: '2026-11-19',
      price: 755.16,
      previousClose: 776.22,
    });
    expect(out.price).toBeCloseTo(94.395, 3);
    expect(out.previousClose).toBeCloseTo(97.0275, 3);
  });

  it('notowanie sprzed weekendu przy splicie w poniedziałek też jest „sprzed ex"', () => {
    const out = normalizeLiveQuoteForSplits({
      splits: [{ ...split8, date: '2026-11-23' }],
      isin: ISIN,
      quoteDate: '2026-11-20',
      price: 800,
      previousClose: 760,
    });
    expect(out.price).toBe(100);
  });

  it('dzień ex, poprzednie zamknięcie w STAREJ skali → dzieli samo zamknięcie', () => {
    const out = normalizeLiveQuoteForSplits({
      splits: [split8],
      isin: ISIN,
      quoteDate: EX_DATE,
      price: 95,
      previousClose: 755.16,
    });
    expect(out.price).toBe(95);
    expect(out.previousClose).toBeCloseTo(94.395, 3);
  });

  it('dzień ex, poprzednie zamknięcie już skorygowane → nic nie rusza', () => {
    const quote = { price: 95, previousClose: 94.39 };
    const out = normalizeLiveQuoteForSplits({
      splits: [split8],
      isin: ISIN,
      quoteDate: EX_DATE,
      ...quote,
    });
    expect(out).toEqual(quote);
  });

  it('dzień ex splitu 2:1 i zwykły spadek o 30% → to ruch rynku, nie skala', () => {
    const quote = { price: 70, previousClose: 100 };
    const out = normalizeLiveQuoteForSplits({
      splits: [{ ...split8, ratio: 2 }],
      isin: ISIN,
      quoteDate: EX_DATE,
      ...quote,
    });
    expect(out).toEqual(quote);
  });

  it('split z przeszłości, cudzy papier i odległa data przyszła → bez zmian', () => {
    const quote = { price: 94, previousClose: 95 };
    for (const splits of [
      [{ ...split8, date: '2026-11-10' }], // dawno po splicie
      [{ ...split8, isin: 'US0000000000' }], // inny papier
      [{ ...split8, date: '2026-12-15' }], // notowanie zbyt stare, skala nieznana
    ]) {
      expect(
        normalizeLiveQuoteForSplits({ splits, isin: ISIN, quoteDate: '2026-11-19', ...quote }),
      ).toEqual(quote);
    }
  });

  it('reverse split 1:10 w drodze mnoży cenę', () => {
    const out = normalizeLiveQuoteForSplits({
      splits: [{ ...split8, ratio: 0.1 }],
      isin: ISIN,
      quoteDate: '2026-11-19',
      price: 2,
      previousClose: null,
    });
    expect(out.price).toBeCloseTo(20, 6);
    expect(out.previousClose).toBeNull();
  });
});

describe('resolveSplitEventDates — okno zdarzeń obejmuje dzień bieżący', () => {
  const heuristic: DetectedSplit = {
    ...split8,
    date: '2026-09-15',
    txPrice: 1530.88,
    providerPrice: 191.36,
  };

  it('pyta Yahoo o zdarzenia do JUTRA i bierze dzisiejszy ex-date zamiast daty zastępczej', async () => {
    // Zachowanie Yahoo: zdarzenie z dnia ex wpada tylko w okno kończące się po tym dniu.
    vi.mocked(yahoo.fetchYahooSplitEvents).mockImplementation(async (_t, _start, end) =>
      end && end > EX_DATE ? [{ date: EX_DATE, ratio: 8 }] : [],
    );

    const resolved = await resolveSplitEventDates([heuristic], tickerMap, {
      nowMs: Date.parse('2026-11-20T08:52:00Z'),
    });

    expect(yahoo.fetchYahooSplitEvents).toHaveBeenCalledWith('SNDK', '2026-09-15', '2026-11-21');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].date).toBe(EX_DATE);
    expect(resolved[0].ratio).toBe(8);
  });
});

describe('computeOpenPositions — split 8:1 w dniu ex', () => {
  // 15 akcji sprzed splitu, kupione w dwóch terminach — po splicie 120.
  const txs = [buy('2026-09-15', 10, 1530.88), buy('2026-10-15', 5, 1394.8)];
  const cost = 10 * 1530.88 + 5 * 1394.8;

  function mockYahooOnExDay(quote: { price: number; previousClose: number; quoteTime: string }) {
    vi.mocked(yahoo.fetchYahooHistoryDirect).mockResolvedValue(191.36); // historia już ÷8
    vi.mocked(yahoo.fetchYahooSplitEvents).mockResolvedValue([{ date: EX_DATE, ratio: 8 }]);
    vi.mocked(yahoo.fetchYahooPrice).mockResolvedValue({
      price: quote.price,
      previousClose: quote.previousClose,
      currency: 'USD',
      quoteTime: Date.parse(quote.quoteTime),
    });
  }

  it('przed otwarciem sesji: kurs sprzed splitu nie zawyża wartości ani zysku', async () => {
    mockYahooOnExDay({ price: 755.16, previousClose: 776.22, quoteTime: '2026-11-19T21:00:00Z' });

    const res = await computeOpenPositions(txs, tickerMap, [], { USD: 1 });

    expect(res.detectedSplits).toMatchObject([{ isin: ISIN, date: EX_DATE, ratio: 8 }]);
    const pos = res.positions[0];
    // OBA zakupy przeliczone — data zastępcza „pierwszy zakup +1" gubiła drugi (85 szt.)
    expect(pos.shares).toBeCloseTo(120, 6);
    expect(pos.currentPrice).toBeCloseTo(94.395, 3);
    expect(pos.currentValue).toBeCloseTo(15 * 755.16, 2); // realna wartość 15 starych akcji
    expect(pos.profitLoss).toBeCloseTo(15 * 755.16 - cost, 2);
    expect(pos.dailyChangePct).toBeCloseTo(((755.16 - 776.22) / 776.22) * 100, 4);
  });

  it('po otwarciu sesji: nowy kurs zostaje, a zmiana dzienna nie wygląda jak krach', async () => {
    mockYahooOnExDay({ price: 95, previousClose: 755.16, quoteTime: '2026-11-20T15:00:00Z' });

    const res = await computeOpenPositions(txs, tickerMap, [], { USD: 1 });

    const pos = res.positions[0];
    expect(pos.shares).toBeCloseTo(120, 6);
    expect(pos.currentPrice).toBe(95);
    expect(pos.currentValue).toBeCloseTo(120 * 95, 2);
    expect(pos.dailyChangePct).toBeCloseTo(((95 - 94.395) / 94.395) * 100, 3);
  });
});

describe('pickSplitDateCorrection', () => {
  const saved = { splitDate: '2026-09-16', ratio: 8, detectedAt: '2026-11-20 07:41:02' };
  const event = { date: EX_DATE, ratio: 8 };

  it('data zastępcza + zdarzenie Yahoo z dnia wykrycia → przepięcie na ex-date', () => {
    expect(pickSplitDateCorrection({ saved, events: [event], otherSavedDates: [] })).toEqual(event);
  });

  it('Yahoo potwierdza zapisaną datę → wpis jest poprawny', () => {
    expect(
      pickSplitDateCorrection({
        saved: { ...saved, splitDate: EX_DATE },
        events: [event],
        otherSavedDates: [],
      }),
    ).toBeNull();
  });

  it('brak zdarzeń (Yahoo nie zna splitu) → zostaje data heurystyczna', () => {
    expect(pickSplitDateCorrection({ saved, events: [], otherSavedDates: [] })).toBeNull();
  });

  it('zdarzenie o innym ratio → to nie ten split', () => {
    expect(
      pickSplitDateCorrection({
        saved,
        events: [{ date: EX_DATE, ratio: 2 }],
        otherSavedDates: [],
      }),
    ).toBeNull();
  });

  it('zdarzenie daleko od dnia wykrycia → nie ta sygnatura błędu, nie ruszamy', () => {
    expect(
      pickSplitDateCorrection({
        saved: { ...saved, detectedAt: '2026-10-01 10:00:00' },
        events: [event],
        otherSavedDates: [],
      }),
    ).toBeNull();
  });

  it('dwa pasujące zdarzenia albo zajęta data → niejednoznaczne, nie ruszamy', () => {
    expect(
      pickSplitDateCorrection({
        saved,
        events: [event, { date: '2026-11-21', ratio: 8 }],
        otherSavedDates: [],
      }),
    ).toBeNull();
    expect(
      pickSplitDateCorrection({ saved, events: [event], otherSavedDates: [EX_DATE] }),
    ).toBeNull();
  });

  it('wpis bez daty wykrycia → nie ma czym potwierdzić sygnatury', () => {
    expect(
      pickSplitDateCorrection({
        saved: { ...saved, detectedAt: undefined },
        events: [event],
        otherSavedDates: [],
      }),
    ).toBeNull();
  });
});

describe('healSplitDatesFromYahoo — wpis zapisany z datą zastępczą', () => {
  const NOW = Date.parse('2026-11-20T16:00:00Z');

  function seed(pid: string, row: { date: string; source?: string; detectedAt?: string }) {
    getDb(pid)
      .prepare(
        `INSERT INTO stock_splits (isin, ticker, split_date, ratio, source, detected_at)
         VALUES (?, 'SNDK', ?, 8, ?, ?)`,
      )
      .run(ISIN, row.date, row.source ?? 'auto', row.detectedAt ?? '2026-11-20 07:41:02');
  }

  it('przepina datę na ex-date z Yahoo i robi to raz na dobę', async () => {
    const pid = 'heal-basic';
    seed(pid, { date: '2026-09-16' });
    vi.mocked(yahoo.fetchYahooSplitEvents).mockResolvedValue([{ date: EX_DATE, ratio: 8 }]);

    expect(await healSplitDatesFromYahoo(pid, tickerMap, { nowMs: NOW })).toBe(1);

    expect(yahoo.fetchYahooSplitEvents).toHaveBeenCalledWith('SNDK', '2026-09-16', '2026-11-21');
    expect(getSplits(pid)).toMatchObject([{ isin: ISIN, splitDate: EX_DATE, ratio: 8 }]);
    expect(getMetadata(pid, 'last_split_date_heal')).toBe('2026-11-20');

    // Drugi przebieg tego samego dnia nie pyta już Yahoo.
    vi.mocked(yahoo.fetchYahooSplitEvents).mockClear();
    expect(await healSplitDatesFromYahoo(pid, tickerMap, { nowMs: NOW })).toBe(0);
    expect(yahoo.fetchYahooSplitEvents).not.toHaveBeenCalled();
  });

  it('nie rusza splitów ręcznych ani wykrytych dawno temu (zero żądań)', async () => {
    const pid = 'heal-skip';
    seed(pid, { date: '2026-09-16', source: 'manual' });
    seed(pid, { date: '2024-06-10', detectedAt: '2024-06-11 09:00:00' });
    vi.mocked(yahoo.fetchYahooSplitEvents).mockResolvedValue([{ date: EX_DATE, ratio: 8 }]);

    expect(await healSplitDatesFromYahoo(pid, tickerMap, { nowMs: NOW })).toBe(0);

    expect(yahoo.fetchYahooSplitEvents).not.toHaveBeenCalled();
    expect(getSplits(pid).map((s) => s.splitDate)).toEqual(['2024-06-10', '2026-09-16']);
  });
});
