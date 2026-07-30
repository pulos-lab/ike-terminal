import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction, TickerMapEntry, OptionContract } from 'shared';

// Mock zewnętrznych fetcherów PRZED importem silnika
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

import {
  computeOpenPositions,
  computeClosedTrades,
  computePortfolioHistory,
} from '../portfolio-engine.js';
import type { CashOperation } from 'shared';
import * as yahoo from '../yahoo-finance.js';

/**
 * Opcje: pozycje krótkie (sell-to-open) i mnożnik kontraktu ×100.
 * Scenariusz z realnego wyciągu IBKR: DKNG 20MAY22 60.0 P wystawiony za 16.32,
 * premia 1632 USD (1 kontrakt × 16.32 × 100).
 */

const OPT_ISIN = 'OPT:DKNG220520P00060000';

const OPT_CONTRACT: OptionContract = {
  isin: OPT_ISIN,
  occTicker: 'DKNG220520P00060000',
  underlying: 'DKNG',
  expiry: '2022-05-20',
  strike: 60,
  optionType: 'P',
  multiplier: 100,
  currency: 'USD',
};

const OPT_ENTRY: TickerMapEntry = {
  isin: OPT_ISIN,
  ticker: 'DKNG220520P00060000',
  name: 'DKNG 20MAY22 60.0 P',
  exchange: 'OTHER',
  currency: 'USD',
  priceSource: 'yahoo',
};

function optTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    date: '2021-11-04T10:05:18',
    paperName: 'DKNG 20MAY22 60.0 P',
    isin: OPT_ISIN,
    quantity: 1,
    side: 'S',
    price: 16.32,
    value: 1632,
    commission: 0.68,
    total: 1631.32,
    currency: 'USD',
    paymentCurrency: 'USD',
    category: 'option',
    source: 'ibkr',
    ...overrides,
  };
}

const optionContracts = new Map([[OPT_ISIN, OPT_CONTRACT]]);
const tickerMap = new Map([[OPT_ISIN, OPT_ENTRY]]);
const engineOpts = { skipSplitDetection: true, optionContracts };

// Wariant z PRZYSZŁĄ datą wygaśnięcia — do testów WYCENY otwartej pozycji (opcja po terminie
// jest teraz auto-domykana, więc pozycja pozostaje otwarta tylko gdy termin jeszcze nie minął).
const OPT_ISIN_FUT = 'OPT:DKNG271217P00060000';
const OPT_CONTRACT_FUT: OptionContract = {
  ...OPT_CONTRACT,
  isin: OPT_ISIN_FUT,
  occTicker: 'DKNG271217P00060000',
  expiry: '2027-12-17',
};
const OPT_ENTRY_FUT: TickerMapEntry = {
  ...OPT_ENTRY,
  isin: OPT_ISIN_FUT,
  ticker: 'DKNG271217P00060000',
  name: 'DKNG 17DEC27 60.0 P',
};
const optionContractsFut = new Map([[OPT_ISIN_FUT, OPT_CONTRACT_FUT]]);
const tickerMapFut = new Map([[OPT_ISIN_FUT, OPT_ENTRY_FUT]]);
const engineOptsFut = { skipSplitDetection: true, optionContracts: optionContractsFut };
const optTxFut = (o: Partial<Transaction> = {}): Transaction =>
  optTx({ isin: OPT_ISIN_FUT, paperName: 'DKNG 17DEC27 60.0 P', ...o });

