import { describe, it, expect } from 'vitest';
import type { Position } from 'shared';
import { sortPositions, nextSort, DEFAULT_SORT } from '../PortfolioPage';

function pos(overrides: Partial<Position> & { ticker: string }): Position {
  return {
    paperName: overrides.ticker,
    isin: overrides.ticker,
    shares: 10,
    avgBuyPrice: 100,
    totalCommission: 0,
    currentPrice: 100,
    currentValue: 1000,
    currentValuePln: 1000,
    profitLoss: 0,
    profitLossPln: 0,
    profitLossPct: 0,
    currency: 'PLN',
    weight: 10,
    dailyChangePct: 0,
    ...overrides,
  } as Position;
}

const tickers = (list: Position[]) => list.map((p) => p.ticker);

describe('sortPositions', () => {
  it('domyślne sortowanie odpowiada kolejności z API (wartość malejąco)', () => {
    // API zwraca pozycje posortowane po currentValuePln malejąco — domyślny stan
    // nie może tego zmieniać, bo inaczej widok „skoczyłby" po wdrożeniu.
    const list = [
      pos({ ticker: 'MAŁA', currentValuePln: 100 }),
      pos({ ticker: 'DUŻA', currentValuePln: 9000 }),
      pos({ ticker: 'ŚREDNIA', currentValuePln: 500 }),
    ];
    expect(tickers(sortPositions(list, DEFAULT_SORT, false))).toEqual(['DUŻA', 'ŚREDNIA', 'MAŁA']);
  });

  it('sortuje po tickerze alfabetycznie, z polskimi znakami', () => {
    const list = [pos({ ticker: 'ŻYWIEC' }), pos({ ticker: 'ALIOR' }), pos({ ticker: 'ŁUKASZ' })];
    expect(tickers(sortPositions(list, { key: 'ticker', dir: 'asc' }, false))).toEqual([
      'ALIOR',
      'ŁUKASZ',
      'ŻYWIEC',
    ]);
  });

  it('sortuje po zmianie dziennej w obu kierunkach', () => {
    const list = [
      pos({ ticker: 'A', dailyChangePct: -2 }),
      pos({ ticker: 'B', dailyChangePct: 5 }),
      pos({ ticker: 'C', dailyChangePct: 0 }),
    ];
    expect(tickers(sortPositions(list, { key: 'dailyChange', dir: 'desc' }, false))).toEqual([
      'B',
      'C',
      'A',
    ]);
    expect(tickers(sortPositions(list, { key: 'dailyChange', dir: 'asc' }, false))).toEqual([
      'A',
      'C',
      'B',
    ]);
  });

  it('pozycje BEZ danych lądują na końcu niezależnie od kierunku', () => {
    // Papier bez notowań (priceManual) ma dailyChangePct = null. Nie może wskakiwać
    // na górę tylko dlatego, że sortujemy rosnąco — to nie jest „najmniejsza zmiana".
    const list = [
      pos({ ticker: 'ZNANA', dailyChangePct: 3 }),
      pos({ ticker: 'BEZ_NOTOWAN', dailyChangePct: null, currentPrice: null }),
      pos({ ticker: 'INNA', dailyChangePct: -1 }),
    ];
    expect(tickers(sortPositions(list, { key: 'dailyChange', dir: 'asc' }, false)).at(-1)).toBe(
      'BEZ_NOTOWAN',
    );
    expect(tickers(sortPositions(list, { key: 'dailyChange', dir: 'desc' }, false)).at(-1)).toBe(
      'BEZ_NOTOWAN',
    );
    expect(tickers(sortPositions(list, { key: 'price', dir: 'asc' }, false)).at(-1)).toBe(
      'BEZ_NOTOWAN',
    );
  });

  it('waluta portfela decyduje, które pole jest sortowane', () => {
    // Przy portfelu w walucie obcej tabela pokazuje wartości natywne — sortowanie
    // musi iść po tym, co widać, a nie po przeliczeniu na PLN.
    const list = [
      pos({ ticker: 'USD_DUZA', currentValue: 900, currentValuePln: 10 }),
      pos({ ticker: 'USD_MALA', currentValue: 100, currentValuePln: 9000 }),
    ];
    expect(tickers(sortPositions(list, { key: 'value', dir: 'desc' }, true))).toEqual([
      'USD_DUZA',
      'USD_MALA',
    ]);
    expect(tickers(sortPositions(list, { key: 'value', dir: 'desc' }, false))).toEqual([
      'USD_MALA',
      'USD_DUZA',
    ]);
  });

  it('nie modyfikuje listy wejściowej', () => {
    const list = [pos({ ticker: 'A', weight: 1 }), pos({ ticker: 'B', weight: 9 })];
    sortPositions(list, { key: 'weight', dir: 'desc' }, false);
    expect(tickers(list)).toEqual(['A', 'B']);
  });
});

describe('nextSort', () => {
  it('kliknięcie w tę samą kolumnę odwraca kierunek', () => {
    expect(nextSort({ key: 'value', dir: 'desc' }, 'value')).toEqual({ key: 'value', dir: 'asc' });
    expect(nextSort({ key: 'value', dir: 'asc' }, 'value')).toEqual({ key: 'value', dir: 'desc' });
  });

  it('kolumna liczbowa startuje od największych, tekstowa od A→Z', () => {
    expect(nextSort({ key: 'ticker', dir: 'asc' }, 'value')).toEqual({ key: 'value', dir: 'desc' });
    expect(nextSort({ key: 'value', dir: 'desc' }, 'ticker')).toEqual({
      key: 'ticker',
      dir: 'asc',
    });
  });
});
