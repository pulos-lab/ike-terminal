import { describe, it, expect } from 'vitest';
import {
  benchmarkDayChangeFromQuote,
  getBenchmarkDayChange,
  isBenchmarkKey,
} from '../benchmark-day.js';

const T = Date.parse('2026-11-23T21:00:00Z');

describe('benchmarkDayChangeFromQuote', () => {
  it('liczy zmianę od poprzedniego zamknięcia i podaje moment notowania', () => {
    const r = benchmarkDayChangeFromQuote('sp500', {
      price: 5050,
      previousClose: 5000,
      quoteTime: T,
    });
    expect(r.changePct).toBeCloseTo(1, 10);
    expect(r.asOf).toBe('2026-11-23T21:00:00.000Z');
    expect(r.benchmark).toBe('sp500');
  });

  it('bez poprzedniego zamknięcia nie udaje zera', () => {
    const r = benchmarkDayChangeFromQuote('sp500', {
      price: 5050,
      previousClose: null,
      quoteTime: T,
    });
    expect(r).toEqual({ benchmark: 'sp500', changePct: null, asOf: null });
  });

  it('bez znacznika czasu nie zwraca liczby — klient nie umiałby przypisać jej do sesji', () => {
    const r = benchmarkDayChangeFromQuote('wig', {
      price: 101,
      previousClose: 100,
      quoteTime: null,
    });
    expect(r.changePct).toBeNull();
  });

  it('odrzuca ruch niemożliwy dla indeksu (nieświeże poprzednie zamknięcie w źródle)', () => {
    const r = benchmarkDayChangeFromQuote('sp500', {
      price: 5000,
      previousClose: 3000,
      quoteTime: T,
    });
    expect(r.changePct).toBeNull();
  });

  it('brak notowania = brak danych', () => {
    expect(benchmarkDayChangeFromQuote('nasdaq', null).changePct).toBeNull();
  });
});

describe('getBenchmarkDayChange', () => {
  it('pyta źródło o ticker z rejestru benchmarków', async () => {
    const asked: string[] = [];
    const r = await getBenchmarkDayChange('sp500', async (ticker) => {
      asked.push(ticker);
      return { price: 99, previousClose: 100, quoteTime: T };
    });
    expect(asked).toEqual(['^GSPC']);
    expect(r.changePct).toBeCloseTo(-1, 10);
  });

  it('„Brak” nie ma tickera — bez pytania źródła', async () => {
    let calls = 0;
    const r = await getBenchmarkDayChange('none', async () => {
      calls++;
      return null;
    });
    expect(calls).toBe(0);
    expect(r.changePct).toBeNull();
  });

  it('awaria źródła nie jest błędem endpointu', async () => {
    const r = await getBenchmarkDayChange('wig20', async () => {
      throw new Error('Yahoo 429');
    });
    expect(r).toEqual({ benchmark: 'wig20', changePct: null, asOf: null });
  });
});

describe('isBenchmarkKey', () => {
  it('przepuszcza klucze rejestru, odrzuca resztę (także pola prototypu)', () => {
    expect(isBenchmarkKey('sp500')).toBe(true);
    expect(isBenchmarkKey('toString')).toBe(false);
    expect(isBenchmarkKey(undefined)).toBe(false);
  });
});