describe('computeOpenPositions — otwarte pozycje krótkie opcji', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (yahoo.fetchFxRate as any).mockResolvedValue(4.0); // USDPLN
  });

  it('sell-to-open bez pokrycia → pozycja z ujemną ilością i ujemną wartością (zobowiązanie)', async () => {
    (yahoo.fetchYahooPrice as any).mockResolvedValue({ price: 10.0, previousClose: 11.0 });
    const { positions, totalValuePln } = await computeOpenPositions(
      [optTxFut()],
      tickerMapFut,
      [],
      undefined,
      engineOptsFut,
    );
    expect(positions).toHaveLength(1);
    const pos = positions[0];
    expect(pos.shares).toBe(-1);
    // Wartość: -1 × 10 × 100 = -1000 USD = -4000 PLN
    expect(pos.currentValue).toBeCloseTo(-1000, 2);
    expect(pos.currentValuePln).toBeCloseTo(-4000, 2);
    // Koszt bazowy = otrzymana premia (ujemny): -1632 USD = -6528 PLN
    // P/L = -4000 - (-6528) = +2528 PLN (premia stopniała → zysk wystawcy)
    expect(pos.profitLossPln).toBeCloseTo(2528, 2);
    // P/L% liczony od |premii|: 2528 / 6528 ≈ 38.7%
    expect(pos.profitLossPct).toBeCloseTo(38.73, 1);
    // Średnia cena otwarcia = premia per akcja
    expect(pos.avgBuyPrice).toBeCloseTo(16.32, 2);
    expect(pos.optionMeta).toMatchObject({ underlying: 'DKNG', strike: 60, optionType: 'P' });
    expect(pos.expiryPassed).toBeFalsy(); // 2027-12-17 > dziś → otwarta, nie auto-domknięta
    // Ujemna wartość pomniejsza total
    expect(totalValuePln).toBeCloseTo(-4000, 2);
  });

  it('long opcja: wartość i koszt z mnożnikiem ×100', async () => {
    (yahoo.fetchYahooPrice as any).mockResolvedValue({ price: 8.0, previousClose: 8.0 });
    const { positions } = await computeOpenPositions(
      [optTxFut({ side: 'K', price: 6.32, value: 632, total: 632.67, commission: 0.67 })],
      tickerMapFut,
      [],
      undefined,
      engineOptsFut,
    );
    const pos = positions[0];
    expect(pos.shares).toBe(1);
    expect(pos.currentValue).toBeCloseTo(800, 2); // 1 × 8 × 100
    expect(pos.currentValuePln).toBeCloseTo(3200, 2);
    expect(pos.profitLossPln).toBeCloseTo(3200 - 632 * 4, 2);
  });

  it('short odkupiony (buy-to-close) znika z otwartych pozycji', async () => {
    (yahoo.fetchYahooPrice as any).mockResolvedValue({ price: 10.0, previousClose: null });
    const { positions } = await computeOpenPositions(
      [
        optTx(),
        optTx({ date: '2022-03-23T16:20:00', side: 'K', price: 5.0, value: 500, total: 500 }),
      ],
      tickerMap,
      [],
      undefined,
      engineOpts,
    );
    expect(positions).toHaveLength(0);
  });

  it('fallback bez ticker_map: wycena po ostatniej transakcji, short nadal ujemny', async () => {
    const { positions } = await computeOpenPositions([optTxFut()], new Map(), [], undefined, {
      skipSplitDetection: true,
      optionContracts: optionContractsFut,
    });
    const pos = positions[0];
    expect(pos.priceManual).toBe(true);
    expect(pos.shares).toBe(-1);
    expect(pos.currentValue).toBeCloseTo(-1632, 2); // -1 × 16.32 × 100
    expect(pos.optionMeta?.underlying).toBe('DKNG');
  });

  it('brak live premii opcji → wycena po wartości wewnętrznej z LIVE kursu bazowego', async () => {
    // fetchYahooPrice zwraca null dla OCC (brak notowań premii), ale ma kurs bazowego DKNG.
    (yahoo.fetchYahooPrice as any).mockImplementation((t: string) =>
      t === 'DKNG' ? { price: 45, previousClose: 46 } : null,
    );
    const { positions } = await computeOpenPositions(
      [optTxFut()],
      tickerMapFut,
      [],
      undefined,
      engineOptsFut,
    );
    const pos = positions[0];
    // Put 60: intrinsic = max(60 − 45, 0) = 15 → wartość -1 × 15 × 100 = -1500 USD = -6000 PLN
    expect(pos.priceManual).toBe(true);
    expect(pos.currentValue).toBeCloseTo(-1500, 2);
    expect(pos.currentValuePln).toBeCloseTo(-6000, 2);
  });
});

