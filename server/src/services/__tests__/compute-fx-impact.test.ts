import { describe, it, expect } from 'vitest';
import { computeFxImpact } from '../portfolio-engine.js';
import type { CashOperation, ImpliedFxFlow } from 'shared';

function op(
  overrides: Partial<CashOperation> & {
    date: string;
    operationType: CashOperation['operationType'];
    amount: number;
    currency: string;
  },
): CashOperation {
  return {
    description: overrides.description ?? overrides.operationType,
    source: overrides.source ?? 'bossa',
    ...overrides,
  };
}

describe('computeFxImpact', () => {
  it('USD z fx_exchange — baseline (waluta z acquisition events liczy impact)', () => {
    const operations: CashOperation[] = [
      op({
        date: '2024-01-15',
        operationType: 'fx_exchange',
        amount: -4000,
        currency: 'PLN',
        fxPair: 'PLN/USD',
        fxRate: 4.0,
      }),
      op({
        date: '2024-01-15',
        operationType: 'fx_exchange',
        amount: 1000,
        currency: 'USD',
        fxPair: 'PLN/USD',
        fxRate: 4.0,
      }),
    ];
    const foreignExposures = new Map([['USD', 1000]]);
    const todayFx = new Map([['USD', 4.2]]);
    const totalPortfolioValuePln = 4200;

    const result = computeFxImpact(operations, foreignExposures, todayFx, totalPortfolioValuePln);
    expect(result).not.toBeNull();
    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeCloseTo(4.0, 4);
    expect(usd.impactPln).toBeCloseTo(200, 2); // 1000 × (4.2 − 4.0)
    expect(usd.totalAcquiredNative).toBeCloseTo(1000, 4);
    expect(result!.foreignExposurePln).toBeCloseTo(4200, 2);
  });

  it('CAD bez żadnej operacji — Bug #2 fix: jest w breakdown z avgPlnPerCurrency=null', () => {
    const operations: CashOperation[] = [];
    const foreignExposures = new Map([['CAD', 100]]);
    const todayFx = new Map([['CAD', 3.0]]);
    const totalPortfolioValuePln = 1000; // CAD ekspozycja w PLN = 300, reszta = 700 PLN

    const result = computeFxImpact(operations, foreignExposures, todayFx, totalPortfolioValuePln);
    expect(result).not.toBeNull();
    const cad = result!.breakdown.find((b) => b.currency === 'CAD');
    expect(cad).toBeDefined();
    expect(cad!.avgPlnPerCurrency).toBeNull();
    expect(cad!.impactPln).toBe(0);
    expect(cad!.impactPct).toBe(0);
    expect(cad!.exposurePln).toBeCloseTo(300, 2);
    expect(cad!.exposurePctOfPortfolio).toBeCloseTo(30, 2);
    expect(result!.foreignExposurePln).toBeCloseTo(300, 2);
    expect(result!.foreignExposurePctOfPortfolio).toBeCloseTo(30, 2);
  });

  it('CAD z implied flows — Poziom 2: dostaje realny avg kurs i impact się liczy', () => {
    const operations: CashOperation[] = [];
    const foreignExposures = new Map([['CAD', 9986]]);
    const todayFx = new Map([['CAD', 2.65]]);
    const totalPortfolioValuePln = 100000;

    // Bossa Zagranica: kupno 2 sztuk CSU.TO za 14212 PLN, native price ≈ $4993 CAD
    const implied: ImpliedFxFlow[] = [
      { date: '2024-01-10', currency: 'CAD', amountNative: 9986, kind: 'buy', pln: 14212.02 },
    ];

    const result = computeFxImpact(
      operations,
      foreignExposures,
      todayFx,
      totalPortfolioValuePln,
      undefined,
      undefined,
      implied,
    );
    expect(result).not.toBeNull();
    const cad = result!.breakdown.find((b) => b.currency === 'CAD')!;
    const expectedAvg = 14212.02 / 9986; // ≈ 1.4232
    expect(cad.avgPlnPerCurrency).not.toBeNull();
    expect(cad.avgPlnPerCurrency!).toBeCloseTo(expectedAvg, 4);
    expect(cad.impactPln).toBeCloseTo(9986 * (2.65 - expectedAvg), 1);
    expect(cad.totalAcquiredNative).toBeCloseTo(9986, 2);
  });

  it('USD z fx_exchange + CAD z implied — foreignExposurePln obejmuje obie', () => {
    const operations: CashOperation[] = [
      op({
        date: '2024-01-15',
        operationType: 'fx_exchange',
        amount: 1000,
        currency: 'USD',
        fxPair: 'PLN/USD',
        fxRate: 4.0,
      }),
    ];
    const foreignExposures = new Map([
      ['USD', 1000],
      ['CAD', 100],
    ]);
    const todayFx = new Map([
      ['USD', 4.2],
      ['CAD', 3.0],
    ]);
    const totalPortfolioValuePln = 5000;
    const implied: ImpliedFxFlow[] = [
      { date: '2024-01-10', currency: 'CAD', amountNative: 100, kind: 'buy', pln: 280 },
    ];

    const result = computeFxImpact(
      operations,
      foreignExposures,
      todayFx,
      totalPortfolioValuePln,
      undefined,
      undefined,
      implied,
    );
    expect(result).not.toBeNull();
    expect(result!.breakdown).toHaveLength(2);
    const usdEntry = result!.breakdown.find((b) => b.currency === 'USD')!;
    const cadEntry = result!.breakdown.find((b) => b.currency === 'CAD')!;
    // USD: 1000 × 4.2 = 4200 PLN, CAD: 100 × 3.0 = 300 PLN, suma 4500 PLN
    expect(result!.foreignExposurePln).toBeCloseTo(4500, 2);
    expect(result!.foreignExposurePctOfPortfolio).toBeCloseTo(90, 2);
    expect(usdEntry.avgPlnPerCurrency).toBeCloseTo(4.0, 4);
    expect(cadEntry.avgPlnPerCurrency).toBeCloseTo(2.8, 4); // 280 / 100
  });

  it('akumulacja: implied + fx_exchange dla tej samej waluty', () => {
    // USD ma fx_exchange (1000 USD @ 4.0 = 4000 PLN) + implied (500 USD @ 4.5 = 2250 PLN)
    // Średnia ważona: (4000 + 2250) / (1000 + 500) = 6250 / 1500 = 4.1667
    const operations: CashOperation[] = [
      op({
        date: '2024-01-15',
        operationType: 'fx_exchange',
        amount: 1000,
        currency: 'USD',
        fxPair: 'PLN/USD',
        fxRate: 4.0,
      }),
    ];
    const foreignExposures = new Map([['USD', 1500]]);
    const todayFx = new Map([['USD', 4.3]]);
    const implied: ImpliedFxFlow[] = [
      { date: '2024-02-10', currency: 'USD', amountNative: 500, kind: 'buy', pln: 2250 },
    ];

    const result = computeFxImpact(
      operations,
      foreignExposures,
      todayFx,
      6500,
      undefined,
      undefined,
      implied,
    );
    expect(result).not.toBeNull();
    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeCloseTo(4.1667, 3);
    expect(usd.totalAcquiredNative).toBeCloseTo(1500, 2);
  });

  it('zwraca null gdy brak walut obcych w portfelu', () => {
    const result = computeFxImpact([], new Map(), new Map(), 10000);
    expect(result).toBeNull();
  });

  it('exposurePln respektuje pre-computed exposurePlnByCurrency dla matematycznej spójności', () => {
    const foreignExposures = new Map([['USD', 1000]]);
    const todayFx = new Map([['USD', 4.0]]);
    // Backend wylicza exposurePlnByCurrency z LIVE positions × wspólny FX —
    // może minimalnie różnić się od `native × todayFx` (round-tripping float).
    const exposurePlnByCurrency = new Map([['USD', 4001.55]]); // np. drobne odchylenie

    const result = computeFxImpact(
      [],
      foreignExposures,
      todayFx,
      4001.55,
      undefined,
      exposurePlnByCurrency,
    );
    expect(result).not.toBeNull();
    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.exposurePln).toBe(4001.55);
  });
});
