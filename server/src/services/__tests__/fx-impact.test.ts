import { describe, it, expect } from 'vitest';
import { computeFxImpact } from '../portfolio-engine.js';
import type { CashOperation, ImpliedFxFlow } from 'shared';

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

  it('implied flows (Bossa rozliczana w PLN) doliczają się do średniej', () => {
    // Brak operacji FX; nabycie wynika z transakcji: 1000 CAD za 3000 PLN → avg 3.00.
    const implied: ImpliedFxFlow[] = [
      { date: '2024-01-10', currency: 'CAD', amountNative: 1000, kind: 'buy', pln: 3000 },
    ];
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

describe('computeFxImpact — księga walutowa (średnia krocząca + realized)', () => {
  it('round-trip nie zatruwa średniej: avg = kurs ostatniego nabycia, strata w realized', () => {
    // Kupno 1000 USD @4.50 → wymiana wszystkiego z powrotem @4.00 (realna strata
    // −500 PLN) → ponowne kupno 1000 USD @3.60. Stary algorytm: avg = 4.05 i
    // fikcyjny impact −4000 przy kursie 3.65. Nowy: avg = 3.60 (tylko obecne
    // saldo), impact +50, a −500 ląduje w realized.
    const ops = [
      fxOp({ amount: 1000, currency: 'USD', fxRate: 4.5, date: '2022-01-10T10:00:00' }),
      fxOp({ amount: -1000, currency: 'USD', fxRate: 4.0, date: '2023-06-10T10:00:00' }),
      fxOp({ amount: 1000, currency: 'USD', fxRate: 3.6, date: '2025-02-10T10:00:00' }),
    ];
    const result = computeFxImpact(ops, new Map([['USD', 1000]]), new Map([['USD', 3.65]]), 100000);

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeCloseTo(3.6, 10);
    expect(usd.impactPln).toBeCloseTo(1000 * (3.65 - 3.6), 6);
    expect(usd.realizedPln).toBeCloseTo(1000 * (4.0 - 4.5), 6);
    expect(usd.totalAcquiredNative).toBeCloseTo(2000, 6); // oba nabycia, diagnostycznie
    expect(result!.fxRealizedPln).toBeCloseTo(-500, 6);
  });

  it('częściowy rozchód: średnia bez zmian, realized = ilość × (kurs − avg)', () => {
    const ops = [
      fxOp({ amount: 1000, currency: 'USD', fxRate: 4.0, date: '2024-01-10T10:00:00' }),
      fxOp({ amount: -400, currency: 'USD', fxRate: 4.2, date: '2024-02-10T10:00:00' }),
    ];
    const result = computeFxImpact(ops, new Map([['USD', 600]]), new Map([['USD', 4.1]]), 100000);

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeCloseTo(4.0, 10);
    expect(usd.impactPln).toBeCloseTo(600 * 0.1, 6);
    expect(usd.realizedPln).toBeCloseTo(400 * 0.2, 6);
  });

  it('wypłata bez kursu: zdejmuje saldo po średniej, realized bez zmian', () => {
    const ops = [
      fxOp({ amount: 1000, currency: 'USD', fxRate: 4.0, date: '2024-01-10T10:00:00' }),
      {
        date: '2024-03-10T10:00:00',
        operationType: 'withdrawal',
        description: 'Wypłata USD',
        amount: -300,
        currency: 'USD',
        source: 'bossa',
      } as CashOperation,
    ];
    const result = computeFxImpact(ops, new Map([['USD', 700]]), new Map([['USD', 4.2]]), 100000);

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeCloseTo(4.0, 10);
    expect(usd.impactPln).toBeCloseTo(700 * 0.2, 6);
    expect(usd.realizedPln).toBe(0);
  });

  it('dywidenda w walucie wchodzi do średniej po kursie historycznym z dnia', () => {
    const ops = [
      fxOp({ amount: 1000, currency: 'USD', fxRate: 4.0, date: '2024-01-10T10:00:00' }),
      {
        date: '2024-03-05T10:00:00',
        operationType: 'dividend',
        description: 'Dywidenda AAPL',
        amount: 200,
        currency: 'USD',
        source: 'bossa',
      } as CashOperation,
    ];
    const historical = new Map([['2024-03-05', new Map([['USD', 4.5]])]]);
    const result = computeFxImpact(
      ops,
      new Map([['USD', 1200]]),
      new Map([['USD', 4.2]]),
      100000,
      historical,
    );

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    // avg = (1000×4.0 + 200×4.5) / 1200 = 4900/1200
    expect(usd.avgPlnPerCurrency).toBeCloseTo(4900 / 1200, 10);
    expect(usd.totalAcquiredNative).toBeCloseTo(1200, 6);
  });

  it('wpływ bez żadnego kursu księgowany neutralnie po bieżącej średniej', () => {
    const ops = [
      fxOp({ amount: 1000, currency: 'USD', fxRate: 4.0, date: '2024-01-10T10:00:00' }),
      {
        date: '2024-03-05T10:00:00',
        operationType: 'dividend',
        description: 'Dywidenda bez kursu',
        amount: 200,
        currency: 'USD',
        source: 'bossa',
      } as CashOperation,
    ];
    const result = computeFxImpact(ops, new Map([['USD', 1200]]), new Map([['USD', 4.2]]), 100000);

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeCloseTo(4.0, 10); // średnia nietknięta
    expect(usd.totalAcquiredNative).toBeCloseTo(1200, 6); // saldo urosło
  });

  it('rozchód ponad saldo jest przycinany; kolejne nabycie zaczyna świeżą średnią', () => {
    const ops = [
      fxOp({ amount: 300, currency: 'USD', fxRate: 4.0, date: '2024-01-10T10:00:00' }),
      fxOp({ amount: -1000, currency: 'USD', fxRate: 4.2, date: '2024-02-10T10:00:00' }),
      fxOp({ amount: 500, currency: 'USD', fxRate: 3.6, date: '2024-03-10T10:00:00' }),
    ];
    const result = computeFxImpact(ops, new Map([['USD', 500]]), new Map([['USD', 3.7]]), 100000);

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeCloseTo(3.6, 10);
    expect(usd.realizedPln).toBeCloseTo(300 * 0.2, 6); // tylko pokryta część
    expect(usd.impactPln).toBeCloseTo(500 * 0.1, 6);
  });

  it('w obrębie dnia wpływ księgowany przed rozchodem', () => {
    // Rozchód wpisany PRZED nabyciem z tą samą datą nie może ściąć pustego salda.
    const ops = [
      fxOp({ amount: -200, currency: 'USD', fxRate: 4.1, date: '2024-01-10T09:00:00' }),
      fxOp({ amount: 500, currency: 'USD', fxRate: 4.0, date: '2024-01-10T15:00:00' }),
    ];
    const result = computeFxImpact(ops, new Map([['USD', 300]]), new Map([['USD', 4.2]]), 100000);

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeCloseTo(4.0, 10);
    expect(usd.realizedPln).toBeCloseTo(200 * 0.1, 6);
  });

  it('implied sell (sprzedaż rozliczona do PLN) zdejmuje saldo i realizuje wynik', () => {
    const implied: ImpliedFxFlow[] = [
      { date: '2024-01-10', currency: 'CAD', amountNative: 1000, kind: 'buy', pln: 3000 },
      { date: '2024-06-10', currency: 'CAD', amountNative: 400, kind: 'sell', pln: 1300 },
    ];
    const result = computeFxImpact(
      [],
      new Map([['CAD', 600]]),
      new Map([['CAD', 3.1]]),
      100000,
      new Map(),
      undefined,
      implied,
    );

    const cad = result!.breakdown.find((b) => b.currency === 'CAD')!;
    expect(cad.avgPlnPerCurrency).toBeCloseTo(3.0, 10);
    expect(cad.realizedPln).toBeCloseTo(1300 - 400 * 3.0, 6); // = 100
    expect(cad.impactPln).toBeCloseTo(600 * 0.1, 6);
  });

  it('implied flow bez pln wyceniany po historycznym kursie z dnia (nogi X↔Y)', () => {
    const implied: ImpliedFxFlow[] = [
      { date: '2024-03-05', currency: 'EUR', amountNative: 300, kind: 'buy' },
    ];
    const historical = new Map([['2024-03-05', new Map([['EUR', 4.3]])]]);
    const result = computeFxImpact(
      [],
      new Map([['EUR', 300]]),
      new Map([['EUR', 4.5]]),
      100000,
      historical,
      undefined,
      implied,
    );

    const eur = result!.breakdown.find((b) => b.currency === 'EUR')!;
    expect(eur.avgPlnPerCurrency).toBeCloseTo(4.3, 10);
    expect(eur.impactPln).toBeCloseTo(300 * 0.2, 6);
  });

  it('pełny rozchód → avg null, impact 0, ale realized zostaje w breakdown', () => {
    // Cała waluta wymieniona z powrotem, a ekspozycja > 0 z innego źródła
    // (np. akcje w USD kupione natywnie z danymi lukami) — kurs wejścia nieznany,
    // ale zrealizowany wynik z wymian jest faktem i zostaje.
    const ops = [
      fxOp({ amount: 1000, currency: 'USD', fxRate: 4.0, date: '2024-01-10T10:00:00' }),
      fxOp({ amount: -1000, currency: 'USD', fxRate: 4.3, date: '2024-05-10T10:00:00' }),
    ];
    const result = computeFxImpact(ops, new Map([['USD', 250]]), new Map([['USD', 4.2]]), 100000);

    const usd = result!.breakdown.find((b) => b.currency === 'USD')!;
    expect(usd.avgPlnPerCurrency).toBeNull();
    expect(usd.impactPln).toBe(0);
    expect(usd.realizedPln).toBeCloseTo(300, 6);
    expect(result!.fxRealizedPln).toBeCloseTo(300, 6);
  });
});
