import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildFxToPlnLookup,
  convertClosedTradesToPln,
  summarizeDividendsByCurrency,
  type FxToPlnLookup,
} from '../fx-history.js';
import type { ClosedTrade } from 'shared';

// Mock sieci: fetchYahooHistory czyta serie z mapy per symbol (pusta = brak danych).
const yahooMock = vi.hoisted(() => ({
  series: {} as Record<string, Array<{ date: string; close: number }>>,
  calls: [] as string[],
}));
vi.mock('../yahoo-finance.js', () => ({
  fetchYahooHistory: vi.fn(async (symbol: string) => {
    yahooMock.calls.push(symbol);
    return yahooMock.series[symbol] ?? [];
  }),
}));

function trade(
  overrides: Partial<ClosedTrade> & {
    currency: string;
    profitLoss: number;
  },
): ClosedTrade {
  return {
    paperName: overrides.paperName ?? 'TEST',
    isin: overrides.isin ?? 'US0000000000',
    ticker: overrides.ticker ?? 'TEST',
    quantity: overrides.quantity ?? 10,
    buyDate: overrides.buyDate ?? '2025-01-10',
    buyPrice: overrides.buyPrice ?? 100,
    buyCommission: overrides.buyCommission ?? 0,
    sellDate: overrides.sellDate ?? '2025-03-10',
    sellPrice: overrides.sellPrice ?? 110,
    sellCommission: overrides.sellCommission ?? 0,
    profitLossPct: overrides.profitLossPct ?? 0,
    holdingDays: overrides.holdingDays ?? 59,
    sellTransactionId: overrides.sellTransactionId ?? 1,
    sellSource: overrides.sellSource ?? 'mbank',
    ...overrides,
  };
}

/** Stały kurs per (waluta, prefiks daty) — wystarcza do testów dwóch nóg. */
function fxStub(table: Record<string, number>): FxToPlnLookup {
  return (currency, date) => {
    if (currency.toUpperCase() === 'PLN') return 1;
    const key = `${currency}|${date.slice(0, 10)}`;
    return table[key] ?? null;
  };
}

