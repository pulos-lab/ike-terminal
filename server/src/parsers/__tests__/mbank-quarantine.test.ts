import { describe, it, expect } from 'vitest';
import { parseMbankTransactions } from '../mbank-transactions.js';

const HEADER =
  'Czas transakcji,Papier,Giełda,K/S,Liczba,Kurs,Waluta,Prowizja,Waluta,Wartość,Waluta';

describe('mbank-transactions quarantine', () => {
  it('correct CSV → data, no quarantine', () => {
    const csv =
      HEADER + '\n' + '03.03.2026 16:26:23,KGHM,WWA-GPW,K,10,150.50,PLN,5.00,PLN,1505.00,PLN';
    const result = parseMbankTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.quarantine).toBeUndefined();
  });

  it('numeric Waluta (column 6 = number) → malformed quarantine', () => {
    // Column 6 = "100" instead of "PLN" — triggers numeric currency check
    const csv =
      HEADER + '\n' + '03.03.2026 16:26:23,KGHM,WWA-GPW,K,10,150.50,100,5.00,PLN,1505.00,PLN';
    const result = parseMbankTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
    expect(result.quarantine![0].message).toContain('liczbową');
  });

  it('missing Waluta column in header → no quarantine, currency inferred', () => {
    const csv =
      'Czas transakcji,Papier,Giełda,K/S,Liczba,Kurs\n' +
      '03.03.2026 16:26:23,KGHM,WWA-GPW,K,10,150.50';
    const result = parseMbankTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].currency).toBe('PLN');
    expect(result.quarantine).toBeUndefined();
  });

  it('short row (< 6 cols) → skipped, not quarantine', () => {
    const csv = HEADER + '\n' + '03.03.2026 16:26:23,KGHM,WWA-GPW,K,10';
    const result = parseMbankTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('short_row');
    expect(result.quarantine).toBeUndefined();
  });

  it('mixed valid + quarantined rows → valid in data, only bad rows in quarantine', () => {
    const csv =
      HEADER +
      '\n' +
      '03.03.2026 16:26:23,KGHM,WWA-GPW,K,10,150.50,PLN,5.00,PLN,1505.00,PLN\n' +
      '04.03.2026 10:00:00,CDR,WWA-GPW,S,5,400.00,100,3.00,PLN,2000.00,PLN';
    const result = parseMbankTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
  });
});
