import { describe, it, expect } from 'vitest';
import { extractFxExchanges, getSharesAtDate } from '../portfolio-engine.js';
import type { CashOperation, Transaction } from 'shared';

function makeFxOp(overrides: Partial<CashOperation> & { amount: number }): CashOperation {
  return {
    date: '2024-03-01',
    operationType: 'fx_exchange',
    description: 'Wymiana walut',
    currency: 'PLN',
    source: 'manual',
    ...overrides,
  };
}

describe('extractFxExchanges', () => {
  it('paruje normalną parę: ujemna PLN + dodatnia USD na tej samej dacie', () => {
    const ops = [
      makeFxOp({ id: 1, amount: -400, currency: 'PLN', fxRate: 4.0, fxPair: 'PLN/USD' }),
      makeFxOp({ id: 2, amount: 100, currency: 'USD', fxPair: 'PLN/USD' }),
    ];
    const records = extractFxExchanges(ops);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      pair: 'PLN/USD',
      rate: 4.0,
      amountFrom: 400,
      currencyFrom: 'PLN',
      amountTo: 100,
      currencyTo: 'USD',
      fromOperationId: 1,
      toOperationId: 2,
    });
  });

  it('paruje dwie przeplecione wymiany na jednej dacie po fxPair', () => {
    // Kolejność po id: -PLN(USD), -PLN(EUR), +EUR, +USD — pozycyjne parowanie
    // (i, i+1) zgubiłoby obie wymiany; parowanie po fxPair odzyskuje obie.
    const ops = [
      makeFxOp({ id: 1, amount: -400, currency: 'PLN', fxPair: 'PLN/USD', fxRate: 4.0 }),
      makeFxOp({ id: 2, amount: -430, currency: 'PLN', fxPair: 'PLN/EUR', fxRate: 4.3 }),
      makeFxOp({ id: 3, amount: 100, currency: 'EUR', fxPair: 'PLN/EUR' }),
      makeFxOp({ id: 4, amount: 100, currency: 'USD', fxPair: 'PLN/USD' }),
    ];
    const records = extractFxExchanges(ops);
    expect(records).toHaveLength(2);
    const usd = records.find((r) => r.currencyTo === 'USD');
    const eur = records.find((r) => r.currencyTo === 'EUR');
    expect(usd).toMatchObject({ fromOperationId: 1, toOperationId: 4, rate: 4.0 });
    expect(eur).toMatchObject({ fromOperationId: 2, toOperationId: 3, rate: 4.3 });
  });

  it('paruje przeplecione wymiany bez fxPair po różnej walucie (best effort)', () => {
    // Wymiany w przeciwnych kierunkach: USD→PLN i PLN→USD na jednej dacie
    const ops = [
      makeFxOp({ id: 1, amount: -100, currency: 'USD' }),
      makeFxOp({ id: 2, amount: -200, currency: 'PLN' }),
      makeFxOp({ id: 3, amount: 400, currency: 'PLN' }),
      makeFxOp({ id: 4, amount: 50, currency: 'USD' }),
    ];
    const records = extractFxExchanges(ops);
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.currencyFrom === 'USD')).toMatchObject({
      fromOperationId: 1,
      toOperationId: 3,
      currencyTo: 'PLN',
    });
    expect(records.find((r) => r.currencyFrom === 'PLN')).toMatchObject({
      fromOperationId: 2,
      toOperationId: 4,
      currencyTo: 'USD',
    });
  });

  it('nieparzysta liczba nóg — noga bez pary jest pomijana, reszta sparowana', () => {
    const ops = [
      makeFxOp({ id: 1, amount: -400, currency: 'PLN', fxPair: 'PLN/USD', fxRate: 4.0 }),
      makeFxOp({ id: 2, amount: 100, currency: 'USD', fxPair: 'PLN/USD' }),
      // Osierocona noga (np. zaimportowana połówka wymiany)
      makeFxOp({ id: 3, amount: -215, currency: 'PLN', fxPair: 'PLN/EUR', fxRate: 4.3 }),
    ];
    const records = extractFxExchanges(ops);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ fromOperationId: 1, toOperationId: 2 });
  });

  it('nie paruje dwóch nóg w tej samej walucie', () => {
    const ops = [
      makeFxOp({ id: 1, amount: -400, currency: 'PLN' }),
      makeFxOp({ id: 2, amount: 400, currency: 'PLN' }),
    ];
    expect(extractFxExchanges(ops)).toHaveLength(0);
  });
});

function makeTx(
  overrides: Partial<Transaction> & { side: 'K' | 'S'; quantity: number; date: string },
): Transaction {
  const price = overrides.price ?? 10;
  const value = overrides.quantity * price;
  return {
    paperName: 'TEST',
    isin: 'TEST0001',
    currency: 'PLN',
    price,
    commission: 0,
    value,
    total: value,
    source: 'manual',
    ...overrides,
  };
}

describe('getSharesAtDate', () => {
  const txs = [
    makeTx({ side: 'K', quantity: 100, date: '2024-01-10' }),
    makeTx({ side: 'K', quantity: 50, date: '2024-02-01' }),
    makeTx({ side: 'S', quantity: 30, date: '2024-03-01' }),
  ];

  it('domyślnie EXCLUSIVE — semantyka ex-date: kupno w dniu ex-date nie łapie się', () => {
    // Uprawnienie do dywidendy mają akcje posiadane PRZED ex-date,
    // dlatego transakcja z 2024-02-01 nie wlicza się na datę 2024-02-01.
    expect(getSharesAtDate(txs, 'TEST0001', '2024-02-01')).toBe(100);
    expect(getSharesAtDate(txs, 'TEST0001', '2024-02-02')).toBe(150);
    expect(getSharesAtDate(txs, 'TEST0001', '2024-03-01')).toBe(150);
    expect(getSharesAtDate(txs, 'TEST0001', '2024-03-02')).toBe(120);
  });

  it('includeDate=true — stan posiadania włącznie z transakcjami z danego dnia', () => {
    expect(getSharesAtDate(txs, 'TEST0001', '2024-02-01', true)).toBe(150);
    expect(getSharesAtDate(txs, 'TEST0001', '2024-03-01', true)).toBe(120);
  });

  it('zwraca 0 przed pierwszą transakcją i dla obcego ISIN', () => {
    expect(getSharesAtDate(txs, 'TEST0001', '2024-01-10')).toBe(0);
    expect(getSharesAtDate(txs, 'OTHER001', '2024-12-31')).toBe(0);
  });
});
