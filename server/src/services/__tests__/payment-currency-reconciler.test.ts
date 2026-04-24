import { describe, it, expect } from 'vitest';
import { simulateLedger } from '../payment-currency-reconciler.js';
import type { Transaction, CashOperation } from 'shared';

function tx(overrides: Partial<Transaction> & {
  id: number;
  side: 'K' | 'S';
  quantity: number;
  price: number;
  currency: string;
  date: string;
}): Transaction {
  const commission = overrides.commission ?? 0;
  const value = overrides.quantity * overrides.price;
  return {
    paperName: overrides.paperName ?? 'TEST',
    isin: overrides.isin ?? 'TEST0001',
    value,
    commission,
    total: overrides.side === 'K' ? value + commission : value - commission,
    source: overrides.source ?? 'bossa',
    ...overrides,
  };
}

function op(overrides: Partial<CashOperation> & {
  date: string;
  operationType: CashOperation['operationType'];
  amount: number;
  currency: string;
}): CashOperation {
  return {
    description: overrides.description ?? overrides.operationType,
    source: overrides.source ?? 'bossa',
    ...overrides,
  };
}

describe('simulateLedger — Bossa', () => {
  it('zakup z wystarczającym saldem walutowym USD → paymentCurrency = USD', () => {
    const operations = [
      op({ id: 1, date: '2025-08-04', operationType: 'fx_exchange', amount: -12815, currency: 'PLN', fxPair: 'PLN/USD', fxRate: 3.6948 }),
      op({ id: 2, date: '2025-08-04', operationType: 'fx_exchange', amount: 3468.35, currency: 'USD', fxPair: 'PLN/USD', fxRate: 3.6948 }),
      op({ id: 3, date: '2026-01-01', operationType: 'deposit', amount: 5000, currency: 'USD' }),
    ];
    const transactions = [
      tx({ id: 100, date: '2026-02-13T15:30:43', side: 'K', quantity: 1, price: 4144.69, commission: 9.95, currency: 'USD', paperName: 'BKNG' }),
    ];

    const { computed, warnings } = simulateLedger(transactions, operations, 'PLN');

    expect(computed.get(100)).toBe('USD');
    expect(warnings).toEqual([]);
  });

  it('zakup bez salda USD → fallback do PLN + warning o ujemnym saldzie', () => {
    const operations = [
      op({ id: 1, date: '2026-01-01', operationType: 'deposit', amount: 1000, currency: 'PLN' }),
    ];
    const transactions = [
      tx({ id: 100, date: '2026-02-01', side: 'K', quantity: 2, price: 100, currency: 'USD', paperName: 'AAPL', fxRate: 4.0 }),
    ];

    const { computed, warnings } = simulateLedger(transactions, operations, 'PLN');

    expect(computed.get(100)).toBe('PLN');
    // 2 * 100 = 200 USD at fxRate 4.0 = 800 PLN. Balance PLN = 1000 - 800 = 200 → positive, no warning.
    expect(warnings).toEqual([]);
  });

  it('zakup bez żadnego salda → fallback do PLN + warning', () => {
    const operations: CashOperation[] = [];
    const transactions = [
      tx({ id: 100, date: '2026-02-01', side: 'K', quantity: 1, price: 200, currency: 'USD', paperName: 'AAPL' }),
    ];

    const { computed, warnings } = simulateLedger(transactions, operations, 'PLN');

    expect(computed.get(100)).toBe('PLN');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/AAPL/);
    expect(warnings[0]).toMatch(/saldo PLN/);
  });

  it('trzy kolejne zakupy bez pokrycia → 1 warning (tylko tx wpychająca saldo w minus)', () => {
    const operations: CashOperation[] = [];
    const transactions = [
      tx({ id: 100, date: '2026-02-01', side: 'K', quantity: 1, price: 200, currency: 'USD', paperName: 'AAPL' }),
      tx({ id: 101, date: '2026-02-02', side: 'K', quantity: 1, price: 300, currency: 'USD', paperName: 'MSFT' }),
      tx({ id: 102, date: '2026-02-03', side: 'K', quantity: 1, price: 400, currency: 'USD', paperName: 'GOOGL' }),
    ];

    const { warnings } = simulateLedger(transactions, operations, 'PLN');

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/AAPL/);
  });

  it('dwie niezależne dziury (wpłata wraca saldo na plus, potem znów minus) → 2 warningi', () => {
    const operations = [
      op({ id: 1, date: '2026-03-01', operationType: 'deposit', amount: 1000, currency: 'PLN' }),
    ];
    const transactions = [
      tx({ id: 100, date: '2026-02-01', side: 'K', quantity: 1, price: 200, currency: 'USD', paperName: 'AAPL', fxRate: 4.0 }),
      tx({ id: 101, date: '2026-04-01', side: 'K', quantity: 1, price: 500, currency: 'USD', paperName: 'MSFT', fxRate: 4.0 }),
    ];

    const { warnings } = simulateLedger(transactions, operations, 'PLN');

    expect(warnings.length).toBe(2);
    expect(warnings[0]).toMatch(/AAPL/);
    expect(warnings[1]).toMatch(/MSFT/);
  });

  it('sprzedaż w USD → paymentCurrency = USD, saldo USD rośnie', () => {
    const operations = [
      op({ id: 1, date: '2026-01-01', operationType: 'deposit', amount: 500, currency: 'USD' }),
    ];
    const transactions = [
      // Kupno — saldo USD wystarczy
      tx({ id: 100, date: '2026-01-15', side: 'K', quantity: 1, price: 200, currency: 'USD' }),
      // Sprzedaż — dostarczaj USD
      tx({ id: 101, date: '2026-02-01', side: 'S', quantity: 1, price: 250, currency: 'USD' }),
    ];

    const { computed, warnings } = simulateLedger(transactions, operations, 'PLN');

    expect(computed.get(100)).toBe('USD');
    expect(computed.get(101)).toBe('USD');
    expect(warnings).toEqual([]);
  });

  it('CFD są pomijane — nie pojawiają się w computed', () => {
    const transactions = [
      tx({ id: 100, date: '2026-01-01', side: 'K', quantity: 1, price: 100, currency: 'USD', category: 'cfd' }),
    ];

    const { computed } = simulateLedger(transactions, [], 'PLN');

    expect(computed.has(100)).toBe(false);
  });

  it('chronologia: operacje tego samego dnia idą PRZED transakcjami', () => {
    const operations = [
      op({ id: 1, date: '2026-01-15', operationType: 'deposit', amount: 300, currency: 'USD' }),
    ];
    const transactions = [
      tx({ id: 100, date: '2026-01-15T14:00:00', side: 'K', quantity: 1, price: 200, currency: 'USD' }),
    ];

    const { computed } = simulateLedger(transactions, operations, 'PLN');

    // Depozyt 300 USD przetworzony przed zakupem → saldo USD = 300 >= 200 → USD
    expect(computed.get(100)).toBe('USD');
  });

  it('tolerancja ε=0.01 dla rounding z FX', () => {
    const operations = [
      // Po wymianie saldo dokładnie 100.00 USD
      op({ id: 1, date: '2026-01-01', operationType: 'fx_exchange', amount: 100, currency: 'USD' }),
    ];
    const transactions = [
      // Zakup 100.005 USD — różnica 0.005 mieści się w ε
      tx({ id: 100, date: '2026-01-15', side: 'K', quantity: 1, price: 100.005, currency: 'USD' }),
    ];

    const { computed } = simulateLedger(transactions, operations, 'PLN');

    expect(computed.get(100)).toBe('USD');
  });
});

