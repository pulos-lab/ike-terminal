import { describe, it, expect } from 'vitest';
import { groupDividendsByYearAndCurrency } from '../dividends-yearly';

describe('groupDividendsByYearAndCurrency', () => {
  it('zwraca pusty wynik dla braku danych', () => {
    expect(groupDividendsByYearAndCurrency([])).toEqual({ rows: [], currencies: [] });
  });

  it('NIE sumuje różnych walut do jednej kwoty — osobny klucz per waluta', () => {
    const result = groupDividendsByYearAndCurrency([
      { date: '2024-03-01', amount: 100, currency: 'PLN' },
      { date: '2024-05-01', amount: 30, currency: 'USD' },
      { date: '2024-08-01', amount: 50, currency: 'PLN' },
    ]);
    expect(result.rows).toEqual([{ year: '2024', PLN: 150, USD: 30 }]);
    expect(result.currencies).toEqual(['PLN', 'USD']);
  });

  it('sortuje lata rosnąco', () => {
    const result = groupDividendsByYearAndCurrency([
      { date: '2025-01-01', amount: 1, currency: 'PLN' },
      { date: '2023-01-01', amount: 2, currency: 'PLN' },
      { date: '2024-01-01', amount: 3, currency: 'PLN' },
    ]);
    expect(result.rows.map((r) => r.year)).toEqual(['2023', '2024', '2025']);
  });

  it('PLN zawsze pierwsza w liście walut, reszta alfabetycznie', () => {
    const result = groupDividendsByYearAndCurrency([
      { date: '2024-01-01', amount: 1, currency: 'USD' },
      { date: '2024-02-01', amount: 1, currency: 'EUR' },
      { date: '2024-03-01', amount: 1, currency: 'PLN' },
      { date: '2024-04-01', amount: 1, currency: 'GBP' },
    ]);
    expect(result.currencies).toEqual(['PLN', 'EUR', 'GBP', 'USD']);
  });

  it('rok bez danej waluty nie ma klucza tej waluty (recharts pominie segment)', () => {
    const result = groupDividendsByYearAndCurrency([
      { date: '2023-06-01', amount: 10, currency: 'PLN' },
      { date: '2024-06-01', amount: 5, currency: 'USD' },
    ]);
    expect(result.rows).toEqual([
      { year: '2023', PLN: 10 },
      { year: '2024', USD: 5 },
    ]);
  });

  it('pusta waluta traktowana jako PLN', () => {
    const result = groupDividendsByYearAndCurrency([
      { date: '2024-06-01', amount: 10, currency: '' },
    ]);
    expect(result.rows).toEqual([{ year: '2024', PLN: 10 }]);
    expect(result.currencies).toEqual(['PLN']);
  });
});
