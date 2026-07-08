import { describe, it, expect } from 'vitest';
import { computePositionMetrics, computeClosedTrades } from '../portfolio-engine.js';
import type { Transaction } from 'shared';

function makeTx(
  overrides: Partial<Transaction> & { side: 'K' | 'S'; quantity: number; price: number },
): Transaction {
  const commission = overrides.commission ?? 0;
  const value = overrides.quantity * overrides.price;
  return {
    date: '2024-01-01',
    paperName: 'TEST',
    isin: 'TEST0001',
    currency: 'PLN',
    commission,
    value,
    total: overrides.side === 'K' ? value + commission : value - commission,
    source: 'manual',
    ...overrides,
  };
}

describe('computePositionMetrics', () => {
  it('single buy — returns full position', () => {
    const txs = [makeTx({ side: 'K', quantity: 100, price: 10 })];
    const result = computePositionMetrics(txs);
    expect(result.shares).toBe(100);
    expect(result.avgBuyPrice).toBe(10);
  });

  it('multiple buys — weighted average price', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 100, price: 10, date: '2024-01-01' }),
      makeTx({ side: 'K', quantity: 100, price: 20, date: '2024-02-01' }),
    ];
    const result = computePositionMetrics(txs);
    expect(result.shares).toBe(200);
    expect(result.avgBuyPrice).toBe(15); // (100*10 + 100*20) / 200
  });

  it('buy then full sell — zero shares', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 100, price: 10, date: '2024-01-01' }),
      makeTx({ side: 'S', quantity: 100, price: 15, date: '2024-02-01' }),
    ];
    const result = computePositionMetrics(txs);
    expect(result.shares).toBe(0);
    expect(result.avgBuyPrice).toBe(0);
  });

  it('FIFO — partial sell removes from first lot', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 50, price: 10, date: '2024-01-01' }),
      makeTx({ side: 'K', quantity: 50, price: 20, date: '2024-02-01' }),
      makeTx({ side: 'S', quantity: 30, price: 25, date: '2024-03-01' }),
    ];
    const result = computePositionMetrics(txs);
    // After FIFO sell 30: first lot 50→20 @10, second lot 50 @20
    expect(result.shares).toBe(70);
    expect(result.avgBuyPrice).toBeCloseTo((20 * 10 + 50 * 20) / 70);
  });

  it('FIFO — sell spanning two lots', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 30, price: 10, date: '2024-01-01' }),
      makeTx({ side: 'K', quantity: 30, price: 20, date: '2024-02-01' }),
      makeTx({ side: 'S', quantity: 40, price: 25, date: '2024-03-01' }),
    ];
    const result = computePositionMetrics(txs);
    // Sell 40: eats all 30 from lot 1, then 10 from lot 2 → remaining 20 @20
    expect(result.shares).toBe(20);
    expect(result.avgBuyPrice).toBe(20);
  });

  it('tracks total commission across all transactions', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 100, price: 10, commission: 5, date: '2024-01-01' }),
      makeTx({ side: 'S', quantity: 50, price: 15, commission: 3, date: '2024-02-01' }),
    ];
    const result = computePositionMetrics(txs);
    expect(result.totalCommission).toBe(8);
  });

  it('handles fractional shares', () => {
    const txs = [makeTx({ side: 'K', quantity: 0.5, price: 494.15, date: '2024-01-01' })];
    const result = computePositionMetrics(txs);
    expect(result.shares).toBeCloseTo(0.5);
    expect(result.avgBuyPrice).toBeCloseTo(494.15);
  });

  it('returns PLN as default currency', () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 100 })];
    const result = computePositionMetrics(txs);
    expect(result.buyCurrency).toBe('PLN');
  });

  it('returns USD when bought in USD', () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 100, currency: 'USD' })];
    const result = computePositionMetrics(txs);
    expect(result.buyCurrency).toBe('USD');
  });
});

