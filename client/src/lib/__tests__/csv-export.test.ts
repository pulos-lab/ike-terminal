import { describe, it, expect } from 'vitest';
import type { DividendRecord, TransactionWithMeta } from 'shared';
import { csvDate, csvFilename, toCsv, type CsvColumn } from '../csv-export';
import { DIVIDEND_COLUMNS, TRANSACTION_COLUMNS } from '../csv-columns';

interface Row {
  name: string;
  qty: number | null;
  ok?: boolean;
}
const COLS: CsvColumn<Row>[] = [
  { header: 'Nazwa', value: (r) => r.name },
  { header: 'Ilość', value: (r) => r.qty },
  { header: 'OK', value: (r) => r.ok },
];

/** Wiersze bez BOM-u i końcowego CRLF. */
const lines = (csv: string) => csv.replace(/^﻿/, '').replace(/\r\n$/, '').split('\r\n');

describe('toCsv', () => {
  it('BOM, średnik, CRLF i nagłówek', () => {
    const csv = toCsv([{ name: 'PKN', qty: 10 }], COLS);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines(csv)).toEqual(['Nazwa;Ilość;OK', 'PKN;10;']);
  });

  it('liczby: przecinek dziesiętny, bez separatora tysięcy i bez ogona float', () => {
    const csv = toCsv(
      [
        { name: 'a', qty: 1234567.891 },
        { name: 'b', qty: 0.1 + 0.2 },
        { name: 'c', qty: -42.5 },
        { name: 'd', qty: 0.30691234567 },
        { name: 'e', qty: NaN },
      ],
      COLS,
    );
    expect(lines(csv).slice(1)).toEqual([
      'a;1234567,891;',
      'b;0,3;',
      'c;-42,5;',
      'd;0,30691235;',
      'e;;',
    ]);
  });

  it('null/undefined → puste pole, boolean → tak/nie', () => {
    const csv = toCsv([{ name: 'x', qty: null, ok: true }], COLS);
    expect(lines(csv)[1]).toBe('x;;tak');
  });

  it('cytuje pola ze średnikiem, cudzysłowem i nową linią', () => {
    const csv = toCsv(
      [
        { name: 'Blokada;PZE/123', qty: 1 },
        { name: 'Spółka "X" S.A.', qty: 2 },
        { name: 'linia1\nlinia2', qty: 3 },
      ],
      COLS,
    );
    expect(csv).toContain('"Blokada;PZE/123";1;');
    expect(csv).toContain('"Spółka ""X"" S.A.";2;');
    expect(csv).toContain('"linia1\nlinia2";3;');
  });

  it('neutralizuje formuły w TEKŚCIE, nie rusza liczb ujemnych', () => {
    const csv = toCsv(
      [
        { name: '=HYPERLINK("http://evil","klik")', qty: -5 },
        { name: '+48 123', qty: 1 },
        { name: '-cmd', qty: 1 },
        { name: '@SUM(A1)', qty: 1 },
      ],
      COLS,
    );
    const [, a, b, c, d] = lines(csv);
    expect(a.startsWith(`"'=HYPERLINK(`)).toBe(true);
    expect(a.endsWith(';-5;')).toBe(true);
    expect(b).toBe(`'+48 123;1;`);
    expect(c).toBe(`'-cmd;1;`);
    expect(d).toBe(`'@SUM(A1);1;`);
  });

  it('pusta lista daje sam nagłówek', () => {
    expect(lines(toCsv([], COLS))).toEqual(['Nazwa;Ilość;OK']);
  });
});

describe('csvDate / csvFilename', () => {
  it('ucina czas z ISO', () => {
    expect(csvDate('2025-03-14T10:00:00')).toBe('2025-03-14');
    expect(csvDate('2025-03-14 10:00:00')).toBe('2025-03-14');
    expect(csvDate(null)).toBe('');
  });

  it('nazwa pliku: rodzaj, portfel bez polskich znaków, data lokalna', () => {
    const date = new Date(2026, 10, 9, 23, 30);
    expect(csvFilename('transakcje', 'Mój portfel IKE (żółty)', date)).toBe(
      'transakcje_moj-portfel-ike-zolty_2026-11-09.csv',
    );
    expect(csvFilename('pozycje', undefined, date)).toBe('pozycje_2026-11-09.csv');
    expect(csvFilename('pozycje', '../../etc/passwd', date)).toBe(
      'pozycje_etc-passwd_2026-11-09.csv',
    );
  });
});

describe('kolumny eksportu', () => {
  it('transakcja: strona słownie, data bez czasu, waluta rozliczenia z fallbackiem', () => {
    const tx = {
      id: 1,
      date: '2025-03-14T10:00:00',
      paperName: 'APPLE INC',
      name: 'Apple Inc.',
      isin: 'US0378331005',
      ticker: 'AAPL',
      exchange: 'NASDAQ',
      quantity: 0.3069,
      side: 'K',
      price: 494.15,
      value: 151.65,
      commission: 0,
      total: 151.65,
      currency: 'USD',
      paymentCurrency: '',
      category: 'stock',
    } as TransactionWithMeta;
    const [, row] = lines(toCsv([tx], TRANSACTION_COLUMNS));
    expect(row).toBe(
      '2025-03-14;AAPL;Apple Inc.;US0378331005;Kupno;0,3069;494,15;USD;151,65;0;151,65;USD;;stock;NASDAQ',
    );
  });

  it('dywidenda: kupon rozróżniony, brak kursu PLN = puste pole', () => {
    const d: DividendRecord = {
      id: 7,
      date: '2025-06-02',
      ticker: 'PKN.WA',
      description: 'Dywidenda PKN',
      amount: 405,
      currency: 'PLN',
      source: 'auto-yahoo',
      subkind: 'coupon',
      amountPln: null,
      isin: null,
    };
    const [header, row] = lines(toCsv([d], DIVIDEND_COLUMNS));
    expect(header.split(';')).toHaveLength(DIVIDEND_COLUMNS.length);
    expect(row).toBe('2025-06-02;PKN.WA;Kupon;405;PLN;;Dywidenda PKN;auto-yahoo;');
  });
});
