import { describe, it, expect } from 'vitest';
import { bsPrice, bsGreeks, impliedVol, normCdf } from 'shared';

describe('black-scholes — wycena i greeki', () => {
  it('normCdf zgodne ze znanymi wartościami', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 4);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('cena ATM call zgodna z referencją (S=K=100, T=1, r=5%, σ=20%)', () => {
    // Wartość referencyjna Black-Scholes: ≈ 10.4506.
    expect(bsPrice('C', 100, 100, 1, 0.05, 0.2)).toBeCloseTo(10.4506, 3);
    // Put z tej samej parametryzacji: ≈ 5.5735.
    expect(bsPrice('P', 100, 100, 1, 0.05, 0.2)).toBeCloseTo(5.5735, 3);
  });

  it('parytet put-call: C − P = S − K·e^(−rT)', () => {
    const S = 120,
      K = 100,
      T = 0.75,
      r = 0.04,
      sig = 0.35;
    const c = bsPrice('C', S, K, T, r, sig);
    const p = bsPrice('P', S, K, T, r, sig);
    expect(c - p).toBeCloseTo(S - K * Math.exp(-r * T), 6);
  });

  it('delta: call w (0,1), put w (−1,0); parytet delt ≈ 1', () => {
    const g = bsGreeks('C', 100, 100, 1, 0.05, 0.2);
    const gp = bsGreeks('P', 100, 100, 1, 0.05, 0.2);
    expect(g.delta).toBeGreaterThan(0);
    expect(g.delta).toBeLessThan(1);
    expect(gp.delta).toBeLessThan(0);
    expect(g.delta - gp.delta).toBeCloseTo(1, 6); // ΔC − ΔP = 1
    expect(g.gamma).toBeGreaterThan(0);
    expect(g.vega).toBeGreaterThan(0); // long → dodatnia vega
    expect(g.theta).toBeLessThan(0); // long → ujemna theta (upływ czasu)
  });

  it('impliedVol odzyskuje σ z ceny (round-trip)', () => {
    const S = 88,
      K = 95,
      T = 0.6,
      r = 0.045,
      sigma = 0.42;
    const price = bsPrice('P', S, K, T, r, sigma);
    const iv = impliedVol('P', price, S, K, T, r);
    expect(iv).not.toBeNull();
    expect(iv!).toBeCloseTo(sigma, 4);
  });

  it('impliedVol = null gdy cena poniżej wartości wewnętrznej', () => {
    // Put głęboko ITM: intrinsic = 100−60 = 40; cena 30 < 40 → brak IV.
    expect(impliedVol('P', 30, 60, 100, 0.5, 0.04)).toBeNull();
  });

  it('greeki degenerują się poprawnie po wygaśnięciu (T=0)', () => {
    const g = bsGreeks('P', 90, 100, 0, 0.04, 0.3); // ITM put
    expect(g.delta).toBe(-1);
    expect(g.gamma).toBe(0);
    expect(g.theta).toBe(0);
    expect(bsPrice('P', 90, 100, 0, 0.04, 0.3)).toBe(10); // intrinsic
  });
});
