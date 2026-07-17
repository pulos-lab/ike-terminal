import { describe, it, expect } from 'vitest';
import { computeYieldOnCost } from '../yield-on-cost';
import type { DividendRecord, Position } from 'shared';

const TODAY = '2026-07-17';

function position(over: Partial<Position>): Position {
  return {
    paperName: 'Testowa SA',
    isin: 'PL0000000001',
    ticker: 'TST.WA',
    shares: 10,
    avgBuyPrice: 100,
    totalCommission: 0,
    currentPrice: 120,
    currentValue: 1200,
    currentValuePln: 1200,
    profitLoss: 200,
    profitLossPln: 200, // koszt PLN = 1200 − 200 = 1000
    profitLossPct: 20,
    currency: 'PLN',
    weight: 100,
    dailyChangePct: null,
    ...over,
  };
}

function dividend(over: Partial<DividendRecord>): DividendRecord {
  return {
    id: 1,
    date: '2026-05-01',
    ticker: 'TST',
    description: 'test',
    amount: 50,
    currency: 'PLN',
    source: 'manual',
    amountPln: 50,
    isin: 'PL0000000001',
    ...over,
  };
}

describe('computeYieldOnCost', () => {
  it('YoC pozycji = dywidendy 12M / koszt (currentValuePln − profitLossPln)', () => {
    const s = computeYieldOnCost([dividend({})], [position({})], TODAY)!;
    expect(s.totalCostPln).toBe(1000);
    expect(s.totalDividends12mPln).toBe(50);
    expect(s.totalYocPct).toBeCloseTo(5, 10);
    expect(s.positions[0].yocPct).toBeCloseTo(5, 10);
  });

  it('dywidendy starsze niż 12M i z przyszłości poza oknem', () => {
    const s = computeYieldOnCost(
      [
        dividend({ id: 1, date: '2025-07-01', amountPln: 999 }), // za stara (>365 dni)
        dividend({ id: 2, date: '2026-08-01', amountPln: 999 }), // przyszłość
        dividend({ id: 3, date: '2025-07-20', amountPln: 30 }), // w oknie
      ],
      [position({})],
      TODAY,
    )!;
    expect(s.totalDividends12mPln).toBe(30);
    expect(s.approx).toBe(false);
  });

  it('pozycje bez dywidend rozwadniają YoC portfela (mianownik = koszt wszystkich)', () => {
    const s = computeYieldOnCost(
      [dividend({})],
      [
        position({}),
        position({
          isin: 'PL0000000002',
          ticker: 'BEZ.WA',
          currentValuePln: 3200,
          profitLossPln: 200,
        }),
      ],
      TODAY,
    )!;
    // 50 / (1000 + 3000) = 1.25%
    expect(s.totalYocPct).toBeCloseTo(1.25, 10);
    expect(s.positions).toHaveLength(1); // lista tylko płacących
  });

  it('dywidenda ze sprzedanej pozycji (isin bez otwartej pozycji) nie wchodzi do licznika', () => {
    const s = computeYieldOnCost(
      [dividend({}), dividend({ id: 2, isin: 'PL_SPRZEDANA', amountPln: 500 })],
      [position({})],
      TODAY,
    )!;
    expect(s.totalDividends12mPln).toBe(50);
    expect(s.approx).toBe(false); // wykluczenie celowe, nie brak danych
  });

  it('rekord bez ISIN-u albo bez kursu → approx=true', () => {
    const s1 = computeYieldOnCost([dividend({ isin: null })], [position({})], TODAY)!;
    expect(s1.approx).toBe(true);
    const s2 = computeYieldOnCost([dividend({ amountPln: null })], [position({})], TODAY)!;
    expect(s2.approx).toBe(true);
  });

  it('opcje i pozycje o niedodatnim koszcie poza rachunkiem; brak pozycji → null', () => {
    const short = position({ isin: 'PL_SHORT', currentValuePln: -100, profitLossPln: 50 });
    const option = position({ isin: 'PL_OPT', category: 'option' });
    expect(computeYieldOnCost([dividend({})], [short, option], TODAY)).toBeNull();
  });
});