describe('convertClosedTradesToPln', () => {
  it('PLN: przepisuje profitLoss i costBasis bez zmian, kursy = 1', () => {
    const t = trade({ currency: 'PLN', profitLoss: 123.45, costBasis: 1000 });
    convertClosedTradesToPln([t], fxStub({}));
    expect(t.profitLossPln).toBe(123.45);
    expect(t.costBasisPln).toBe(1000);
    expect(t.fxRateOpen).toBe(1);
    expect(t.fxRateClose).toBe(1);
  });

  it('long USD: każda noga po kursie z jej dnia (efekt walutowy na kapitale)', () => {
    // 100 USD kupione @4.00, sprzedane za 110 USD @4.50, bez prowizji:
    // realny wynik = 110×4.50 − 100×4.00 = 495 − 400 = 95 PLN (nie 10×4.50 = 45)
    const t = trade({
      currency: 'USD',
      quantity: 1,
      buyPrice: 100,
      sellPrice: 110,
      profitLoss: 10,
      costBasis: 100,
    });
    convertClosedTradesToPln([t], fxStub({ 'USD|2025-01-10': 4.0, 'USD|2025-03-10': 4.5 }));
    expect(t.profitLossPln).toBeCloseTo(95, 6);
    expect(t.costBasisPln).toBeCloseTo(400, 6);
    expect(t.fxRateOpen).toBe(4.0);
    expect(t.fxRateClose).toBe(4.5);
  });

  it('long USD z prowizjami: prowizja kupna po kursie otwarcia, sprzedaży po kursie zamknięcia', () => {
    // buy 10×100 + 5 comm; sell 10×110 − 7 comm
    // PL natywny = 1100 − 1000 − 5 − 7 = 88; costBasis = 1005
    // PLN = (1100 − 7)×4.5 − 1005×4.0 = 4918.5 − 4020 = 898.5
    const t = trade({
      currency: 'USD',
      quantity: 10,
      buyPrice: 100,
      buyCommission: 5,
      sellPrice: 110,
      sellCommission: 7,
      profitLoss: 88,
      costBasis: 1005,
    });
    convertClosedTradesToPln([t], fxStub({ 'USD|2025-01-10': 4.0, 'USD|2025-03-10': 4.5 }));
    expect(t.profitLossPln).toBeCloseTo(898.5, 6);
  });

  it('przy kursie 1:1 wynik PLN = profitLoss (long i short)', () => {
    const fx = fxStub({
      'USD|2025-01-10': 1,
      'USD|2025-03-10': 1,
    });
    const long = trade({
      currency: 'USD',
      quantity: 10,
      buyPrice: 100,
      buyCommission: 5,
      sellPrice: 110,
      sellCommission: 7,
      profitLoss: 88,
      costBasis: 1005,
      fees: [{ type: 'fee', amount: 3, description: 'exchange fee' }],
    });
    // pl z opłatą: 1100 − 1000 − 5 − 7 − 3 = 85
    long.profitLoss = 85;
    // short: open 10×110 − 7 comm, cover 10×100 + 5 comm → pl = 1100 − 1000 − 7 − 5 = 88
    const short = trade({
      currency: 'USD',
      quantity: 10,
      buyPrice: 110, // cena otwarcia shorta
      buyCommission: 7, // prowizja otwarcia
      sellPrice: 100, // cena odkupienia
      sellCommission: 5,
      profitLoss: 88,
      costBasis: 1107, // 1100 + 7
      isShort: true,
    });
    convertClosedTradesToPln([long, short], fx);
    expect(long.profitLossPln).toBeCloseTo(85, 6);
    expect(short.profitLossPln).toBeCloseTo(88, 6);
  });

  it('short USD: gotówka z otwarcia po kursie otwarcia, koszt odkupu po kursie zamknięcia', () => {
    // open short 10×110 @4.00 (netto 1100), cover 10×100 @4.50 (koszt 1000)
    // PLN = 1100×4.0 − 1000×4.5 = 4400 − 4500 = −100 (mimo zysku 100 USD natywnie!)
    const t = trade({
      currency: 'USD',
      quantity: 10,
      buyPrice: 110,
      sellPrice: 100,
      profitLoss: 100,
      costBasis: 1100,
      isShort: true,
    });
    convertClosedTradesToPln([t], fxStub({ 'USD|2025-01-10': 4.0, 'USD|2025-03-10': 4.5 }));
    expect(t.profitLossPln).toBeCloseTo(-100, 6);
  });

  it('CFD: cały wynik po kursie zamknięcia (wynik materializuje się w walucie konta)', () => {
    const t = trade({
      currency: 'USD',
      category: 'cfd',
      profitLoss: 50,
      costBasis: 2000,
    });
    convertClosedTradesToPln([t], fxStub({ 'USD|2025-01-10': 4.0, 'USD|2025-03-10': 4.5 }));
    expect(t.profitLossPln).toBeCloseTo(225, 6);
    expect(t.costBasisPln).toBeCloseTo(9000, 6);
  });

  it('brak kursu lub costBasis: pola PLN zostają niewypełnione', () => {
    const noFx = trade({ currency: 'NOK', profitLoss: 10, costBasis: 100 });
    const noBasis = trade({ currency: 'USD', profitLoss: 10 });
    convertClosedTradesToPln(
      [noFx, noBasis],
      fxStub({ 'USD|2025-01-10': 4.0, 'USD|2025-03-10': 4.5 }),
    );
    expect(noFx.profitLossPln).toBeUndefined();
    expect(noFx.costBasisPln).toBeUndefined();
    expect(noBasis.profitLossPln).toBeUndefined();
  });

  it('GBX: kurs GBP × 0.01 (ceny w pensach)', () => {
    // 100 szt × 500 GBX = 50 000 GBX = 500 GBP; kupno i sprzedaż @5.00 GBPPLN
    const t = trade({
      currency: 'GBX',
      quantity: 100,
      buyPrice: 500,
      sellPrice: 550,
      profitLoss: 5000, // GBX
      costBasis: 50000, // GBX
    });
    const fx: FxToPlnLookup = (currency, date) => {
      if (currency.toUpperCase() === 'PLN') return 1;
      if (currency.toUpperCase() === 'GBX') return 5.0 * 0.01;
      return null;
    };
    convertClosedTradesToPln([t], fx);
    // 5000 GBX = 50 GBP → 250 PLN; costBasis 50 000 GBX = 500 GBP → 2500 PLN
    expect(t.profitLossPln).toBeCloseTo(250, 6);
    expect(t.costBasisPln).toBeCloseTo(2500, 6);
  });
});

