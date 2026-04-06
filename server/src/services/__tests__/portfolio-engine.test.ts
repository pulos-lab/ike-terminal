import { describe, it, expect } from 'vitest';
import { computePositionMetrics } from '../portfolio-engine.js';
import type { Transaction } from 'shared';

function makeTx(overrides: Partial<Transaction> & { side: 'K' | 'S'; quantity: number; price: number }): Transaction {
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
    const txs = [
      makeTx({ side: 'K', quantity: 0.5, price: 494.15, date: '2024-01-01' }),
    ];
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
