import { describe, it, expect } from 'vitest';
import { parseDegiroTransactions } from '../degiro-transactions.js';
import { parseDegiroOperations } from '../degiro-operations.js';

// ── Fixtures (from degiro.test.ts) ────────────────────────────────────────────

const TX_HEADER =
  'Data,Czas,Produkt,ISIN,Giełda referencyjna,Miejsce wykonania,Liczba,Kurs,,Wartość lokalna,,Wartość EUR,Kurs wymiany,Opłaty AutoFX,Opłata transakcyjna DEGIRO i/lub opłata stron,,Razem EUR,,Identyfikator zlecenia';

const ACCOUNT_HEADER =
  'Data,Czas,Data,Produkt,ISIN,Opis,Kurs,Zmiana,,Saldo,,Identyfikator zlecenia';

// ── DEGIRO Transactions quarantine ────────────────────────────────────────────

describe('degiro-transactions quarantine', () => {
  it('correct CSV → data, no quarantine', () => {
    const csv =
      TX_HEADER +
      '\n' +
      '05-02-2024,10:30,APPLE INC,US0378331005,NASDAQ,XNAS,"0,3069","494,15",USD,"151,65",USD,"140,00","0,9230",,"-1,00","EUR","-141,00",EUR,abc';
    const result = parseDegiroTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.quarantine).toBeUndefined();
  });

  it('extra column beyond header (20 cols) → malformed quarantine', () => {
    const csv =
      TX_HEADER +
      '\n' +
      '05-02-2024,10:30,APPLE INC,US0378331005,NASDAQ,XNAS,"0,3069","494,15",USD,"151,65",USD,"140,00","0,9230",,"-1,00","EUR","-141,00",EUR,abc,EXTRA';
    const result = parseDegiroTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
    expect(result.quarantine![0].reason).toBe('column_count_mismatch');
  });

  it('numeric waluta (column 8 = number) → malformed quarantine', () => {
    // Column 8 = "100" instead of "USD" — triggers numeric currency check
    const csv =
      TX_HEADER +
      '\n' +
      '05-02-2024,10:30,APPLE INC,US0378331005,NASDAQ,XNAS,"0,3069","494,15",100,"151,65",USD,"140,00","0,9230",,"-1,00","EUR","-141,00",EUR,abc';
    const result = parseDegiroTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
    expect(result.quarantine![0].message).toContain('liczbową');
  });

  it('short row (< 14 cols) → skipped, not quarantine', () => {
    const csv = TX_HEADER + '\n' + '05-02-2024,10:30,APPLE INC,US0378331005,NASDAQ,XNAS,1';
    const result = parseDegiroTransactions(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('short_row');
    expect(result.quarantine).toBeUndefined();
  });
});

// ── DEGIRO Operations quarantine ──────────────────────────────────────────────

describe('degiro-operations quarantine', () => {
  it('correct CSV → data, no quarantine', () => {
    const csv =
      ACCOUNT_HEADER +
      '\n' +
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Dywidenda,,USD,"100,00",,USD,';
    const result = parseDegiroOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(1);
    expect(result.quarantine).toBeUndefined();
  });

  it('extra column beyond header (13 cols) → malformed quarantine', () => {
    const csv =
      ACCOUNT_HEADER +
      '\n' +
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Dywidenda,,USD,"100,00",,USD,,EXTRA';
    const result = parseDegiroOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
    expect(result.quarantine![0].reason).toBe('column_count_mismatch');
  });

  it('numeric currency (column 7 = number) → malformed quarantine', () => {
    // Column 7 = "100" instead of "USD"
    const csv =
      ACCOUNT_HEADER +
      '\n' +
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Dywidenda,,100,"100,00",,USD,';
    const result = parseDegiroOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
    expect(result.quarantine![0].message).toContain('liczbową');
  });

  it('short row (< 8 cols) → skipped, not quarantine', () => {
    const csv = ACCOUNT_HEADER + '\n' + '01-03-2024,09:00,01-03-2024';
    const result = parseDegiroOperations(csv, 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('short_row');
    expect(result.quarantine).toBeUndefined();
  });
});
