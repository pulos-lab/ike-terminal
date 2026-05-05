import { describe, it, expect } from 'vitest';
import { parseMbankTransactions } from '../mbank-transactions.js';

describe('parseMbankTransactions', () => {
  it('parses comma-delimited CSV (new format)', () => {
    const csv = [
      'Czas transakcji,Papier,Gie\u0142da,K/S,Liczba,Kurs,Waluta,Prowizja,Waluta,Warto\u015b\u0107,Waluta',
      '03.03.2026 16:26:23,MICRON TECH,USA-NASDAQ,K,4,374,,,,,',
      '17.02.2026 09:02:10,KOMPUTRON,WWA-GPW,S,12,7,,,,,',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);

    // MICRON TECH — USD inferred from USA-NASDAQ
    expect(result.data[0].paperName).toBe('MICRON TECH');
    expect(result.data[0].side).toBe('K');
    expect(result.data[0].quantity).toBe(4);
    expect(result.data[0].price).toBe(374);
    expect(result.data[0].currency).toBe('USD');
    expect(result.data[0].commission).toBe(0);

    // KOMPUTRON — PLN inferred from WWA-GPW
    expect(result.data[1].paperName).toBe('KOMPUTRON');
    expect(result.data[1].side).toBe('S');
    expect(result.data[1].quantity).toBe(12);
    expect(result.data[1].currency).toBe('PLN');
  });

  it('parses semicolon-delimited CSV (legacy format)', () => {
    const csv = [
      'Czas transakcji;Papier;Gie\u0142da;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Warto\u015b\u0107;Waluta',
      '25.02.2026 09:00:00;KGHM;WWA-GPW;K;10;150.50;PLN;5.00;PLN;1505.00;PLN',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].paperName).toBe('KGHM');
    expect(result.data[0].price).toBe(150.5);
    expect(result.data[0].currency).toBe('PLN');
    expect(result.data[0].commission).toBe(5);
  });

  it('infers currency from exchange when Waluta column is empty', () => {
    const csv = [
      'Czas transakcji,Papier,Gie\u0142da,K/S,Liczba,Kurs,Waluta,Prowizja,Waluta,Warto\u015b\u0107,Waluta',
      '01.01.2026 10:00:00,APPLE,USA-NYSE,K,1,200,,,,,',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].currency).toBe('USD');
  });

  it('defaults currency to PLN when exchange is unknown', () => {
    const csv = [
      'Czas transakcji,Papier,Gie\u0142da,K/S,Liczba,Kurs,Waluta,Prowizja,Waluta,Warto\u015b\u0107,Waluta',
      '01.01.2026 10:00:00,TEST,UNKNOWN-EX,K,1,100,,,,,',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].currency).toBe('PLN');
  });

  it('returns empty result for empty CSV', () => {
    const result = parseMbankTransactions('', 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('skips rows with price <= 0', () => {
    const csv = [
      'Czas transakcji,Papier,Gie\u0142da,K/S,Liczba,Kurs,Waluta,Prowizja,Waluta,Warto\u015b\u0107,Waluta',
      '01.01.2026 10:00:00,KGHM,WWA-GPW,K,10,0,,,,,',
    ].join('\n');

    const result = parseMbankTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('invalid_price');
  });
});
