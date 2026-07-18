import { describe, it, expect } from 'vitest';
import {
  annotateDividendRecords,
  buildDividendIsinResolver,
  normalizeInstrumentKey,
} from '../dividend-position-link.js';
import type { DividendRecord, TickerMapEntry } from 'shared';

function entry(isin: string, ticker: string, name: string): TickerMapEntry {
  return { isin, ticker, name, exchange: 'GPW', currency: 'PLN', priceSource: 'auto' };
}

function tickerMap(entries: TickerMapEntry[]): Map<string, TickerMapEntry> {
  return new Map(entries.map((e) => [e.isin, e]));
}

const CRJ = entry('PLCRPJR00019', 'CRJ.WA', 'Creepy Jar S.A.');
const SPGI = entry('US78409V1044', 'SPGI', 'S&P Global Inc.');
const GAMEOPS = entry('PLGMSOP00019', 'GOP.WA', 'Games Operators S.A.');

describe('buildDividendIsinResolver', () => {
  it('dopasowuje dokładny ticker z ticker_map (rekordy auto-yahoo)', () => {
    const resolve = buildDividendIsinResolver([], tickerMap([CRJ, SPGI]));
    expect(resolve('SPGI')).toBe('US78409V1044');
    expect(resolve('spgi')).toBe('US78409V1044'); // case-insensitive
    expect(resolve('CRJ.WA')).toBe('PLCRPJR00019');
  });

  it('dopasowuje skrót GPW przez paper_name transakcji Bossa', () => {
    const resolve = buildDividendIsinResolver(
      [{ paperName: 'GAMEOPS', isin: 'PLGMSOP00019' }],
      tickerMap([GAMEOPS]),
    );
    // 'GAMEOPS' nie występuje ani jako ticker, ani jako nazwa w ticker_map —
    // jedyna droga to transakcje.
    expect(resolve('GAMEOPS')).toBe('PLGMSOP00019');
  });

  it('dopasowuje po znormalizowanej nazwie z ticker_map', () => {
    const resolve = buildDividendIsinResolver([], tickerMap([CRJ]));
    expect(resolve('CREEPY JAR SA')).toBe('PLCRPJR00019');
  });

  it('klucz niejednoznaczny (dwa ISIN-y) → null zamiast losowego trafienia', () => {
    const resolve = buildDividendIsinResolver(
      [
        { paperName: 'ORLEN', isin: 'PL0000000001' },
        { paperName: 'orlen', isin: 'PL0000000002' },
      ],
      tickerMap([]),
    );
    expect(resolve('ORLEN')).toBeNull();
  });

  it('brak dopasowania → null', () => {
    const resolve = buildDividendIsinResolver([], tickerMap([CRJ]));
    expect(resolve('NIEZNANY')).toBeNull();
    expect(resolve('')).toBeNull();
  });
});

describe('annotateDividendRecords', () => {
  const record = (over: Partial<DividendRecord>): DividendRecord => ({
    id: 1,
    date: '2026-01-15',
    ticker: 'SPGI',
    description: 'test',
    amount: 100,
    currency: 'USD',
    source: 'manual',
    ...over,
  });

  it('przelicza amountPln po kursie z dnia wypłaty i rozwiązuje isin', () => {
    const fx = (cur: string) => (cur === 'USD' ? 4.0 : cur === 'PLN' ? 1 : null);
    const [a] = annotateDividendRecords([record({})], fx, () => 'US78409V1044');
    expect(a.amountPln).toBe(400);
    expect(a.isin).toBe('US78409V1044');
  });

  it('brak kursu FX → amountPln null (spójne z totalPlnApprox)', () => {
    const [a] = annotateDividendRecords(
      [record({ currency: 'NOK' })],
      () => null,
      () => null,
    );
    expect(a.amountPln).toBeNull();
    expect(a.isin).toBeNull();
  });
});

describe('normalizeInstrumentKey', () => {
  it('wielkie litery, tylko alfanumeryczne', () => {
    expect(normalizeInstrumentKey('Creepy Jar S.A.')).toBe('CREEPYJARSA');
    expect(normalizeInstrumentKey('Novo-Nordisk A/S ADR')).toBe('NOVONORDISKASADR');
  });
});
