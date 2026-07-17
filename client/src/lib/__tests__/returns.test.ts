import { describe, it, expect } from 'vitest';
import { chainLinkPct, computeBetaAlpha, computeDrawdownSeries } from '../returns';

describe('chainLinkPct', () => {
  it('portfel +100% → +110% to +5% w okresie (nie +10 p.p.)', () => {
    expect(chainLinkPct(110, 100)).toBeCloseTo(5, 10);
  });

  it('zwraca 0 gdy zwrot się nie zmienił', () => {
    expect(chainLinkPct(42, 42)).toBeCloseTo(0, 10);
  });

  it('przy bazie 0% wynik równa się zwrotowi końcowemu', () => {
    expect(chainLinkPct(7.5, 0)).toBeCloseTo(7.5, 10);
    expect(chainLinkPct(-3, 0)).toBeCloseTo(-3, 10);
  });

  it('poprawnie liczy spadek: +50% → +20% to −20% w okresie', () => {
    expect(chainLinkPct(20, 50)).toBeCloseTo(-20, 10);
  });

  it('działa dla ujemnej bazy: −20% → −12% to +10% w okresie', () => {
    expect(chainLinkPct(-12, -20)).toBeCloseTo(10, 10);
  });

  it('jest składalny: link(C,A) == link(link przez B)', () => {
    // A=10%, B=32%, C=45.2% — zwrot A→C musi być iloczynem zwrotów A→B i B→C
    const ab = chainLinkPct(32, 10);
    const bc = chainLinkPct(45.2, 32);
    const ac = chainLinkPct(45.2, 10);
    const composed = ((1 + ab / 100) * (1 + bc / 100) - 1) * 100;
    expect(ac).toBeCloseTo(composed, 10);
  });

  it('degeneracja bazy ≤ −100% nie wybucha (fallback do różnicy)', () => {
    expect(chainLinkPct(-50, -100)).toBe(50);
    expect(Number.isFinite(chainLinkPct(-50, -120))).toBe(true);
  });
});

describe('computeDrawdownSeries', () => {
  it('monotoniczny wzrost → same zera (każdy punkt jest nowym szczytem)', () => {
    expect(computeDrawdownSeries([0, 2, 5, 11])).toEqual([0, 0, 0, 0]);
  });

  it('spadek → odbicie → nowy szczyt: dolina liczona od szczytu, po nowym szczycie zero', () => {
    // Indeksy: 1.0, 1.10, 0.99, 1.045, 1.21 — szczyt 1.10, dołek 0.99 → −10%
    const dd = computeDrawdownSeries([0, 10, -1, 4.5, 21]);
    expect(dd[0]).toBeCloseTo(0, 10);
    expect(dd[1]).toBeCloseTo(0, 10);
    expect(dd[2]).toBeCloseTo((0.99 / 1.1 - 1) * 100, 10); // −10%
    expect(dd[3]).toBeCloseTo((1.045 / 1.1 - 1) * 100, 10); // wciąż pod wodą, −5%
    expect(dd[4]).toBeCloseTo(0, 10); // nowy szczyt
  });

  it('minimum serii zgadza się z Max Drawdown liczonym jak w PerformanceStats', () => {
    const twrPcts = [0, 8, 3, -6, -2, 12, 5, 9];
    // Referencyjna pętla — kopia matematyki Max Drawdown z PerformanceStats
    let peak = 1 + twrPcts[0] / 100;
    let maxDrawdown = 0;
    for (const pct of twrPcts) {
      const index = 1 + pct / 100;
      if (index > peak) peak = index;
      const dd = peak > 0 ? (peak - index) / peak : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    const series = computeDrawdownSeries(twrPcts);
    expect(Math.min(...series)).toBeCloseTo(-maxDrawdown * 100, 10);
  });

  it('nigdy nie zwraca wartości dodatnich', () => {
    const series = computeDrawdownSeries([0, -3, 7, 2, 15, -20, -20.5, 40]);
    for (const v of series) expect(v).toBeLessThanOrEqual(0);
  });

  it('degeneracja (TWR ≤ −100%) → 0 zamiast dzielenia przez zero', () => {
    const series = computeDrawdownSeries([-100, -110, -50]);
    for (const v of series) expect(Number.isFinite(v)).toBe(true);
  });

  it('pusta seria → pusta seria', () => {
    expect(computeDrawdownSeries([])).toEqual([]);
  });
});

describe('computeBetaAlpha', () => {
  // Portfel idealnie = 2× benchmark → beta 2, alfa wynika tylko z rf.
  it('portfel = k × benchmark → beta = k', () => {
    const pairs: Array<[number, number]> = Array.from({ length: 60 }, (_, i) => {
      const b = ((i % 7) - 3) / 100; // deterministyczna zmienność −3%..+3%
      return [2 * b, b];
    });
    const r = computeBetaAlpha(pairs, 0)!;
    expect(r.beta).toBeCloseTo(2, 8);
    expect(r.alphaAnnualPct).toBeCloseTo(0, 6);
  });

  it('stała dzienna nadwyżka nad benchmarkiem → alfa = nadwyżka × 252', () => {
    const excessDaily = 0.0002; // 2 pb dziennie
    const pairs: Array<[number, number]> = Array.from({ length: 60 }, (_, i) => {
      const b = ((i % 5) - 2) / 100;
      return [b + excessDaily, b];
    });
    const r = computeBetaAlpha(pairs, 0)!;
    expect(r.beta).toBeCloseTo(1, 8);
    expect(r.alphaAnnualPct).toBeCloseTo(excessDaily * 252 * 100, 4);
  });

  it('rf obniża alfę portfela o dodatnim zwrocie przy beta 1 — neutralnie', () => {
    // Przy beta=1 rf znosi się w formule Jensena: alfa nie zależy od rf.
    const pairs: Array<[number, number]> = Array.from({ length: 60 }, (_, i) => {
      const b = ((i % 5) - 2) / 100;
      return [b + 0.0001, b];
    });
    const r0 = computeBetaAlpha(pairs, 0)!;
    const r5 = computeBetaAlpha(pairs, 5)!;
    expect(r5.alphaAnnualPct).toBeCloseTo(r0.alphaAnnualPct, 6);
  });

  it('za mało par albo płaski benchmark → null', () => {
    expect(computeBetaAlpha([[0.01, 0.01]], 5)).toBeNull();
    const flat: Array<[number, number]> = Array.from({ length: 60 }, () => [0.01, 0]);
    expect(computeBetaAlpha(flat, 5)).toBeNull();
  });
});
