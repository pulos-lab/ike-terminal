import { describe, it, expect } from 'vitest';
import { computeFxImpact } from '../portfolio-engine.js';
import type { CashOperation } from 'shared';

function fxOp(
  overrides: Partial<CashOperation> & { amount: number; currency: string },
): CashOperation {
  return {
    date: '2024-01-10T10:00:00',
    operationType: 'fx_exchange',
    description: 'Wymiana',
    source: 'bossa',
    fxPair: 'PLN/USD',
    fxRate: 4.0,
    ...overrides,
  };
}

describe('computeFxImpact', () => {
  it('pojedyncza waluta: wpływ = ekspozycja × (kurs dziś − średni kurs nabycia)', () => {
    // Kupiono 1000 USD po 4.00 PLN; dziś USDPLN = 3.80.
    // Wpływ = 1000 × (3.80 − 4.00) = −200 PLN. Portfel 38 000 PLN → −0.526%.
    const ops = [fxOp({ amount: 1000, currency: 'USD', fxRate: 4.0 })];
    const result = computeFxImpact(ops, new Map([['USD', 1000]]), new Map([['USD', 3.8]]), 38000);

    expect(result).not.toBeNull();
    expect(result!.fxImpactPln).toBeCloseTo(-200, 6);
    expect(result!.fxImpactPct).toBeCloseTo((-200 / 38000) * 100, 6);
    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeCloseTo(4.0, 10);
    expect(usd.impactPct).toBeCloseTo((3.8 / 4.0 - 1) * 100, 6);
  });

  it('średnia ważona z wielu nabyć (wymiana + wpłata z kursem)', () => {
    // 1000 USD po 4.00 + 500 USD wpłata po 4.30 → avg = (4000+2150)/1500 = 4.10.
    // Dziś 4.20: wpływ = 1500 × (4.20 − 4.10) = +150 PLN.
    const ops = [
      fxOp({ amount: 1000, currency: 'USD', fxRate: 4.0 }),
      fxOp({
        amount: 500,
        currency: 'USD',
        operationType: 'deposit',
        fxRate: 4.3,
        fxPair: 'USD/PLN',
      }),
    ];
    const result = computeFxImpact(ops, new Map([['USD', 1500]]), new Map([['USD', 4.2]]), 100000);

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeCloseTo(4.1, 10);
    expect(usd.impactPln).toBeCloseTo(150, 6);
  });

  it('XTB: fxRate odwrotny (USD per PLN) jest poprawnie odwracany', () => {
    // XTB zapisuje kurs jako USD per PLN = 0.25 → 4.00 PLN per USD.
    const ops = [
      fxOp({ amount: 1000, currency: 'USD', source: 'xtb', fxRate: 0.25, fxPair: 'PLN/USD' }),
    ];
    const result = computeFxImpact(ops, new Map([['USD', 1000]]), new Map([['USD', 4.4]]), 100000);

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeCloseTo(4.0, 10);
    expect(usd.impactPln).toBeCloseTo(1000 * 0.4, 6);
  });

  it('operacja w GBX trafia do kubełka GBP (normalizacja pensów)', () => {
    // Ekspozycja znormalizowana do GBP; ręczna wymiana wpisana jako GBX
    // musi zasilić średni kurs nabycia GBP zamiast zostać zignorowana.
    const ops = [fxOp({ amount: 200, currency: 'GBX', fxRate: 5.0, fxPair: 'PLN/GBP' })];
    const result = computeFxImpact(ops, new Map([['GBP', 200]]), new Map([['GBP', 5.5]]), 100000);

    const gbp = result!.breakdown.find((b) => b.currency === 'GBP')!;
    expect(gbp.avgPlnPerCurrency).toBeCloseTo(5.0, 10);
    expect(gbp.impactPln).toBeCloseTo(200 * 0.5, 6);
  });

  it('cross-rate (fxPair bez PLN) używa historycznego kursu od callera', () => {
    // USD→EUR: op.fxRate to cross-rate, nie PLN — engine bierze EURPLN
    // z historicalCrossRates na datę operacji.
    const ops = [
      fxOp({
        amount: 300,
        currency: 'EUR',
        source: 'degiro',
        fxRate: 0.92,
        fxPair: 'USD/EUR',
        date: '2024-03-05T12:00:00',
      }),
    ];
    const historical = new Map([['2024-03-05', new Map([['EUR', 4.3]])]]);
    const result = computeFxImpact(
      ops,
      new Map([['EUR', 300]]),
      new Map([['EUR', 4.5]]),
      100000,
      historical,
    );

    const eur = result!.breakdown.find((b) => b.currency === 'EUR')!;
    expect(eur.avgPlnPerCurrency).toBeCloseTo(4.3, 10);
    expect(eur.impactPln).toBeCloseTo(300 * 0.2, 6);
  });

  it('implied acquisitions (Bossa rozliczana w PLN) dolicza się do średniej', () => {
    // Brak operacji FX; nabycie wynika z transakcji: 1000 CAD za 3000 PLN → avg 3.00.
    const implied = new Map([['CAD', { acquiredNative: 1000, plnPaid: 3000 }]]);
    const result = computeFxImpact(
      [],
      new Map([['CAD', 1000]]),
      new Map([['CAD', 2.9]]),
      100000,
      new Map(),
      undefined,
      implied,
    );

    const cad = result!.breakdown.find((b) => b.currency === 'CAD')!;
    expect(cad.avgPlnPerCurrency).toBeCloseTo(3.0, 10);
    expect(cad.impactPln).toBeCloseTo(1000 * (2.9 - 3.0), 6);
  });

  it('brak danych o nabyciu → ekspozycja widoczna, impact 0, avg null', () => {
    const result = computeFxImpact([], new Map([['USD', 500]]), new Map([['USD', 4.0]]), 100000);

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeNull();
    expect(usd.impactPln).toBe(0);
    expect(usd.exposurePln).toBeCloseTo(2000, 6);
  });

  it('waluta bez dzisiejszego kursu jest pomijana (lepiej ukryć niż skłamać)', () => {
    const ops = [fxOp({ amount: 100, currency: 'NOK', fxPair: 'PLN/NOK', fxRate: 0.38 })];
    const result = computeFxImpact(ops, new Map([['NOK', 100]]), new Map(), 100000);
    expect(result).toBeNull();
  });

  it('zerowa/ujemna ekspozycja nie generuje wpisu (round-trip FX)', () => {
    const ops = [fxOp({ amount: 1000, currency: 'USD', fxRate: 4.0 })];
    const result = computeFxImpact(ops, new Map([['USD', 0]]), new Map([['USD', 4.2]]), 100000);
    expect(result).toBeNull();
  });

  it('exposurePlnByCurrency (pre-fetched przez /metrics) ma pierwszeństwo nad iloczynem', () => {
    // Spójność ekranu: Σ exposurePln musi pasować do wartości portfela
    // liczonej tą samą mapą kursów — caller przekazuje gotową wartość.
    const ops = [fxOp({ amount: 1000, currency: 'USD', fxRate: 4.0 })];
    const result = computeFxImpact(
      ops,
      new Map([['USD', 1000]]),
      new Map([['USD', 4.2]]),
      100000,
      new Map(),
      new Map([['USD', 4187.5]]), // wartość z pozycji liczonych live, nie 1000×4.2
    );

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.exposurePln).toBe(4187.5);
  });
});
