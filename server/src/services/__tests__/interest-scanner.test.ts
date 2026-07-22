import { describe, it, expect } from 'vitest';
import {
  computeInterestOperations,
  buildCashDeltas,
  AUTO_INTEREST_BATCH,
} from '../interest-scanner.js';
import type { CashOperation, FreeCashInterestRate, Transaction } from 'shared';

// ── Fabryki minimalnych rekordów ────────────────────────────────────────────
function deposit(date: string, amount: number, currency = 'PLN'): CashOperation {
  return {
    date,
    operationType: 'deposit',
    description: 'wpłata',
    amount,
    currency,
    source: 'manual',
  };
}
function withdrawal(date: string, amount: number, currency = 'PLN'): CashOperation {
  // amount ujemny (konwencja: withdrawal ma znak w amount)
  return {
    date,
    operationType: 'withdrawal',
    description: 'wypłata',
    amount,
    currency,
    source: 'manual',
  };
}
function brokerInterest(date: string, amount: number, currency = 'PLN'): CashOperation {
  return {
    date,
    operationType: 'other',
    subkind: 'interest',
    description: 'Odsetki (broker)',
    amount,
    currency,
    source: 'xtb',
  };
}
function tx(partial: Partial<Transaction>): Transaction {
  return {
    date: '2023-01-01',
    paperName: 'TEST',
    isin: 'TEST0001',
    quantity: 1,
    side: 'K',
    price: 1,
    value: 1,
    commission: 0,
    total: 1,
    currency: 'USD',
    source: 'manual',
    ...partial,
  };
}
const rate = (currency: string, annualRatePct: number, cap?: number): FreeCashInterestRate => ({
  currency,
  annualRatePct,
  cap,
});

