import { describe, it, expect } from 'vitest';
import { parseBossaTransactions, isBossaFormat } from '../bossa-transactions.js';

const CSV_HEADER = 'data;papier;isin;-;ilość;cena;wartość;prowizja;po prowizji;waluta';

function buildCsv(lines: string[]): string {
  return [CSV_HEADER, ...lines].join('\n');
}

describe('isBossaFormat', () => {
  it('detects real Bossa header (semicolon-delimited)', () => {
    expect(isBossaFormat(CSV_HEADER + '\n')).toBe(true);
  });

  it('NIE klasyfikuje pierwszej linii zawierającej słowa data/papier/isin luzem', () => {
    // Stary detektor (substring na pierwszej linii) dawał tu false-positive.
    expect(isBossaFormat('eksport: data papier isin\n')).toBe(false);
  });

  it('NIE klasyfikuje nagłówka DEGIRO (przecinki, nie średniki)', () => {
    expect(isBossaFormat('Data,Czas,Produkt,ISIN,Kurs wymiany,Razem\n')).toBe(false);
  });
});

describe('parseBossaTransactions', () => {
  it('skips rows with price <= 0 as invalid_price', () => {
    const csv = buildCsv(['25.02.2026;KGHM;PLKGHM000017;K;10;0;0;0;0;PLN']);
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('invalid_price');
  });

  it('parses valid transaction correctly', () => {
    const csv = buildCsv(['25.02.2026;KGHM;PLKGHM000017;K;10;150.50;1505.00;5.00;1510.00;PLN']);
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.data[0].paperName).toBe('KGHM');
    expect(result.data[0].quantity).toBe(10);
    expect(result.data[0].price).toBe(150.5);
    expect(result.data[0].side).toBe('K');
  });

  it('returns empty result for empty CSV', () => {
    const result = parseBossaTransactions('', 'batch-test');
    expect(result.data).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});
