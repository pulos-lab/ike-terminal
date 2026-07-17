import { describe, it, expect } from 'vitest';
import {
  groupDividendsByMonthAndCurrency,
  groupDividendsByYearAndCurrency,
} from '../dividends-yearly';

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

describe('groupDividendsByMonthAndCurrency', () => {
  it('grupuje po miesiącu (klucz YYYY-MM) i sumuje w obrębie miesiąca', () => {
    const result = groupDividendsByMonthAndCurrency([
      { date: '2026-03-05', amount: 100, currency: 'PLN' },
      { date: '2026-03-28', amount: 50, currency: 'PLN' },
      { date: '2026-04-10', amount: 30, currency: 'USD' },
    ]);
    expect(result.rows).toEqual([
      { year: '2026-03', PLN: 150 },
      { year: '2026-04', USD: 30 },
    ]);
  });

  it('uzupełnia miesiące bez wypłat pustymi słupkami (sezonowość widoczna)', () => {
    const result = groupDividendsByMonthAndCurrency([
      { date: '2026-01-15', amount: 10, currency: 'PLN' },
      { date: '2026-04-15', amount: 20, currency: 'PLN' },
    ]);
    expect(result.rows).toEqual([
      { year: '2026-01', PLN: 10 },
      { year: '2026-02' },
      { year: '2026-03' },
      { year: '2026-04', PLN: 20 },
    ]);
  });

  it('uzupełnianie przechodzi przez granicę roku', () => {
    const result = groupDividendsByMonthAndCurrency([
      { date: '2025-11-15', amount: 10, currency: 'PLN' },
      { date: '2026-02-15', amount: 20, currency: 'PLN' },
    ]);
    expect(result.rows.map((r) => r.year)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('klucz z surowego stringa — data domenowa nie przechodzi przez strefę czasową', () => {
    // new Date('2026-07-01') to UTC-północ: w strefach na zachód od UTC dałoby '2026-06'
    const result = groupDividendsByMonthAndCurrency([
      { date: '2026-07-01', amount: 10, currency: 'PLN' },
    ]);
    expect(result.rows).toEqual([{ year: '2026-07', PLN: 10 }]);
  });

  it('obsługuje datę z częścią czasową (rekordy brokerskie)', () => {
    const result = groupDividendsByMonthAndCurrency([
      { date: '2025-10-31T00:00:00', amount: 330, currency: 'PLN' },
    ]);
    expect(result.rows).toEqual([{ year: '2025-10', PLN: 330 }]);
  });

  it('pusty wynik dla braku danych', () => {
    expect(groupDividendsByMonthAndCurrency([])).toEqual({ rows: [], currencies: [] });
  });
});
