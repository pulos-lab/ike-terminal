import { describe, it, expect } from 'vitest';
import { isSuspiciousDividendAmount } from '../dividend-scanner.js';

describe('isSuspiciousDividendAmount', () => {
  it('realny case BKNG: 0.42 USD przy rocznej stawce 38.4 (kwartalnie ~9.60) → podejrzane', () => {
    const out = isSuspiciousDividendAmount(0.42, 38.4, 4);
    expect(out.suspicious).toBe(true);
    if (out.suspicious) {
      expect(out.expected).toBeCloseTo(9.6, 6);
      expect(out.ratio).toBeCloseTo(22.857, 2);
    }
  });

  it('kwota zgodna z ratą per wypłatę → OK', () => {
    expect(isSuspiciousDividendAmount(9.6, 38.4, 4).suspicious).toBe(false);
  });

  it('odchył w granicach ×4 (np. obniżka dywidendy) → OK', () => {
    expect(isSuspiciousDividendAmount(2.5, 38.4, 4).suspicious).toBe(false); // ×3.84
  });

  it('kwota zawyżona ponad ×4 → podejrzane', () => {
    const out = isSuspiciousDividendAmount(50, 38.4, 4);
    expect(out.suspicious).toBe(true);
    if (out.suspicious) expect(out.ratio).toBeCloseTo(5.208, 2);
  });

  it('brak referencji (dividendRate null/0) → nie oceniamy', () => {
    expect(isSuspiciousDividendAmount(0.42, null, 4).suspicious).toBe(false);
    expect(isSuspiciousDividendAmount(0.42, 0, 4).suspicious).toBe(false);
  });

  it('GPW (wypłata roczna): payoutsPerYear=1 porównuje z pełną roczną stawką', () => {
    expect(isSuspiciousDividendAmount(10, 10, 1).suspicious).toBe(false);
    expect(isSuspiciousDividendAmount(2, 10, 1).suspicious).toBe(true); // ×5
  });
});