describe('summarizeDividendsByCurrency', () => {
  const div = (amount: number, currency: string, date: string) => ({ amount, currency, date });

  it('pusta lista → zera', () => {
    const fx: FxToPlnLookup = () => 1;
    expect(summarizeDividendsByCurrency([], fx)).toEqual({
      totalPln: 0,
      totalPlnApprox: false,
      byCurrency: [],
    });
  });

  it('sumuje per waluta i przelicza po kursie z dnia wypłaty (PLN 1:1)', () => {
    const fx = fxStub({
      'USD|2026-03-30': 4.0,
      'USD|2026-05-29': 3.5,
      'EUR|2026-03-31': 4.3,
    });
    const out = summarizeDividendsByCurrency(
      [
        div(100, 'PLN', '2025-10-31'),
        div(10, 'USD', '2026-03-30'), // → 40 PLN
        div(20, 'USD', '2026-05-29'), // → 70 PLN
        div(5, 'EUR', '2026-03-31'), // → 21.5 PLN
      ],
      fx,
    );
    expect(out.totalPlnApprox).toBe(false);
    expect(out.totalPln).toBeCloseTo(231.5, 6); // 100 + 40 + 70 + 21.5
    // posortowane malejąco po PLN: PLN(100) > USD(110) ... właściwie USD ma większe PLN
    const byCur = Object.fromEntries(out.byCurrency.map((c) => [c.currency, c]));
    expect(byCur.USD).toMatchObject({ amount: 30, pln: 110 });
    expect(byCur.EUR).toMatchObject({ amount: 5, pln: 21.5 });
    expect(byCur.PLN).toMatchObject({ amount: 100, pln: 100 });
    // sort: USD(110) > PLN(100) > EUR(21.5)
    expect(out.byCurrency.map((c) => c.currency)).toEqual(['USD', 'PLN', 'EUR']);
  });

  it('waluta bez ŻADNEGO kursu → pln=null, approx=true, pomijana w sumie', () => {
    const fx = fxStub({ 'USD|2026-01-02': 4.0 });
    const out = summarizeDividendsByCurrency(
      [div(10, 'USD', '2026-01-02'), div(2.24, 'CAD', '2026-03-27')],
      fx,
    );
    expect(out.totalPln).toBeCloseTo(40, 6); // tylko USD
    expect(out.totalPlnApprox).toBe(true);
    const cad = out.byCurrency.find((c) => c.currency === 'CAD');
    expect(cad).toMatchObject({ amount: 2.24, pln: null });
    expect(out.byCurrency[out.byCurrency.length - 1].currency).toBe('CAD'); // null na końcu
  });

  it('część rekordów waluty bez kursu → suma częściowa + approx=true', () => {
    const fx = fxStub({ 'USD|2026-01-02': 4.0 }); // brak kursu dla 2026-02-02
    const out = summarizeDividendsByCurrency(
      [div(10, 'USD', '2026-01-02'), div(10, 'USD', '2026-02-02')],
      fx,
    );
    const usd = out.byCurrency.find((c) => c.currency === 'USD')!;
    expect(usd.amount).toBe(20); // oryginał: pełna suma
    expect(usd.pln).toBeCloseTo(40, 6); // PLN: tylko rekord z kursem
    expect(out.totalPlnApprox).toBe(true);
  });

  it('normalizuje wielkość liter waluty (usd == USD)', () => {
    const fx = fxStub({ 'USD|2026-01-02': 4.0 });
    const out = summarizeDividendsByCurrency(
      [div(10, 'usd', '2026-01-02'), div(5, 'USD', '2026-01-02')],
      fx,
    );
    expect(out.byCurrency).toHaveLength(1);
    expect(out.byCurrency[0]).toMatchObject({ currency: 'USD', amount: 15, pln: 60 });
  });
});

