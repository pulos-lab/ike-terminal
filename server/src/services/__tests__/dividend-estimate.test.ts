import { describe, it, expect } from 'vitest';
import { estimateDividendPerShare } from '../dividend-estimate.js';

describe('estimateDividendPerShare', () => {
  it('zwraca kwotę ostatniej realnej dywidendy gdy są zdarzenia', () => {
    const events = [
      { date: '2025-09-10', amount: 0.25 },
      { date: '2025-12-10', amount: 0.26 },
      { date: '2025-06-10', amount: 0.25 },
    ];
    // ostatnie zdarzenie (2025-12-10) wygrywa, nie annualRate
    expect(estimateDividendPerShare(events, 1.0)).toBe(0.26);
  });

  it('ignoruje zdarzenia z kwotą <= 0', () => {
    const events = [
      { date: '2025-12-10', amount: 0 },
      { date: '2025-09-10', amount: 0.3 },
    ];
    expect(estimateDividendPerShare(events, 2.0)).toBe(0.3);
  });

  it('fallback annualRate / 4 (kwartalnie) gdy brak zdarzeń', () => {
    expect(estimateDividendPerShare([], 2.0)).toBe(0.5);
  });

  it('fallback annualRate / 4 gdy wszystkie zdarzenia mają kwotę 0', () => {
    expect(estimateDividendPerShare([{ date: '2025-12-10', amount: 0 }], 1.0)).toBe(0.25);
  });

  it('zwraca null gdy brak zdarzeń i annualRate <= 0', () => {
    expect(estimateDividendPerShare([], 0)).toBeNull();
    expect(estimateDividendPerShare([], -1)).toBeNull();
  });

  it('nie zakłada posortowanych zdarzeń', () => {
    const events = [
      { date: '2025-03-10', amount: 0.2 },
      { date: '2025-12-10', amount: 0.28 },
      { date: '2025-06-10', amount: 0.22 },
      { date: '2025-09-10', amount: 0.24 },
    ];
    expect(estimateDividendPerShare(events, 0.8)).toBe(0.28);
  });
});