describe('computeClosedTrades — round-tripy (tradeGroupId)', () => {
  const NO_MAP = new Map();

  it('partial fille jednego zlecenia (1 kupno → 2 sprzedaże) = JEDEN round-trip', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 100, price: 10, date: '2024-01-01' }),
      makeTx({ side: 'S', quantity: 40, price: 12, date: '2024-02-01T10:00:00' }),
      makeTx({ side: 'S', quantity: 60, price: 11, date: '2024-02-01T10:00:05' }),
    ];
    const trades = computeClosedTrades(txs, NO_MAP);
    const ids = new Set(trades.map((t) => t.tradeGroupId));
    expect(ids.size).toBe(1);
    // Pozycja domknięta do zera → żadna noga nie jest oznaczona jako otwarta.
    expect(trades.every((t) => !t.tradeGroupOpen)).toBe(true);
  });

  it('scale-in (2 kupna) + jedna sprzedaż = JEDEN round-trip mimo 2 nóg FIFO', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 10, date: '2024-01-01' }),
      makeTx({ side: 'K', quantity: 10, price: 20, date: '2024-01-15' }),
      makeTx({ side: 'S', quantity: 20, price: 15, date: '2024-02-01' }),
    ];
    const trades = computeClosedTrades(txs, NO_MAP);
    expect(trades).toHaveLength(2); // FIFO rozbija po lotach kupna
    expect(new Set(trades.map((t) => t.tradeGroupId)).size).toBe(1);
  });

  it('pozycja zamknięta do zera i otwarta ponownie = DWA round-tripy', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 10, date: '2024-01-01' }),
      makeTx({ side: 'S', quantity: 10, price: 12, date: '2024-02-01' }),
      makeTx({ side: 'K', quantity: 10, price: 11, date: '2024-03-01' }),
      makeTx({ side: 'S', quantity: 10, price: 9, date: '2024-04-01' }),
    ];
    const trades = computeClosedTrades(txs, NO_MAP);
    expect(new Set(trades.map((t) => t.tradeGroupId)).size).toBe(2);
  });

  it('pozycja częściowo zrealizowana (kupno 100, sprzedaż 40) → tradeGroupOpen', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 100, price: 10, date: '2024-01-01' }),
      makeTx({ side: 'S', quantity: 40, price: 12, date: '2024-02-01' }),
    ];
    const trades = computeClosedTrades(txs, NO_MAP);
    expect(trades).toHaveLength(1);
    expect(trades[0].tradeGroupOpen).toBe(true);
  });
});

describe('computeClosedTrades — kursy brokera z nóg (fxRateOpen/Close)', () => {
  const NO_MAP = new Map();

  it('nogi z rozliczeniem PLN przenoszą tx.fxRate do fxRateOpen/Close', () => {
    // XTB: kupno i sprzedaż USD rozliczone w PLN, dokładne kursy implied z kwot.
    const txs = [
      makeTx({
        side: 'K',
        quantity: 64,
        price: 16,
        date: '2024-01-01',
        currency: 'USD',
        paymentCurrency: 'PLN',
        fxRate: 3.827002,
      }),
      makeTx({
        side: 'S',
        quantity: 64,
        price: 26.07,
        date: '2024-02-01',
        currency: 'USD',
        paymentCurrency: 'PLN',
        fxRate: 3.696898,
        id: 7,
      }),
    ];
    const trades = computeClosedTrades(txs, NO_MAP);
    expect(trades).toHaveLength(1);
    expect(trades[0].fxRateOpen).toBeCloseTo(3.827002, 6);
    expect(trades[0].fxRateClose).toBeCloseTo(3.696898, 6);
  });

  it('kupno z kursem + sprzedaż bez kursu → tylko fxRateOpen (druga strona z fallbacku dziennego)', () => {
    const txs = [
      makeTx({
        side: 'K',
        quantity: 10,
        price: 16,
        date: '2024-01-01',
        currency: 'USD',
        paymentCurrency: 'PLN',
        fxRate: 3.8,
      }),
      makeTx({
        side: 'S',
        quantity: 10,
        price: 26,
        date: '2024-02-01',
        currency: 'USD',
        paymentCurrency: 'PLN',
        id: 7,
      }),
    ];
    const trades = computeClosedTrades(txs, NO_MAP);
    expect(trades[0].fxRateOpen).toBeCloseTo(3.8, 6);
    expect(trades[0].fxRateClose).toBeUndefined();
  });

  it('rozliczenie w walucie innej niż PLN (DEGIRO EUR) NIE ustawia kursów — kurs EUR-per-quote nie nadaje się do PLN', () => {
    const txs = [
      makeTx({
        side: 'K',
        quantity: 10,
        price: 100,
        date: '2024-01-01',
        currency: 'USD',
        paymentCurrency: 'EUR',
        fxRate: 0.92,
      }),
      makeTx({
        side: 'S',
        quantity: 10,
        price: 110,
        date: '2024-02-01',
        currency: 'USD',
        paymentCurrency: 'EUR',
        fxRate: 0.93,
        id: 7,
      }),
    ];
    const trades = computeClosedTrades(txs, NO_MAP);
    expect(trades[0].fxRateOpen).toBeUndefined();
    expect(trades[0].fxRateClose).toBeUndefined();
  });

  it('partial fill: każda para nóg dostaje kursy SWOICH transakcji', () => {
    const txs = [
      makeTx({
        side: 'K',
        quantity: 100,
        price: 10,
        date: '2024-01-01',
        currency: 'USD',
        paymentCurrency: 'PLN',
        fxRate: 4.0,
      }),
      makeTx({
        side: 'S',
        quantity: 40,
        price: 12,
        date: '2024-02-01',
        currency: 'USD',
        paymentCurrency: 'PLN',
        fxRate: 4.1,
        id: 7,
      }),
      makeTx({
        side: 'S',
        quantity: 60,
        price: 11,
        date: '2024-03-01',
        currency: 'USD',
        paymentCurrency: 'PLN',
        fxRate: 4.2,
        id: 8,
      }),
    ];
    const trades = computeClosedTrades(txs, NO_MAP);
    expect(trades).toHaveLength(2);
    expect(trades.every((t) => t.fxRateOpen === 4.0)).toBe(true);
    expect(trades.map((t) => t.fxRateClose).sort()).toEqual([4.1, 4.2]);
  });
});
