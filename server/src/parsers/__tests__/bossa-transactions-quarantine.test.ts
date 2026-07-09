import { describe, it, expect } from 'vitest';
import { parseBossaTransactions } from '../bossa-transactions.js';

const CSV_HEADER = 'data;papier;isin;-;ilość;cena;wartość;prowizja;po prowizji;waluta';

describe('bossa-transactions quarantine', () => {
  it('correct CSV → data, no quarantine', () => {
    const csv =
      CSV_HEADER + '\n' + '25.02.2026;KGHM;PLKGHM000017;K;10;150,50;1505,00;5,00;1510,00;PLN';
    const result = parseBossaTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.quarantine).toBeUndefined();
    expect(result.skipped).toHaveLength(0);
  });

  it('numeric waluta (semicolon instead of comma) → malformed quarantine', () => {
    // "90,90" → semicolon makes it "90;90" → waluta = "90" (numeric)
    const csv =
      CSV_HEADER + '\n' + '01.03.2026;SYNEKTIK;PLSYNEK00012;K;5;90,00;450,00;2,00;452,00;90;90';
    const result = parseBossaTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
    expect(result.quarantine![0].reason).toBe('column_count_mismatch');
  });

  it('extra columns (__parsed_extra) → malformed quarantine', () => {
    // Header without trailing semicolon, data has extra column
    const csv =
      'data;papier;isin;-;ilość;cena;wartość;prowizja;po prowizji;waluta\n' +
      '25.02.2026;KGHM;PLKGHM000017;K;10;150,50;1505,00;5,00;1510,00;PLN;extra';
    const result = parseBossaTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
    expect(result.quarantine![0].reason).toBe('column_count_mismatch');
  });

  it('invalid currency code → invalid quarantine', () => {
    // 2-letter code fails 3-letter regex → data validation catches it
    const csv =
      CSV_HEADER + '\n' + '25.02.2026;KGHM;PLKGHM000017;K;10;150,50;1505,00;5,00;1510,00;XX';
    const result = parseBossaTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('invalid');
    expect(result.quarantine![0].reason).toBe('invalid_currency');
    expect(result.quarantine![0].raw).toContain('XX');
    expect(result.quarantine![0].parsed).toBeDefined();
    expect(result.quarantine![0].suggestions).toEqual(['PLN']);
  });

  it('empty waluta → data (defaults to PLN), no quarantine', () => {
    const csv =
      CSV_HEADER + '\n' + '25.02.2026;KGHM;PLKGHM000017;K;10;150,50;1505,00;5,00;1510,00;';
    const result = parseBossaTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.data[0].currency).toBe('PLN');
    expect(result.quarantine).toBeUndefined();
  });

  it('mixed valid + quarantined rows → valid in data, only bad rows in quarantine', () => {
    const csv =
      CSV_HEADER +
      '\n' +
      '25.02.2026;KGHM;PLKGHM000017;K;10;150,50;1505,00;5,00;1510,00;PLN\n' +
      // Malformed — numeric waluta (semicolon instead of comma in amount)
      '01.03.2026;SYNEKTIK;PLSYNEK00012;K;5;90,00;450,00;2,00;452,00;90;90\n' +
      '02.03.2026;CDPROJEKT;PLOPTTC00011;S;2;200,00;400,00;1,90;398,10;PLN';
    const result = parseBossaTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(2);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
  });
});
