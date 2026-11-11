import { describe, it, expect } from 'vitest';
import { selectTopMovers } from '../top-movers';

const pos = (
  ticker: string,
  pln: number | null,
  pct: number | null,
  over: Partial<{
    shares: number;
    category: 'stock' | 'option';
    native: number | null;
    currency: string;
  }> = {},
) => ({
  isin: `ISIN_${ticker}`,
  ticker,
  paperName: `${ticker} S.A.`,
  shares: over.shares ?? 10,
  category: over.category ?? ('stock' as const),
  currency: over.currency ?? 'PLN',
  dailyChangePct: pct,
  dailyChangeValue: over.native === undefined ? pln : over.native,
  dailyChangeValuePln: pln,
});

describe('selectTopMovers', () => {
  const book = [
    pos('BIG', 900, 0.5), // duża pozycja, mały ruch
    pos('SMALL', 40, 8.0), // mała pozycja, duży ruch
    pos('MID', 300, 2.0),
    pos('FOURTH', 100, 1.0),
    pos('DOWN1', -700, -1.0),
    pos('DOWN2', -50, -9.0),
    pos('FLAT', 0, 0),
    pos('NODATA', null, null),
  ];

  it('ranking kwotowy: wg wpływu na portfel, obcięty do limitu', () => {
    const { byValue } = selectTopMovers(book);
    expect(byValue.gainers.map((m) => m.ticker)).toEqual(['BIG', 'MID', 'FOURTH']);
    expect(byValue.losers.map((m) => m.ticker)).toEqual(['DOWN1', 'DOWN2']);
  });

  it('ranking procentowy: wg ruchu ceny — inna kolejność niż kwotowy', () => {
    const { byPct } = selectTopMovers(book);
    expect(byPct.gainers.map((m) => m.ticker)).toEqual(['SMALL', 'MID', 'FOURTH']);
    expect(byPct.losers.map((m) => m.ticker)).toEqual(['DOWN2', 'DOWN1']);
  });

  it('pozycja bez ruchu nie jest ani wzrostem, ani spadkiem; bez danych — pominięta', () => {
    const r = selectTopMovers(book, { limit: 10 });
    const all = [...r.byValue.gainers, ...r.byValue.losers].map((m) => m.ticker);
    expect(all).not.toContain('FLAT');
    expect(all).not.toContain('NODATA');
    expect(r.coveredCount).toBe(7);
    expect(r.totalCount).toBe(8);
  });

  it('opcje i pozycje krótkie liczą się kwotowo, ale nie procentowo', () => {
    const r = selectTopMovers(
      [
        pos('AAPL', 100, 1),
        pos('OPT', 500, 40, { category: 'option' }),
        pos('SHORT', 300, -5, { shares: -10 }),
      ],
      { limit: 5 },
    );
    expect(r.byValue.gainers.map((m) => m.ticker)).toEqual(['OPT', 'SHORT', 'AAPL']);
    expect(r.byPct.gainers.map((m) => m.ticker)).toEqual(['AAPL']);
    expect(r.byPct.losers).toEqual([]);
  });

  it('useNative: kwoty z waluty notowania (portfel w walucie innej niż PLN)', () => {
    const r = selectTopMovers([pos('AAPL', 400, 1, { native: 100 })], { useNative: true });
    expect(r.byValue.gainers[0].amount).toBe(100);
  });

  it('pusty portfel', () => {
    const r = selectTopMovers([]);
    expect(r.byValue).toEqual({ gainers: [], losers: [] });
    expect(r.totalCount).toBe(0);
  });

  it('kwota do wyświetlenia jest w walucie waloru, ranking zostaje w walucie portfela', () => {
    const { byValue } = selectTopMovers([
      pos('US', 400, 1.0, { native: 100, currency: 'USD' }),
      pos('PL', 300, 1.0),
    ]);
    // 100 USD < 300 PLN liczbowo, ale wpływ na portfel (400 zł) jest większy.
    expect(byValue.gainers.map((m) => m.ticker)).toEqual(['US', 'PL']);
    expect(byValue.gainers[0]).toMatchObject({ nativeAmount: 100, currency: 'USD' });
    expect(byValue.gainers[1]).toMatchObject({ nativeAmount: 300, currency: 'PLN' });
  });
});
