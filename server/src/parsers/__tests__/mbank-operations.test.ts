import { describe, it, expect } from 'vitest';
import { parseMbankOperations, isMbankOperationsFormat } from '../mbank-operations.js';

const HEADER = 'Data,Opis,Kwota';

function buildCsv(lines: string[]): string {
  return [HEADER, ...lines].join('\n');
}

describe('isMbankOperationsFormat', () => {
  it('detects comma-delimited operations header', () => {
    expect(isMbankOperationsFormat('Data,Opis,Kwota\n')).toBe(true);
  });

  it('detects semicolon-delimited operations header', () => {
    expect(isMbankOperationsFormat('Data;Opis;Kwota\n')).toBe(true);
  });

  it('rejects transaction file (has Papier column)', () => {
    expect(
      isMbankOperationsFormat(
        'Czas transakcji,Papier,Gie\u0142da,K/S,Liczba,Kurs,Waluta,Prowizja,Waluta,Data\n',
      ),
    ).toBe(false);
  });

  it('rejects empty content', () => {
    expect(isMbankOperationsFormat('')).toBe(false);
  });
});

describe('parseMbankOperations', () => {
  it('parses dividend with ISIN, tax rate, and FX rate', () => {
    const csv = buildCsv([
      '16.04.2026 11:24:34,Dywidenda z 4 PW: US5951121038 DP: 2026-03-30 stawka brutto w wal.: 0.15 stawka pod.: 15% kurs przewalutowania: 3.590368 |DVCA10480,1',
    ]);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('dividend');
    expect(result.data[0].ticker).toBe('US5951121038');
    expect(result.data[0].amount).toBe(1);
    expect(result.data[0].currency).toBe('PLN');
    expect(result.data[0].fxRate).toBeCloseTo(3.590368);
    expect(result.data[0].description).toContain('US5951121038');
    expect(result.data[0].description).toContain('4 szt');
  });

  it('parses bank deposit (WYC.BK)', () => {
    const csv = buildCsv(['03.03.2026 14:08:00,WYC.BK: 600622 POZ: 1788464 ikze,6 000']);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('deposit');
    expect(result.data[0].amount).toBe(6000);
    expect(result.data[0].currency).toBe('PLN');
  });

  it('skips order blocks (Blokada)', () => {
    const csv = buildCsv([
      '03.03.2026 16:06:34,Blokada \u015brodk\u00f3w pod zlecenie kupna nr 105360056,-5 648',
    ]);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('settlement_record');
  });

  it('skips order unblocks (Odblokowanie)', () => {
    const csv = buildCsv([
      '23.03.2026 12:31:27,Odblokowanie \u015brodk\u00f3w pod zlecenie nr 105815419,720',
    ]);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('settlement_record');
  });

  it('skips transaction settlements (WYC with PW)', () => {
    const csv = buildCsv([
      '19.02.2026 12:01:08,WYC: 112082964 NOT: 119127638 ZLC: 105038258 PW: PLKMPTR00012,88',
    ]);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('settlement_record');
  });

  it('classifies unknown operations as other', () => {
    const csv = buildCsv(['01.01.2026 10:00:00,Jaki\u015b nieznany typ operacji,100']);

    const result = parseMbankOperations(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].operationType).toBe('other');
  });

  it('returns empty result for empty CSV', () => {
    const result = parseMbankOperations('', 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});
