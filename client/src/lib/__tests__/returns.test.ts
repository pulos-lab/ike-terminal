import { describe, it, expect } from 'vitest';
import { chainLinkPct } from '../returns';

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