describe('computeInterestOperations', () => {
  it('zwraca [] gdy brak aktywnych stawek', () => {
    const ops = [deposit('2023-01-01', 10000)];
    expect(computeInterestOperations([], ops, [], '2024-01-01')).toEqual([]);
    expect(computeInterestOperations([], ops, undefined, '2024-01-01')).toEqual([]);
    // stawka 0 / ujemna jest ignorowana
    expect(computeInterestOperations([], ops, [rate('PLN', 0)], '2024-01-01')).toEqual([]);
  });

  it('nalicza miesięcznie ACT/365 z kapitalizacją (12% na 10000 PLN przez 2023)', () => {
    const ops = [deposit('2023-01-01', 10000)];
    const out = computeInterestOperations([], ops, [rate('PLN', 12)], '2024-01-01');

    // 12 zamkniętych miesięcy 2023
    expect(out).toHaveLength(12);
    const jan = out[0];
    expect(jan.date).toBe('2023-01-31');
    expect(jan.currency).toBe('PLN');
    expect(jan.operationType).toBe('other');
    expect(jan.subkind).toBe('interest');
    expect(jan.source).toBe('auto-interest');
    expect(jan.importBatch).toBe(AUTO_INTEREST_BATCH);
    // 10000 × 0.12 × 31/365 = 101.9178 → 101.92
    expect(jan.amount).toBe(101.92);

    // Luty liczony od salda z kapitalizacją (10101.92, nie 10000):
    // 10101.92 × 0.12 × 28/365 = 92.99 (dowód kapitalizacji: bez niej byłoby 92.05)
    expect(out[1].date).toBe('2023-02-28');
    expect(out[1].amount).toBe(92.99);

    const total = out.reduce((s, o) => s + o.amount, 0);
    // Kapitalizacja > prosty procent (10000×0.12 = 1200)
    expect(total).toBeGreaterThan(1200);
    expect(total).toBeLessThan(1300);
  });

  it('ogranicza podstawę do cap (limit kwoty)', () => {
    const ops = [deposit('2023-01-01', 100000)];
    const out = computeInterestOperations([], ops, [rate('PLN', 12, 10000)], '2024-01-01');
    expect(out).toHaveLength(12);
    // podstawa = min(saldo, 10000) → jak dla salda 10000
    expect(out[0].amount).toBe(101.92);
    // przy cap kapitalizacja NIE podnosi podstawy (saldo wciąż > cap) →
    // luty = 10000 × 0.12 × 28/365 = 92.05 (bez kapitalizacji)
    expect(out[1].amount).toBe(92.05);
  });

  it('osobne stawki per waluta', () => {
    const ops = [deposit('2023-01-01', 10000, 'PLN'), deposit('2023-01-01', 2000, 'USD')];
    const out = computeInterestOperations([], ops, [rate('PLN', 5), rate('USD', 4)], '2023-02-15');
    // 1 zamknięty miesiąc (styczeń) × 2 waluty
    expect(out).toHaveLength(2);
    const pln = out.find((o) => o.currency === 'PLN')!;
    const usd = out.find((o) => o.currency === 'USD')!;
    // 10000 × 0.05 × 31/365 = 42.47
    expect(pln.amount).toBe(42.47);
    // 2000 × 0.04 × 31/365 = 6.79
    expect(usd.amount).toBe(6.79);
  });

  it('pomija miesiąc+walutę gdy istnieją odsetki z importu (anty-dublowanie)', () => {
    const ops = [deposit('2023-01-01', 10000), brokerInterest('2023-02-10', 50)];
    const out = computeInterestOperations([], ops, [rate('PLN', 12)], '2023-04-01');
    // zamknięte miesiące: sty, lut, mar — luty pominięty (broker)
    const months = out.map((o) => o.date.slice(0, 7));
    expect(months).toContain('2023-01');
    expect(months).toContain('2023-03');
    expect(months).not.toContain('2023-02');
  });

  it('nalicza tylko od dodatniego salda (margin/ujemne pomijane)', () => {
    const ops = [deposit('2023-01-01', 10000), withdrawal('2023-01-15', -20000)];
    const out = computeInterestOperations([], ops, [rate('PLN', 12)], '2023-03-01');
    // Styczeń: 14 dni salda 10000 (1–14), potem -10000 → 10000×0.12×14/365 = 46.03
    const jan = out.find((o) => o.date.startsWith('2023-01'));
    expect(jan?.amount).toBe(46.03);
    // Luty: saldo ujemne przez cały miesiąc → brak wiersza
    expect(out.some((o) => o.date.startsWith('2023-02'))).toBe(false);
  });

  it('ignoruje własne wcześniejsze auto-odsetki na wejściu (recompute od zera)', () => {
    const base = [deposit('2023-01-01', 10000)];
    const withStaleAuto: CashOperation[] = [
      ...base,
      {
        date: '2023-06-30',
        operationType: 'other',
        subkind: 'interest',
        description: 'stare auto',
        amount: 99999,
        currency: 'PLN',
        source: 'auto-interest',
        importBatch: AUTO_INTEREST_BATCH,
      },
    ];
    const a = computeInterestOperations([], base, [rate('PLN', 12)], '2024-01-01');
    const b = computeInterestOperations([], withStaleAuto, [rate('PLN', 12)], '2024-01-01');
    expect(b).toEqual(a);
  });

  it('jest deterministyczny (idempotencja skanera)', () => {
    const ops = [deposit('2023-01-01', 10000), deposit('2023-06-01', 5000)];
    const a = computeInterestOperations([], ops, [rate('PLN', 8)], '2024-01-01');
    const b = computeInterestOperations([], ops, [rate('PLN', 8)], '2024-01-01');
    expect(b).toEqual(a);
  });

  it('nie księguje bieżącego (niezamkniętego) miesiąca', () => {
    const ops = [deposit('2023-01-01', 10000)];
    // today w środku stycznia → 0 zamkniętych miesięcy
    expect(computeInterestOperations([], ops, [rate('PLN', 12)], '2023-01-20')).toEqual([]);
  });
});

describe('buildCashDeltas', () => {
  it('operacje wchodzą z amount, transakcje ze znakiem K=-/S=+', () => {
    const ops = [deposit('2023-01-05', 100, 'PLN')];
    const txs = [
      tx({ date: '2023-01-06', side: 'K', total: 500, currency: 'USD' }),
      tx({ date: '2023-01-07', side: 'S', total: 300, currency: 'USD' }),
    ];
    const deltas = buildCashDeltas(txs, ops);
    const pln = deltas.filter((d) => d.currency === 'PLN').reduce((s, d) => s + d.amount, 0);
    const usd = deltas.filter((d) => d.currency === 'USD').reduce((s, d) => s + d.amount, 0);
    expect(pln).toBe(100);
    expect(usd).toBe(-500 + 300); // -200
  });

  it('transakcja z paymentCurrency+fxRate księguje w walucie rozliczenia', () => {
    const txs = [tx({ side: 'K', total: 400, currency: 'USD', paymentCurrency: 'PLN', fxRate: 4 })];
    const deltas = buildCashDeltas(txs, []);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].currency).toBe('PLN');
    expect(deltas[0].amount).toBe(-1600); // 400 × 4, kupno = ujemne
  });

  it('sortuje chronologicznie', () => {
    const ops = [deposit('2023-03-01', 1), deposit('2023-01-01', 1), deposit('2023-02-01', 1)];
    const deltas = buildCashDeltas([], ops);
    expect(deltas.map((d) => d.date)).toEqual(['2023-01-01', '2023-02-01', '2023-03-01']);
  });
});
