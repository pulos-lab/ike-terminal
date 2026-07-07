import { describe, it, expect } from 'vitest';
import { parseDegiroOperations, parseDegiroTransactionTaxes } from '../degiro-operations.js';
import { parseDegiroTransactions } from '../degiro-transactions.js';

// ── Fixtures ──

const ACCOUNT_HEADER =
  'Data,Czas,Data,Produkt,ISIN,Opis,Kurs,Zmiana,,Saldo,,Identyfikator zlecenia';

function accountCsv(rows: string[]): string {
  return [ACCOUNT_HEADER, ...rows].join('\n');
}

const TX_HEADER =
  'Data,Czas,Produkt,ISIN,Giełda referencyjna,Miejsce wykonania,Liczba,Kurs,,Wartość lokalna,,Wartość EUR,Kurs wymiany,Opłaty AutoFX,Opłata transakcyjna DEGIRO i/lub opłata stron,,Razem EUR,,Identyfikator zlecenia';

function txCsv(rows: string[]): string {
  return [TX_HEADER, ...rows].join('\n');
}

// ── parseDegiroOperations: parowanie dywidenda + podatek ──

describe('parseDegiroOperations — dywidendy', () => {
  it('paruje dywidendę z podatkiem po ISIN+data+czas', () => {
    const csv = accountCsv([
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Dywidenda,,USD,"100,00",,USD,',
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Podatek Dywidendowy,,USD,"-15,00",,USD,',
    ]);
    const { data } = parseDegiroOperations(csv, 'batch-1');
    const dividends = data.filter((o) => o.operationType === 'dividend');
    expect(dividends).toHaveLength(1);
    expect(dividends[0].amount).toBe(85);
  });

  it('NIE odlicza jednego wiersza podatku od dwóch dywidend o tym samym timestampie', () => {
    // Dwie dywidendy (np. częściowe księgowania) + jeden podatek 15.
    // Przed fixem obie dywidendy znajdowały ten sam wiersz podatku → 70+35 zamiast 85+50.
    const csv = accountCsv([
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Dywidenda,,USD,"100,00",,USD,',
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Dywidenda,,USD,"50,00",,USD,',
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Podatek Dywidendowy,,USD,"-15,00",,USD,',
    ]);
    const { data } = parseDegiroOperations(csv, 'batch-1');
    const dividends = data.filter((o) => o.operationType === 'dividend');
    expect(dividends).toHaveLength(2);
    const total = dividends.reduce((s, d) => s + d.amount, 0);
    // 100−15 + 50−0 = 135 (podatek odliczony dokładnie raz)
    expect(total).toBe(135);
  });

  it('paruje dwa podatki z dwiema dywidendami 1:1', () => {
    const csv = accountCsv([
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Dywidenda,,USD,"100,00",,USD,',
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Dywidenda,,USD,"100,00",,USD,',
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Podatek Dywidendowy,,USD,"-15,00",,USD,',
      '01-03-2024,09:00,01-03-2024,APPLE INC,US0378331005,Podatek Dywidendowy,,USD,"-15,00",,USD,',
    ]);
    const { data } = parseDegiroOperations(csv, 'batch-1');
    const dividends = data.filter((o) => o.operationType === 'dividend');
    expect(dividends).toHaveLength(2);
    expect(dividends.every((d) => d.amount === 85)).toBe(true);
  });
});

// ── parseDegiroTransactionTaxes ──

describe('parseDegiroTransactionTaxes', () => {
  it('wyciąga stamp duty z ISIN-em, datą i kwotą bezwzględną', () => {
    const csv = accountCsv([
      '05-02-2024,10:30,05-02-2024,VODAFONE,GB00BH4HKS39,London/Dublin Stamp Duty,,GBP,"-2,50",,GBP,xyz',
    ]);
    const taxes = parseDegiroTransactionTaxes(csv);
    expect(taxes).toHaveLength(1);
    expect(taxes[0].isin).toBe('GB00BH4HKS39');
    expect(taxes[0].amount).toBe(2.5);
    expect(taxes[0].date.startsWith('2024-02-05')).toBe(true);
  });
});

