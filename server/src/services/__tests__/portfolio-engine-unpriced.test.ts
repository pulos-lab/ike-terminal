/**
 * Wycena instrumentów BEZ wpisu ticker_map / bez historii notowań (delisted).
 *
 * Przed fixem pozycja bez wpisu była twardo pomijana w wycenie dziennej
 * (`if (!entry) continue`), a gotówka za kupno schodziła z salda — wykres
 * startował głęboko pod kreską (realny import ING 2017: „Portfel 6,89 zł" przy
 * wpłatach 2500 zł) i skakał przy sprzedaży. Delisted papiery (BRIJU, GETBACK)
 * nie mają historii w ŻADNYM źródle (biznesradar/Yahoo 404, Stooq martwy) —
 * silnik buduje im teraz syntetyczny wpis in-memory i wycenia z cen transakcji
 * (kotwice + interpolacja + forward-fill) + raportuje w `unpricedInstruments`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction, CashOperation, TickerMapEntry } from 'shared';

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

import { computePortfolioHistory } from '../portfolio-engine.js';
import * as yahoo from '../yahoo-finance.js';

function tx(
  side: 'K' | 'S',
  qty: number,
  price: number,
  date: string,
  over: Partial<Transaction> = {},
): Transaction {
  return {
    date: date + 'T10:00:00',
    paperName: 'BRIJU',
    isin: 'BRIJU',
    quantity: qty,
    side,
    price,
    value: qty * price,
    commission: 0,
    total: qty * price,
    currency: 'PLN',
    paymentCurrency: 'PLN',
    category: 'stock',
    source: 'ing',
    ...over,
  } as Transaction;
}

function deposit(amount: number, date: string): CashOperation {
  return {
    date: date + 'T00:00:00',
    operationType: 'deposit',
    description: '',
    amount,
    currency: 'PLN',
  } as CashOperation;
}

async function run(
  txs: Transaction[],
  ops: CashOperation[],
  tickerMap: Map<string, TickerMapEntry> = new Map(),
) {
  return computePortfolioHistory(
    txs,
    ops,
    tickerMap,
    '',
    'none',
    undefined,
    undefined,
    [],
    'PLN',
    [],
    undefined,
  );
}

describe('computePortfolioHistory — papier bez wpisu ticker_map (delisted)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pozycja zamknięta: wyceniana z cen transakcji, bez dołka i bez skoku', async () => {
    // Wpłata 2500 → kupno za 2000 → sprzedaż po 2200. Przed fixem wartość
    // spadała do samej gotówki (500) na cały okres trzymania.
    const { history, unpricedInstruments } = await run(
      [tx('K', 100, 20, '2017-03-15'), tx('S', 100, 22, '2017-09-15')],
      [deposit(2500, '2017-03-01')],
    );

    // Dzień kupna: wartość ≈ wpłaty (gotówka 500 + pozycja 2000) — zwrot ≈ 0.
    const buyDay = history.find((h) => h.date === '2017-03-15')!;
    expect(buyDay.portfolioValue).toBeCloseTo(2500, 0);
    expect(Math.abs(buyDay.returnPct)).toBeLessThan(1);

    // Żaden dzień nie spada do poziomu samej gotówki (pozycja zawsze wyceniona).
    for (const h of history) {
      expect(h.portfolioValue, h.date).toBeGreaterThan(2000);
    }

    // Interpolacja między kupnem 20 a sprzedażą 22 → brak jednodniowego skoku
    // TWR (przed fixem: +2200 gotówki „znikąd" w dniu sprzedaży).
    for (let i = 1; i < history.length; i++) {
      const jump = Math.abs(history[i].twrPct - history[i - 1].twrPct);
      expect(jump, history[i].date).toBeLessThan(10);
    }

    // Metadane pokrycia dla banera.
    expect(unpricedInstruments).toEqual([
      {
        isin: 'BRIJU',
        name: 'BRIJU',
        firstHeld: '2017-03-15',
        lastHeld: '2017-09-15',
        mode: 'tx-price-fallback',
      },
    ]);

    // Syntetyk NIE idzie do sieci (goły paperName mógłby trafić w cudzy symbol).
    const yahooCalls = (yahoo.fetchYahooHistory as any).mock.calls.map((c: any[]) => c[0]);
    expect(yahooCalls).not.toContain('BRIJU');
  });

  it('pozycja otwarta ze stubem i pustą serią: flatline po cenie tx + metadane', async () => {
    const stub: TickerMapEntry = {
      isin: 'PLGTBCK00297',
      ticker: 'GETBACK',
      name: 'GETBACK',
      exchange: 'GPW',
      currency: 'PLN',
      priceSource: 'stooq',
    };
    const { history, unpricedInstruments } = await run(
      [tx('K', 50, 10, '2018-01-10', { isin: 'PLGTBCK00297', paperName: 'GETBACK' })],
      [deposit(1000, '2018-01-02')],
      new Map([['PLGTBCK00297', stub]]),
    );

    // Flatline: wartość = gotówka 500 + 50×10 przez cały okres.
    const last = history[history.length - 1];
    expect(last.portfolioValue).toBeCloseTo(1000, 0);
    expect(unpricedInstruments).toEqual([
      {
        isin: 'PLGTBCK00297',
        name: 'GETBACK',
        firstHeld: '2018-01-10',
        lastHeld: null,
        mode: 'tx-price-fallback',
      },
    ]);
  });

  it('syntetyk w walucie obcej: wycena przez kurs FX', async () => {
    // Kurs USDPLN=X = 4.0 przez cały okres; papier bez wpisu, notowany w USD.
    (yahoo.fetchYahooHistory as any).mockImplementation(async (symbol: string) => {
      if (symbol === 'USDPLN=X') {
        const out: Array<{ date: string; close: number }> = [];
        const cur = new Date('2024-01-01T00:00:00Z');
        while (cur <= new Date('2024-06-30T00:00:00Z')) {
          out.push({ date: cur.toISOString().slice(0, 10), close: 4.0 });
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
        return out;
      }
      return [];
    });

    const { history } = await run(
      [
        tx('K', 10, 100, '2024-02-01', {
          isin: 'DEADUS',
          paperName: 'DEADUS',
          currency: 'USD',
          paymentCurrency: 'USD',
          value: 1000,
          total: 1000,
        }),
      ],
      [deposit(5000, '2024-01-15')],
    );

    // 10 szt × 100 USD × 4.0 = 4000 PLN pozycji; gotówka: 5000 − 1000×4.0(payment USD
    // księgowane po kursie) — kluczowe: pozycja NIE jest zerem i ma wycenę w PLN.
    const afterBuy = history.find((h) => h.date >= '2024-02-01')!;
    expect(afterBuy.portfolioValue).toBeGreaterThan(4000);
  });

  it('kolizja paperName z tickerem żywego wpisu: syntetyk nie podpina się pod cudzą serię', async () => {
    // Żywy wpis XYZ (isin PL_XYZ) z realną serią 100; martwy papier o paperName
    // równym CUDZEMU tickerowi ('XYZ') — bez guardu wyceniałby się po 100.
    (yahoo.fetchYahooHistory as any).mockImplementation(async (symbol: string) => {
      if (symbol === 'XYZ') {
        const out: Array<{ date: string; close: number }> = [];
        const cur = new Date('2024-01-01T00:00:00Z');
        while (cur <= new Date('2024-06-30T00:00:00Z')) {
          out.push({ date: cur.toISOString().slice(0, 10), close: 100 });
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
        return out;
      }
      return [];
    });
    const alive: TickerMapEntry = {
      isin: 'PL_XYZ',
      ticker: 'XYZ',
      name: 'XYZ Żywy S.A.',
      exchange: 'OTHER',
      currency: 'PLN',
      priceSource: 'yahoo',
    };

    const { history } = await run(
      [
        tx('K', 10, 100, '2024-02-01', { isin: 'PL_XYZ', paperName: 'XYZ Żywy' }),
        // Martwy papier: 100 szt po 2 zł — paperName koliduje z tickerem żywego.
        tx('K', 100, 2, '2024-02-01', { isin: 'XYZDEAD', paperName: 'XYZ' }),
      ],
      [deposit(5000, '2024-01-15')],
      new Map([['PL_XYZ', alive]]),
    );

    // Gdyby syntetyk podpiął się pod serię XYZ (100 zł), pozycja 100 szt byłaby
    // warta 10 000 zł. Z guardem: 100 × 2 = 200 zł → wartość ≈ 5000 (cash-neutral).
    const afterBuy = history.find((h) => h.date >= '2024-02-01')!;
    expect(afterBuy.portfolioValue).toBeLessThan(6000);
    expect(afterBuy.portfolioValue).toBeCloseTo(5000, -1);
  });
});
