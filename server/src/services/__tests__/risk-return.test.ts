import { describe, it, expect } from 'vitest';
import { computeRiskReturnFromPrices, MIN_RISK_RETURN_POINTS } from '../risk-return.js';

function series(closes: number[]) {
  return closes.map((close, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    close,
  }));
}

describe('computeRiskReturnFromPrices', () => {
  it('za mało punktów → null', () => {
    expect(
      computeRiskReturnFromPrices(series(Array(MIN_RISK_RETURN_POINTS - 1).fill(100))),
    ).toBeNull();
    expect(computeRiskReturnFromPrices([])).toBeNull();
  });

  it('stała cena → zwrot 0, zmienność 0', () => {
    const m = computeRiskReturnFromPrices(series(Array(100).fill(50)));
    expect(m).not.toBeNull();
    expect(m!.returnPct).toBeCloseTo(0, 10);
    expect(m!.volatilityPct).toBeCloseTo(0, 10);
    expect(m!.dataPoints).toBe(100);
  });

  it('zwrot za okres = last/first − 1', () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 * Math.pow(1.001, i));
    const m = computeRiskReturnFromPrices(series(closes))!;
    expect(m.returnPct).toBeCloseTo((closes[99] / closes[0] - 1) * 100, 8);
  });

  it('zmienność annualizowana √252 zgadza się z ręcznym odchyleniem', () => {
    // Naprzemienne ±1% dziennie → std dziennych zwrotów ≈ 1%
    const closes: number[] = [100];
    for (let i = 0; i < 99; i++)
      closes.push(closes[closes.length - 1] * (i % 2 === 0 ? 1.01 : 0.99));
    const m = computeRiskReturnFromPrices(series(closes))!;
    const expectedDailyStd = 0.01; // amplituda ±1% wokół średniej ~0
    expect(m.volatilityPct).toBeCloseTo(expectedDailyStd * Math.sqrt(252) * 100, 0);
  });

  it('odfiltrowuje zera i NaN (artefakty cache) zamiast produkować Infinity', () => {
    const closes = [...Array(80).fill(100), 0, NaN, ...Array(20).fill(110)];
    const m = computeRiskReturnFromPrices(series(closes))!;
    expect(Number.isFinite(m.returnPct)).toBe(true);
    expect(Number.isFinite(m.volatilityPct)).toBe(true);
    expect(m.dataPoints).toBe(100); // 80 + 20 użytecznych
    expect(m.returnPct).toBeCloseTo(10, 8);
  });
});