// ── parseDegiroTransactions: GBX → GBP ──

describe('parseDegiroTransactions — GBX', () => {
  it('konwertuje GBX→GBP bez przedwczesnego zaokrąglania ceny', () => {
    // 1000 szt. po 1234.5 GBX = £12,345.00 — zaokrąglenie ceny do 12.35
    // dawałoby value 12,350.00 (£5 błędu)
    const csv = txCsv([
      '05-02-2024,10:30,VODAFONE,GB00BH4HKS39,LSE,XLON,1000,"1234,5",GBX,"1234500,00",GBX,"14500,00","0,8500",,"-2,50","EUR","-14502,50",EUR,xyz',
    ]);
    const { data, skipped } = parseDegiroTransactions(csv, 'batch-1');
    expect(skipped).toHaveLength(0);
    expect(data).toHaveLength(1);
    expect(data[0].currency).toBe('GBP');
    expect(data[0].price).toBeCloseTo(12.345, 10);
    expect(data[0].value).toBe(12345);
    expect(data[0].total).toBe(12345);
  });

  it('odwraca "Kurs wymiany" do konwencji payment-per-quote (EUR za 1 GBP, z mnożnikiem GBX)', () => {
    // Realne wiersze DEGIRO: "Kurs wymiany" to quote-per-payment (87.0405 GBX za 1 EUR).
    // Cena/value konwertowane do GBP, więc fxRate = 100/87.0405 ≈ 1.1489 EUR za 1 GBP;
    // total × fxRate musi odtworzyć kwotę EUR z pliku (887.86).
    const csv = txCsv([
      '26-02-2021,09:49,ROLLS-ROYCE HOLDINGS PLC,GB00B63H8491,LSE,AQXE,-700,"110,4000",GBX,"77280,00",GBX,"887,86","87,0405","-0,89","-4,44","EUR","882,53",EUR,xyz',
    ]);
    const { data } = parseDegiroTransactions(csv, 'batch-1');
    expect(data).toHaveLength(1);
    expect(data[0].fxRate).toBeCloseTo(100 / 87.0405, 8);
    expect(data[0].total * data[0].fxRate!).toBeCloseTo(887.86, 1);
  });

  it('odwraca "Kurs wymiany" dla walut bez pensów (PLN: 4.3127 → ~0.2319 EUR za 1 PLN)', () => {
    const csv = txCsv([
      '27-03-2024,11:41,ML SYSTEM SA,PLMLSTM00015,WSE,XWAR,-70,"43,7000",PLN,"3059,00",PLN,"709,30","4,3127","0,00",,"EUR","709,30",EUR,abc',
    ]);
    const { data } = parseDegiroTransactions(csv, 'batch-1');
    expect(data).toHaveLength(1);
    expect(data[0].currency).toBe('PLN');
    expect(data[0].fxRate).toBeCloseTo(1 / 4.3127, 8);
    expect(data[0].total * data[0].fxRate!).toBeCloseTo(709.3, 1);
  });

  it('strona K/S z znaku Liczba, fractional shares zachowane', () => {
    const csv = txCsv([
      '05-02-2024,10:30,APPLE INC,US0378331005,NASDAQ,XNAS,"0,3069","494,15",USD,"151,65",USD,"140,00","0,9230",,"-1,00","EUR","-141,00",EUR,abc',
      '06-02-2024,11:00,APPLE INC,US0378331005,NASDAQ,XNAS,"-0,3069","500,00",USD,"-153,45",USD,"-142,00","0,9230",,"-1,00","EUR","141,00",EUR,def',
    ]);
    const { data } = parseDegiroTransactions(csv, 'batch-1');
    expect(data).toHaveLength(2);
    expect(data[0].side).toBe('K');
    expect(data[0].quantity).toBeCloseTo(0.3069, 6);
    expect(data[1].side).toBe('S');
  });
});
