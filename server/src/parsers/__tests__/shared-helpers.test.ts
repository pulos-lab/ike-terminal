import { describe, it, expect } from 'vitest';
import { currencyBucket, penceFactor, sameCurrency, isIsinShape, isValidIsin } from 'shared';
import { normalizeNumericText, parseNumber, isStrictNumber } from '../utils.js';
import { parseIbkrNumber } from '../ibkr/html-tables.js';

describe('currencyBucket / penceFactor / sameCurrency', () => {
  it('GBX, GBp i GBP to jeden kubełek; pensy niosą współczynnik 0.01', () => {
    expect(['GBX', 'GBp', 'gbp', ' GBP '].map(currencyBucket)).toEqual([
      'GBP',
      'GBP',
      'GBP',
      'GBP',
    ]);
    expect(penceFactor('GBX')).toBe(0.01);
    expect(penceFactor('GBp')).toBe(0.01);
    expect(penceFactor('GBP')).toBe(1);
    expect(sameCurrency('GBX', 'GBP')).toBe(true);
    expect(sameCurrency('USD', 'GBP')).toBe(false);
    expect(currencyBucket(undefined)).toBe('');
  });
});

describe('isIsinShape / isValidIsin', () => {
  it('ścisły kształt: ostatni znak musi być cyfrą', () => {
    expect(isIsinShape('PLPKN0000018')).toBe(true);
    expect(isIsinShape('PGEPOLSKAGRU')).toBe(false); // 12 liter — pseudo-ISIN z nazwy
    expect(isIsinShape('ETFSP500')).toBe(false);
  });
  it('cyfra kontrolna', () => {
    expect(isValidIsin('US0378331005')).toBe(true); // Apple
    expect(isValidIsin('PLPKN0000018')).toBe(true); // Orlen
    expect(isValidIsin('US0378331006')).toBe(false);
  });
});

describe('normalizeNumericText — wspólne czyszczenie liczb', () => {
  it('typograficzny minus i NBSP', () => {
    expect(normalizeNumericText('−1 076,52')).toBe('-1076.52');
    expect(parseNumber('−12,5')).toBe(-12.5);
    expect(isStrictNumber('−1 234,56')).toBe(true);
    expect(isStrictNumber('12abc')).toBe(false);
  });
  it('parseIbkrNumber obsługuje U+2212 (obietnica z opisu funkcji)', () => {
    expect(parseIbkrNumber('−1,076.52')).toBe(-1076.52);
    expect(parseIbkrNumber('--')).toBeNull();
  });
});