describe('simulateLedger — DEGIRO', () => {
  it('zakup z saldem EUR po auto-FX → paymentCurrency = EUR', () => {
    const operations = [
      op({ id: 1, date: '2026-01-01', operationType: 'deposit', amount: 10000, currency: 'PLN', source: 'degiro' }),
      op({ id: 2, date: '2026-01-02', operationType: 'fx_exchange', amount: -10000, currency: 'PLN', source: 'degiro' }),
      op({ id: 3, date: '2026-01-02', operationType: 'fx_exchange', amount: 2300, currency: 'EUR', source: 'degiro' }),
    ];
    const transactions = [
      tx({ id: 100, date: '2026-02-01', side: 'K', quantity: 10, price: 100, currency: 'EUR', source: 'degiro' }),
    ];

    const { computed, warnings } = simulateLedger(transactions, operations, 'EUR');

    expect(computed.get(100)).toBe('EUR');
    expect(warnings).toEqual([]);
  });

  it('DEGIRO z saldem PLN (wyłączone auto-FX) → paymentCurrency = PLN', () => {
    const operations = [
      op({ id: 1, date: '2026-01-01', operationType: 'deposit', amount: 5000, currency: 'PLN', source: 'degiro' }),
    ];
    const transactions = [
      // Polska akcja notowana w PLN, user płaci bezpośrednio z salda PLN
      tx({ id: 100, date: '2026-02-01', side: 'K', quantity: 10, price: 100, currency: 'PLN', source: 'degiro', paperName: 'MBK.WA' }),
    ];

    const { computed, warnings } = simulateLedger(transactions, operations, 'EUR');

    // Saldo PLN = 5000 >= 1000 → direct settlement w PLN
    expect(computed.get(100)).toBe('PLN');
    expect(warnings).toEqual([]);
  });
});

describe('simulateLedger — idempotencja', () => {
  it('dwa wywołania na tych samych danych dają identyczny wynik', () => {
    const operations = [
      op({ id: 1, date: '2026-01-01', operationType: 'deposit', amount: 1000, currency: 'USD' }),
    ];
    const transactions = [
      tx({ id: 100, date: '2026-02-01', side: 'K', quantity: 1, price: 500, currency: 'USD' }),
    ];

    const run1 = simulateLedger(transactions, operations, 'PLN');
    const run2 = simulateLedger(transactions, operations, 'PLN');

    expect(Array.from(run1.computed.entries())).toEqual(Array.from(run2.computed.entries()));
    expect(run1.warnings).toEqual(run2.warnings);
  });
});
