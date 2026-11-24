import { describe, it, expect } from 'vitest';
import { selectDayContributions } from '../day-contributions';

const pos = (
  ticker: string,
  pln: number | null,
  pct: number | null,
  over: Partial<{ shares: number; category: 'stock' | 'option'; native: number | null }> = {},
) => ({
  isin: `ISIN_${ticker}`,
  ticker,
  paperName: `${ticker} S.A.`,
  shares: over.shares ?? 10,
  category: over.category ?? ('stock' as const),
  dailyChangePct: pct,
  dailyChangeValue: over.native === undefined ? pln : over.native,
  dailyChangeValuePln: pln,
});

describe('selectDayContributions — kwota', () => {
  const book = [
    pos('A', 900, 0.5),
    pos('B', -700, -4),
    pos('C', 300, 2),
    pos('D', 40, 8),
    pos('E', -20, -1),
    pos('F', 10, 0.1),
    pos('G', 5, 0.1),
  ];

  it('porządkuje po wartości bezwzględnej — duży spadek stoi przed małym wzrostem', () => {
    const r = selectDayContributions(book, { limit: 3 });
    expect(r.rows.map((x) => x.ticker)).toEqual(['A', 'B', 'C']);
  });

  it('wiersze i „reszta" sumują się do wyniku dnia wszystkich pokrytych pozycji', () => {
    const r = selectDayContributions(book, { limit: 3 });
    const total = r.rows.reduce((s, x) => s + x.amount, 0) + (r.rest?.amount ?? 0);
    expect(total).toBe(900 - 700 + 300 + 40 - 20 + 10 + 5);
    expect(r.rest).toMatchObject({ amount: 35, count: 4 });
  });

  it('słupek największego ruchu ma pełną długość, pozostałe są proporcjonalne', () => {
    const r = selectDayContributions(book, { limit: 3 });
    expect(r.rows[0].share).toBe(1);
    expect(r.rows[1].share).toBeCloseTo(700 / 900, 10);
    expect(r.rest?.share).toBeCloseTo(35 / 900, 10);
  });

  it('jedna pozycja poza limitem wchodzi na listę zamiast tworzyć „resztę" z jednego elementu', () => {
    const r = selectDayContributions(book.slice(0, 4), { limit: 3 });
    expect(r.rows).toHaveLength(4);
    expect(r.rest).toBeNull();
  });

  it('pozycja bez danych nie udaje zera: nie ma jej na liście ani w „reszcie"', () => {
    const r = selectDayContributions([pos('A', 100, 1), pos('X', null, null)]);
    expect(r.rows.map((x) => x.ticker)).toEqual(['A']);
    expect(r.rest).toBeNull();
    expect(r).toMatchObject({ coveredCount: 1, totalCount: 2 });
  });

  it('portfel walutowy liczy kwoty natywne — jak suma dnia po stronie serwera', () => {
    const r = selectDayContributions([pos('AAPL', 400, 1, { native: 100 })], { useNative: true });
    expect(r.rows[0].amount).toBe(100);
  });

  it('opcja jest na liście kwotowej, ale bez linku do strony instrumentu', () => {
    const r = selectDayContributions([pos('OPT', 50, 30, { category: 'option' })]);
    expect(r.rows[0]).toMatchObject({ ticker: 'OPT', linkable: false });
  });

  it('pusta lista pozycji', () => {
    expect(selectDayContributions([])).toEqual({
      rows: [],
      rest: null,
      coveredCount: 0,
      totalCount: 0,
    });
  });
});

describe('selectDayContributions — procent', () => {
  it('ranking po sile ruchu ceny, bez „reszty" (procenty się nie sumują)', () => {
    const r = selectDayContributions(
      [pos('BIG', 900, 0.5), pos('SMALL', 40, 8), pos('DOWN', -70, -5)],
      { mode: 'pct', limit: 2 },
    );
    expect(r.rows.map((x) => x.ticker)).toEqual(['SMALL', 'DOWN']);
    expect(r.rest).toBeNull();
    expect(r.rows[1].share).toBeCloseTo(5 / 8, 10);
  });

  it('pomija opcje i pozycje krótkie — ich procent nie jest ruchem porównywalnym z akcją', () => {
    const r = selectDayContributions(
      [
        pos('OPT', 50, 60, { category: 'option' }),
        pos('SHORT', -30, 9, { shares: -5 }),
        pos('STOCK', 20, 2),
      ],
      { mode: 'pct' },
    );
    expect(r.rows.map((x) => x.ticker)).toEqual(['STOCK']);
  });
});
