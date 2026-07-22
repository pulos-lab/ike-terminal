import { describe, it, expect } from 'vitest';
import type { PortfolioHistoryPoint } from 'shared';
import { computeMetrics, pickBest } from '../performance-metrics';

/** Punkt historii z zadanym TWR% (i opcjonalnie MWR%/benchmarkiem) — reszta pól neutralna. */
function pt(
  date: string,
  twrPct: number,
  returnPct = twrPct,
  benchmarkTwrPct = 0,
): PortfolioHistoryPoint {
  return {
    date,
    portfolioValue: 1000 * (1 + twrPct / 100),
    returnPct,
    twrPct,
    benchmarkValue: 0,
    benchmarkReturnPct: 0,
    benchmarkTwrPct,
    investedCumulative: 1000,
    cumulativeDepositsPln: 1000,
    cumulativeWithdrawalsPln: 0,
  };
}

/** Kolejne daty ISO od 2024-01-01. */
function isoDate(i: number): string {
  const d = new Date(Date.UTC(2024, 0, 1 + i));
  return d.toISOString().split('T')[0];
}

describe('computeMetrics', () => {
  it('zwraca null dla mniej niż 2 punktów', () => {
    expect(computeMetrics([], 5)).toBeNull();
    expect(computeMetrics([pt('2024-01-01', 0)], 5)).toBeNull();
  });

  it('rosnąca seria: zero drawdownu, 100% win rate, dodatni CAGR', () => {
    const data = [0, 1, 2, 3, 4].map((v, i) => pt(isoDate(i), v));
    const m = computeMetrics(data, 5)!;
    expect(m.maxDrawdown).toBe(0);
    expect(m.maxDrawdownDuration).toBe(0);
    expect(m.winRate).toBe(100);
    expect(m.cagr).toBeGreaterThan(0);
    expect(m.totalReturn).toBeCloseTo(4, 10);
  });

  it('znany drawdown: szczyt 1.25 → dołek 1.00 to obsunięcie 20%', () => {
    // Indeks TWR: 1.00 → 1.25 → 1.00 → 1.25
    const data = [0, 25, 0, 25].map((v, i) => pt(isoDate(i), v));
    const m = computeMetrics(data, 5)!;
    expect(m.maxDrawdown).toBeCloseTo(20, 10);
    expect(m.bestDay).toBeCloseTo(25, 10);
    expect(m.worstDay).toBeCloseTo(-20, 10);
    expect(m.winRate).toBeCloseTo((2 / 3) * 100, 10);
  });

  it('totalReturn liczy zwrot MWR za okres chain-linkingiem (nie różnicą p.p.)', () => {
    // MWR: 10% → 21% skumulowane = (1.21/1.10 − 1) = +10% w okresie
    const data = [pt(isoDate(0), 0, 10), pt(isoDate(1), 5, 21)];
    const m = computeMetrics(data, 5)!;
    expect(m.totalReturn).toBeCloseTo(10, 10);
  });

  it('wyższe rf obniża Sharpe Ratio (wrażliwość na stopę wolną od ryzyka)', () => {
    const data = Array.from({ length: 40 }, (_, i) => pt(isoDate(i), i * 0.5));
    const loRf = computeMetrics(data, 0)!;
    const hiRf = computeMetrics(data, 10)!;
    expect(loRf.sharpeRatio).toBeGreaterThan(hiRf.sharpeRatio);
  });

  it('beta/alfa null, gdy benchmark bez danych (same zera po nieudanym fetchu)', () => {
    const data = Array.from({ length: 40 }, (_, i) => pt(isoDate(i), i, i, 0));
    const m = computeMetrics(data, 5)!;
    expect(m.beta).toBeNull();
    expect(m.alphaAnnualPct).toBeNull();
  });

  it('beta/alfa null przy za krótkiej serii (<30 par zwrotów)', () => {
    const data = Array.from({ length: 10 }, (_, i) => pt(isoDate(i), i, i, i * 0.5 + 1));
    const m = computeMetrics(data, 5)!;
    expect(m.beta).toBeNull();
  });

  it('beta/alfa null przy płaskim benchmarku (zerowa wariancja)', () => {
    const data = Array.from({ length: 40 }, (_, i) => pt(isoDate(i), i * 0.3, i * 0.3, 5));
    const m = computeMetrics(data, 5)!;
    expect(m.beta).toBeNull();
  });

  it('beta ≈ 2 gdy dzienne zwroty portfela są dokładnie 2× benchmarku; alfa ≈ 0 przy rf=0', () => {
    // Zmienne dzienne zwroty benchmarku, portfel = dokładnie 2× każdy z nich.
    const benchDaily = Array.from({ length: 45 }, (_, i) =>
      i % 3 === 0 ? 0.01 : i % 3 === 1 ? -0.005 : 0.002,
    );
    let benchIdx = 1;
    let portIdx = 1;
    const data = [pt(isoDate(0), 0, 0, 0.0001)];
    benchDaily.forEach((r, i) => {
      benchIdx *= 1 + r;
      portIdx *= 1 + 2 * r;
      data.push(pt(isoDate(i + 1), (portIdx - 1) * 100, (portIdx - 1) * 100, (benchIdx - 1) * 100));
    });
    const m = computeMetrics(data, 0)!;
    expect(m.beta).not.toBeNull();
    expect(m.beta!).toBeCloseTo(2, 2);
    expect(m.alphaAnnualPct!).toBeCloseTo(0, 1);
  });
});

describe('pickBest', () => {
  it('kierunek high/low', () => {
    expect(pickBest([1, 3, 2], 'high')).toBe(3);
    expect(pickBest([1, 3, 2], 'low')).toBe(1);
  });

  it('null gdy mniej niż 2 nie-nullowe wartości (nie ma czego porównywać)', () => {
    expect(pickBest([], 'high')).toBeNull();
    expect(pickBest([5], 'high')).toBeNull();
    expect(pickBest([5, null, null], 'high')).toBeNull();
  });

  it('ignoruje nulle w porównaniu', () => {
    expect(pickBest([null, 2, 7], 'high')).toBe(7);
  });

  it('najgorszy dzień: mniej ujemny = lepszy (kierunek high na ujemnych)', () => {
    expect(pickBest([-5, -2, -10], 'high')).toBe(-2);
  });
});
