import { describe, it, expect } from 'vitest';
import type { Position } from 'shared';
import { buildGroups } from '../PortfolioOptionsCard';

function opt(
  overrides: Partial<Position> & {
    underlying: string;
    strike: number;
    expiry: string;
    optionType: 'C' | 'P';
    shares: number;
  },
): Position {
  const { underlying, strike, expiry, optionType, shares, ...rest } = overrides;
  return {
    paperName: `${underlying} ${strike} ${optionType}`,
    isin: `OPT:${underlying}${expiry}${optionType}${strike}`,
    ticker: `${underlying}${expiry}${optionType}`,
    shares,
    avgBuyPrice: 1,
    totalCommission: 0,
    currentPrice: 1,
    currentValue: shares * 100,
    currentValuePln: shares * 400,
    profitLoss: 10,
    profitLossPln: 40,
    profitLossPct: 5,
    currency: 'USD',
    weight: 0,
    dailyChangePct: null,
    category: 'option',
    optionMeta: { underlying, strike, expiry, optionType, multiplier: 100 },
    ...rest,
  };
}

describe('buildGroups — grupowanie opcji', () => {
  it('spread pionowy (long+short, ten sam underlying/expiry/typ) → jedna grupa', () => {
    const groups = buildGroups([
      opt({ underlying: 'DECK', strike: 90, expiry: '2025-06-20', optionType: 'P', shares: 1 }),
      opt({ underlying: 'DECK', strike: 100, expiry: '2025-06-20', optionType: 'P', shares: -1 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].legs).toHaveLength(2);
    expect(groups[0].label).toBe('DECK 90/100 PUT');
    expect(groups[0].kindLabel).toBe('spread pionowy');
  });

  it('dwie niezależne długie pozycje (brak nogi krótkiej) → osobne wiersze, NIE spread', () => {
    const groups = buildGroups([
      opt({ underlying: 'OKLO', strike: 15, expiry: '2027-12-17', optionType: 'P', shares: 7 }),
      opt({ underlying: 'OKLO', strike: 20, expiry: '2027-12-17', optionType: 'P', shares: 3 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.legs.length === 1 && g.kindLabel === null)).toBe(true);
  });

  it('struktura 3+ nóg z long i short → grupa z etykietą "N nogi"', () => {
    const groups = buildGroups([
      opt({ underlying: 'SPY', strike: 400, expiry: '2025-12-19', optionType: 'C', shares: 1 }),
      opt({ underlying: 'SPY', strike: 410, expiry: '2025-12-19', optionType: 'C', shares: -2 }),
      opt({ underlying: 'SPY', strike: 420, expiry: '2025-12-19', optionType: 'C', shares: 1 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].kindLabel).toBe('3 nogi');
  });

  it('P&L netto = suma nóg; wartość netto sumuje long(+) i short(−)', () => {
    const [g] = buildGroups([
      opt({
        underlying: 'DECK',
        strike: 90,
        expiry: '2025-06-20',
        optionType: 'P',
        shares: 1,
        currentValuePln: 400,
        profitLoss: 30,
      }),
      opt({
        underlying: 'DECK',
        strike: 100,
        expiry: '2025-06-20',
        optionType: 'P',
        shares: -1,
        currentValuePln: -250,
        profitLoss: -10,
      }),
    ]);
    expect(g.netValuePln).toBe(150);
    expect(g.netProfitLoss).toBe(20);
  });

  it('różne daty wygaśnięcia (kalendarz) nie łączą się w jeden spread pionowy', () => {
    const groups = buildGroups([
      opt({ underlying: 'AAPL', strike: 200, expiry: '2025-06-20', optionType: 'C', shares: -1 }),
      opt({ underlying: 'AAPL', strike: 200, expiry: '2025-09-19', optionType: 'C', shares: 1 }),
    ]);
    // Różny expiry = różne kubełki → dwie osobne pozycje (brak long+short w kubełku)
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.legs.length === 1)).toBe(true);
  });
});