describe('buildFxToPlnLookup — kurs krzyżowy przez USD', () => {
  beforeEach(() => {
    yahooMock.series = {};
    yahooMock.calls = [];
  });

  it('szczątkowa seria xxxPLN=X → fallback per-data na xxxUSD=X × USDPLN=X (case CADPLN)', async () => {
    yahooMock.series = {
      'CADPLN=X': [{ date: '2026-05-05', close: 2.661 }], // 1 punkt — jak realny Yahoo
      'CADUSD=X': [{ date: '2026-03-27', close: 0.7 }],
      'USDPLN=X': [{ date: '2026-03-27', close: 4.0 }],
    };
    const fx = await buildFxToPlnLookup(['CAD'], '2026-01-01');
    expect(fx('CAD', '2026-03-27')).toBeCloseTo(2.8, 6); // 0.7 × 4.0
  });

  it('data pokryta przez bezpośrednią serię ma priorytet nad kursem krzyżowym', async () => {
    yahooMock.series = {
      'CADPLN=X': [{ date: '2026-05-05', close: 2.661 }],
      'CADUSD=X': [
        { date: '2026-03-27', close: 0.7 },
        { date: '2026-05-05', close: 0.75 },
      ],
      'USDPLN=X': [
        { date: '2026-03-27', close: 4.0 },
        { date: '2026-05-05', close: 4.0 },
      ],
    };
    const fx = await buildFxToPlnLookup(['CAD'], '2026-01-01');
    expect(fx('CAD', '2026-05-06')).toBeCloseTo(2.661, 6); // direct (lookback 1 dzień), nie 3.0
  });

  it('pełna seria bezpośrednia → kurs krzyżowy w ogóle nie jest pobierany', async () => {
    yahooMock.series = {
      'EURPLN=X': [
        { date: '2026-03-02', close: 4.3 },
        { date: '2026-03-10', close: 4.31 },
      ],
    };
    const fx = await buildFxToPlnLookup(['EUR'], '2026-03-01');
    expect(fx('EUR', '2026-03-10')).toBeCloseTo(4.31, 6);
    expect(yahooMock.calls).not.toContain('EURUSD=X');
    expect(yahooMock.calls).not.toContain('USDPLN=X');
  });

  it('GBX przez kurs krzyżowy: GBPUSD × USDPLN × 0.01', async () => {
    yahooMock.series = {
      'GBPUSD=X': [{ date: '2026-04-10', close: 1.3 }],
      'USDPLN=X': [{ date: '2026-04-10', close: 4.0 }],
    };
    const fx = await buildFxToPlnLookup(['GBX'], '2026-04-01');
    expect(fx('GBX', '2026-04-10')).toBeCloseTo(0.052, 6); // 1.3 × 4.0 × 0.01
  });

  it('brak obu nóg → null (waluta nieprzeliczalna)', async () => {
    yahooMock.series = { 'USDPLN=X': [{ date: '2026-04-10', close: 4.0 }] };
    const fx = await buildFxToPlnLookup(['NOK'], '2026-04-01');
    expect(fx('NOK', '2026-04-10')).toBeNull();
  });
});
