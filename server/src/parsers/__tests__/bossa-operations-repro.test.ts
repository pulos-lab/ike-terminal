import { describe, it, expect } from 'vitest';
import { parseBossaOperations } from '../bossa-operations.js';

const CSV_HEADER = 'data;tytuł operacji;szczegóły;kwota;waluta';

describe('bossa operations repro — user data', () => {
  it('all operations have PLN currency when parsed correctly', () => {
    const csvContent = [
      CSV_HEADER,
      '2026-06-08;Wypłata odsetek z tytułu obligacji PRF0628;;148,19;PLN',
      '2026-05-22;Wypłata dywidendy VOTUM;;850,00;PLN',
      '2026-04-27;Wypłata dywidendy CFSA;;680,00;PLN',
      '2026-03-06;Wypłata odsetek z tytułu obligacji PRF0628;;151,84;PLN',
      '2026-02-19;Wypłata dywidendy DELKO;;480,00;PLN',
      '2026-01-21;Wypłata dywidendy DELKO;;780,00;PLN',
      '2025-12-23;Wypłata dywidendy VOTUM;;283,90;PLN',
      '2025-12-08;Wypłata odsetek z tytułu obligacji PRF0628;;164,98;PLN',
      '2025-11-13;Wypłata dywidendy AMBRA;;341,00;PLN',
      '2025-10-28;Wypłata dywidendy VOTUM;;283,90;PLN',
      '2025-09-08;Wypłata odsetek z tytułu obligacji PRF0628;;173,74;PLN',
      '2025-07-01;Wypłata dywidendy DIGITANET;;385,60;PLN',
      '2025-06-09;Zwrot nadpłaty PRAGMAGO D4;;200,00;PLN',
      '2025-06-06;Wypłata dywidendy VOTUM;;566,10;PLN',
      '2025-05-29;Zapisy na obligacje PRAGMAGO D4;;-7500,00;PLN',
      '2025-05-27;Przelew do DM BOŚ;;26019,00;PLN',
      '2025-04-25;Wypłata dywidendy CFSA;;559,00;PLN',
      '2025-01-21;Wypłata dywidendy DELKO;;514,60;PLN',
      '2024-12-17;Wypłata dywidendy VOTUM;;205,70;PLN',
      '2024-12-05;Wypłata dywidendy DIGITANET;;322,94;PLN',
      '2024-11-15;Wypłata dywidendy VOTUM;;69,70;PLN',
      '2024-11-13;Wypłata dywidendy AMBRA;;231,00;PLN',
      '2024-10-16;Wypłata dywidendy VOTUM;;205,70;PLN',
      '2024-05-27;Wypłata dywidendy DIGITANET;;549,40;PLN',
      '2024-04-25;Przelew do DM BOŚ;;23472,00;PLN',
      '2024-03-08;Wypłata dywidendy SYNEKTIK;;90,90;PLN',
      '2024-01-17;Wypłata dywidendy DELKO;;189,00;PLN',
      '2023-12-07;Przelew do DM BOŚ;;20805,00;PLN',
    ].join('\n');

    const result = parseBossaOperations(csvContent, 'test-batch');

    // All operations MUST have PLN currency
    const badCurrency = result.data.filter((o) => o.currency !== 'PLN');
    expect(badCurrency).toHaveLength(0);

    // Check the bond interest classification
    const bondOps = result.data.filter((o) => o.description?.includes('PRF0628'));
    expect(bondOps.length).toBeGreaterThan(0);
    for (const op of bondOps) {
      expect(op.operationType).toBe('dividend');
      expect(op.subkind).toBe('coupon');
      expect(op.currency).toBe('PLN');
    }

    // Zapisy na obligacje + Zwrot nadpłaty → bondAllocations marker (nie withdrawal/deposit)
    expect(result.bondAllocations).toHaveLength(1);
    expect(result.bondAllocations[0].csvIssuerName).toBe('PRAGMAGO D4');
    // findBondByName dopasowuje "PRAGMAGO D4" → "PragmaGO S.A." + series "D4" → PRF0628
    expect(result.bondAllocations[0].ticker).toBe('PRF0628');
    expect(result.bondAllocations[0].isin).toBe('PLGFPRE00453');
    expect(result.bondAllocations[0].nominal).toBe(100);
    expect(result.bondAllocations[0].subscriptionAmount).toBe(7500);
    expect(result.bondAllocations[0].refundAmount).toBe(200);
    // Oba wiersze skonsumowane — nie ma ich w data
    expect(result.data.find((o) => o.amount === -7500)).toBeUndefined();
    expect(result.data.find((o) => o.amount === 200)).toBeUndefined();
  });

  it('HEADER with trailing semicolon + data without — comma decimals still correct', () => {
    const csv =
      'data;tytuł operacji;szczegóły;kwota;waluta;\n2026-06-08;Wypłata odsetek z tytułu obligacji PRF0628;;148,19;PLN';
    const result = parseBossaOperations(csv, 'test');
    expect(result.data[0].currency).toBe('PLN');
    expect(result.data[0].amount).toBe(148.19);
  });

  it('bond subscription + refund pair → marker created, both rows consumed from cashflow', () => {
    const csv = [
      CSV_HEADER,
      '2025-06-09;Zwrot nadpłaty PRAGMAGO D4;;200,00;PLN',
      '2025-05-29;Zapisy na obligacje PRAGMAGO D4;;-7500,00;PLN',
    ].join('\n');
    const result = parseBossaOperations(csv, 'test');
    expect(result.bondAllocations).toHaveLength(1);
    expect(result.bondAllocations[0].csvIssuerName).toBe('PRAGMAGO D4');
    expect(result.bondAllocations[0].subscriptionAmount).toBe(7500);
    expect(result.bondAllocations[0].refundAmount).toBe(200);
    // Both rows consumed
    expect(result.data).toHaveLength(0);
    expect(result.skipped.filter((s) => s.reason === 'redemption_reconciled').length).toBe(2);
  });

  it('unpaired "Zapisy na obligacje" — stays as withdrawal, no bond allocation marker', () => {
    const csv = [CSV_HEADER, '2025-05-29;Zapisy na obligacje PRAGMAGO D4;;-7500,00;PLN'].join('\n');
    const result = parseBossaOperations(csv, 'test');
    expect(result.bondAllocations).toHaveLength(0);
    const bondSub = result.data.find((o) => o.amount === -7500);
    expect(bondSub).toBeDefined();
    expect(bondSub!.operationType).toBe('withdrawal');
  });

  it('amount with semicolon instead of comma — row goes to QUARANTINE (malformed)', () => {
    const csv =
      'data;tytuł operacji;szczegóły;kwota;waluta\n2026-06-08;Wypłata odsetek z tytułu obligacji PRF0628;;148;19;PLN';
    const result = parseBossaOperations(csv, 'test');
    expect(result.data).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
    expect(result.quarantine![0].reason).toBe('column_count_mismatch');
    expect(result.quarantine![0].raw).toEqual([
      '2026-06-08',
      'Wypłata odsetek z tytułu obligacji PRF0628',
      '',
      '148',
      '19',
      'PLN',
    ]);
  });

  it('90;90 pattern — row goes to QUARANTINE (malformed)', () => {
    const csv =
      'data;tytuł operacji;szczegóły;kwota;waluta\n2024-03-08;Wypłata dywidendy SYNEKTIK;;90;90;PLN';
    const result = parseBossaOperations(csv, 'test');
    expect(result.data).toHaveLength(0);
    expect(result.quarantine).toHaveLength(1);
    expect(result.quarantine![0].severity).toBe('malformed');
    expect(result.quarantine![0].reason).toBe('column_count_mismatch');
    expect(result.quarantine![0].raw).toEqual([
      '2024-03-08',
      'Wypłata dywidendy SYNEKTIK',
      '',
      '90',
      '90',
      'PLN',
    ]);
  });
});