describe('computeClosedTrades — round-tripy opcyjne z mnożnikiem', () => {
  it('short → wygaśnięcie po 0: zysk = premia − prowizja', () => {
    const trades = computeClosedTrades(
      [
        optTx(),
        optTx({
          date: '2022-05-20T16:20:00',
          side: 'K',
          price: 0,
          value: 0,
          total: 0,
          commission: 0,
        }),
      ],
      tickerMap,
      [],
      [],
      [],
      optionContracts,
    );
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.isShort).toBe(true);
    // P/L = (16.32 − 0) × 1 × 100 − 0.68 = 1631.32
    expect(t.profitLoss).toBeCloseTo(1631.32, 2);
    expect(t.category).toBe('option');
  });

  it('long → sprzedaż: P/L z mnożnikiem ×100', () => {
    const trades = computeClosedTrades(
      [
        optTx({ side: 'K', price: 2.25, value: 225, total: 225.27, commission: 0.27 }),
        optTx({
          date: '2021-12-16T15:40:45',
          side: 'S',
          price: 3.85,
          value: 385,
          total: 384.38,
          commission: 0.62,
        }),
      ],
      tickerMap,
      [],
      [],
      [],
      optionContracts,
    );
    expect(trades).toHaveLength(1);
    // P/L = (3.85 − 2.25) × 100 − 0.27 − 0.62 = 159.11
    expect(trades[0].profitLoss).toBeCloseTo(159.11, 2);
    expect(trades[0].isShort).toBeFalsy();
  });
});

describe('computePortfolioHistory — wycena opcji wartością wewnętrzną z kursu bazowego', () => {
  // Buduje dzienną serię {date, close} o stałej cenie w zakresie [from, to].
  function flatSeries(
    from: string,
    to: string,
    close: number,
  ): Array<{ date: string; close: number }> {
    const out: Array<{ date: string; close: number }> = [];
    const cur = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    while (cur <= end) {
      out.push({ date: cur.toISOString().slice(0, 10), close });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }

  const deposit: CashOperation = {
    date: '2021-11-01T00:00:00',
    operationType: 'deposit',
    description: 'wpłata',
    amount: 10000,
    currency: 'PLN',
  } as CashOperation;

  // Długa pozycja PLN — utrzymuje historię „żywą" do dziś (pętla urywa się na ostatniej
  // aktywności, gdy nie ma pozycji DŁUGICH). Jej wartość jest stała → nie wpływa na różnicę
  // między biegami ITM/OTM, która izoluje wyłącznie wkład opcji.
  const XYZ_ENTRY: TickerMapEntry = {
    isin: 'PL_XYZ',
    ticker: 'XYZ',
    name: 'XYZ',
    exchange: 'OTHER',
    currency: 'PLN',
    priceSource: 'yahoo',
  };
  function xyzBuy(): Transaction {
    return {
      date: '2021-11-04T10:00:00',
      paperName: 'XYZ',
      isin: 'PL_XYZ',
      quantity: 10,
      side: 'K',
      price: 10,
      value: 100,
      commission: 0,
      total: 100,
      currency: 'PLN',
      paymentCurrency: 'PLN',
      category: 'stock',
      source: 'ibkr',
    };
  }
  const histTickerMap = new Map<string, TickerMapEntry>([
    [OPT_ISIN, OPT_ENTRY],
    ['PL_XYZ', XYZ_ENTRY],
  ]);

  async function runWithUnderlying(underlyingClose: number) {
    (yahoo.fetchYahooHistory as any).mockImplementation(async (ticker: string) => {
      if (ticker === 'DKNG') return flatSeries('2021-11-01', '2022-05-20', underlyingClose);
      if (ticker === 'USDPLN=X') return flatSeries('2021-11-01', '2022-05-20', 4);
      if (ticker === 'XYZ') return flatSeries('2021-11-01', '2026-12-31', 10);
      return []; // OCC opcji → 404 (brak historii premii)
    });
    const { history } = await computePortfolioHistory(
      [optTx(), xyzBuy()], // short DKNG 60 P (otwarty) + długa XYZ (trzyma historię)
      [deposit],
      histTickerMap,
      '',
      'none',
      undefined,
      undefined,
      [],
      'PLN',
      [],
      optionContracts,
    );
    return history.find((h) => h.date === '2021-12-01')!;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('short PUT ITM wyceniany po intrinsic (floor), OTM po ostatniej znanej premii', async () => {
    const itm = await runWithUnderlying(30); // put 60: intrinsic 30 > premia 16.32 → 30
    const otm = await runWithUnderlying(100); // put 60: intrinsic 0 → seed premii z tx 16.32
    expect(itm).toBeTruthy();
    expect(otm).toBeTruthy();
    // Różnica wartości portfela = wyłącznie wkład opcji (cash identyczny w obu biegach):
    // ITM: -1 × 30 × 100 × 4 = -12000 PLN (martwa premia 16.32 NIE zaniża zobowiązania);
    // OTM: -1 × 16.32 × 100 × 4 = -6528 PLN (ostatnia premia, nie intrinsic 0).
    expect(otm.portfolioValue - itm.portfolioValue).toBeCloseTo(12000 - 6528, 0);
  });

  it('historia premii OCC z Yahoo: OTM wyceniana po premii (forward-fill), nie po intrinsic 0', async () => {
    // Long put 60 przy bazowym 100 (intrinsic 0). Yahoo zwraca rzadką serię premii —
    // wartość portfela ma podążać za premią, a dni bez obrotu brać ostatnią znaną premię.
    (yahoo.fetchYahooHistory as any).mockImplementation(async (ticker: string) => {
      if (ticker === 'DKNG') return flatSeries('2021-11-01', '2022-05-20', 100);
      if (ticker === 'USDPLN=X') return flatSeries('2021-11-01', '2022-05-20', 4);
      if (ticker === 'XYZ') return flatSeries('2021-11-01', '2026-12-31', 10);
      if (ticker === 'DKNG220520P00060000')
        return [
          { date: '2021-11-30', close: 12 },
          { date: '2021-12-03', close: 8 }, // luka 12-01/12-02 → forward-fill 12
        ];
      return [];
    });
    const { history } = await computePortfolioHistory(
      [optTx({ side: 'K' }), xyzBuy()], // long 1 kontrakt + długa XYZ (trzyma historię)
      [deposit],
      histTickerMap,
      '',
      'none',
      undefined,
      undefined,
      [],
      'PLN',
      [],
      optionContracts,
    );
    const at = (d: string) => history.find((h) => h.date === d)!;
    // 1 kontrakt × premia × 100 × USDPLN 4: 11-30 → 4800, 12-01/02 (bez obrotu) → nadal 4800,
    // 12-03 → 3200. Różnice dzienne izolują wkład opcji (reszta portfela stała).
    expect(at('2021-12-01').portfolioValue - at('2021-11-30').portfolioValue).toBeCloseTo(0, 0);
    expect(at('2021-12-03').portfolioValue - at('2021-12-01').portfolioValue).toBeCloseTo(
      (8 - 12) * 100 * 4,
      0,
    );
  });

  it('floor intrinsic: głęboko-ITM short nie korzysta z nieaktualnej (niższej) premii', async () => {
    // Short put 60, bazowy spada do 30 → intrinsic 30. Ostatnia premia z obrotu to 20
    // (sprzed spadku) — wycena MUSI wziąć max(intrinsic, premia) = 30, nie martwe 20.
    (yahoo.fetchYahooHistory as any).mockImplementation(async (ticker: string) => {
      if (ticker === 'DKNG') return flatSeries('2021-11-01', '2022-05-20', 30);
      if (ticker === 'USDPLN=X') return flatSeries('2021-11-01', '2022-05-20', 4);
      if (ticker === 'XYZ') return flatSeries('2021-11-01', '2026-12-31', 10);
      if (ticker === 'DKNG220520P00060000') return [{ date: '2021-11-05', close: 20 }];
      return [];
    });
    const { history } = await computePortfolioHistory(
      [optTx(), xyzBuy()], // short DKNG 60 P
      [deposit],
      histTickerMap,
      '',
      'none',
      undefined,
      undefined,
      [],
      'PLN',
      [],
      optionContracts,
    );
    const nov30 = history.find((h) => h.date === '2021-11-30')!;
    const cashOnly = history.find((h) => h.date === '2021-11-03')!; // przed openem shorta
    // Wkład opcji 2021-11-30 = −1 × 30 × 100 × 4 = −12000 (intrinsic), nie −8000 (premia).
    // XYZ kupione 11-04 za 100 PLN (cash-neutralne przy wycenie = cenie kupna).
    expect(nov30.portfolioValue - cashOnly.portfolioValue).toBeCloseTo(-12000 + 1631.32 * 4, 0);
  });

  it('opcja OTM (intrinsic 0) nie skacze w luki weekendowe mimo transakcji nie po kolei', async () => {
    // Regresja: seria bazowego bez weekendów + transakcje w kolejności [sprzedaż, kupno]
    // (jak z DB). Wcześniej forward-fill z `|| 0` podmieniał zerowy intrinsic na cenę
    // sprzedaży (txPriceByTicker brał pierwszą Z BRZEGU, nie najwcześniejszą) → widmowy
    // skok wyceny w soboty/niedziele.
    function weekdaySeries(from: string, to: string, close: number) {
      const out: Array<{ date: string; close: number }> = [];
      const cur = new Date(from + 'T00:00:00Z');
      const end = new Date(to + 'T00:00:00Z');
      while (cur <= end) {
        const dow = cur.getUTCDay();
        if (dow !== 0 && dow !== 6) out.push({ date: cur.toISOString().slice(0, 10), close });
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
      return out;
    }
    (yahoo.fetchYahooHistory as any).mockImplementation(async (ticker: string) => {
      if (ticker === 'DKNG') return weekdaySeries('2021-11-01', '2022-05-20', 100); // put 60 OTM → 0
      if (ticker === 'USDPLN=X') return weekdaySeries('2021-11-01', '2022-05-20', 4);
      if (ticker === 'XYZ') return weekdaySeries('2021-11-01', '2026-12-31', 10);
      return [];
    });
    const { history } = await computePortfolioHistory(
      // sprzedaż PRZED kupnem (odwzorowanie kolejności z getAllTransactions) + długa XYZ
      [
        optTx({
          date: '2022-05-20T16:00:00',
          side: 'K',
          price: 0,
          value: 0,
          total: 0,
          commission: 0,
        }),
        optTx(), // sell-to-open 2021-11-04
        xyzBuy(),
      ],
      [deposit],
      histTickerMap,
      '',
      'none',
      undefined,
      undefined,
      [],
      'PLN',
      [],
      optionContracts,
    );
    const fri = history.find((h) => h.date === '2021-12-03')!; // piątek
    const sat = history.find((h) => h.date === '2021-12-04')!; // sobota (luka)
    const mon = history.find((h) => h.date === '2021-12-06')!; // poniedziałek
    expect(sat.portfolioValue).toBeCloseTo(fri.portfolioValue, 2);
    expect(mon.portfolioValue).toBeCloseTo(fri.portfolioValue, 2);
  });
});

describe('computePortfolioHistory — blip dnia przypisania (akcje po strike vs rynek)', () => {
  const XYZ: TickerMapEntry = {
    isin: 'PL_XYZ',
    ticker: 'XYZ',
    name: 'XYZ',
    exchange: 'OTHER',
    currency: 'PLN',
    priceSource: 'yahoo',
  };
  const tm = new Map([['PL_XYZ', XYZ]]);
  function daily(from: string, to: string, close: number) {
    const out: Array<{ date: string; close: number }> = [];
    const cur = new Date(from + 'T00:00:00Z');
    const end = new Date(to + 'T00:00:00Z');
    while (cur <= end) {
      out.push({ date: cur.toISOString().slice(0, 10), close });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out;
  }
  const dep: CashOperation = {
    date: '2024-01-01T00:00:00',
    operationType: 'deposit',
    description: '',
    amount: 30000,
    currency: 'PLN',
  } as CashOperation;

  beforeEach(() => {
    vi.clearAllMocks();
    (yahoo.fetchYahooHistory as any).mockImplementation(async (t: string) =>
      t === 'XYZ' ? daily('2024-01-01', '2026-12-31', 96) : [],
    );
  });

  it('akcje z przypisania (optionEvent) wyceniane po rynku w dniu tx — brak jednodniowego skoku', async () => {
    // Kupno 100 XYZ po strike 230 (rynek 96) — bez fixu nadpisanie ceny dnia dawało
    // 100×230 tylko w dniu tx (skok), nazajutrz 100×96. Ze znacznikiem: zawsze rynek.
    const assign: Transaction = {
      date: '2024-02-01T16:20:00',
      paperName: 'XYZ',
      isin: 'PL_XYZ',
      quantity: 100,
      side: 'K',
      price: 230, // strike
      value: 23000,
      commission: 0,
      total: 23000,
      currency: 'PLN',
      paymentCurrency: 'PLN',
      category: 'stock',
      source: 'ibkr',
      optionEvent: 'assignment',
    };
    const { history } = await computePortfolioHistory(
      [assign],
      [dep],
      tm,
      '',
      'none',
      undefined,
      undefined,
      [],
      'PLN',
      [],
      undefined,
    );
    const d1 = history.find((h) => h.date === '2024-02-01')!;
    const d2 = history.find((h) => h.date === '2024-02-02')!;
    // Dzień przypisania ≈ dzień następny (oba: 7000 gotówki + 100×96 = 16600); brak skoku do 30000.
    expect(d1.portfolioValue).toBeCloseTo(16600, 0);
    expect(d1.portfolioValue).toBeCloseTo(d2.portfolioValue, 0);
  });
});
