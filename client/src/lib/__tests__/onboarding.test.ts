import { describe, it, expect } from 'vitest';
import { shouldShowGettingStarted } from '../onboarding';

describe('shouldShowGettingStarted', () => {
  it('pusty portfel → karta', () => {
    expect(shouldShowGettingStarted({ transactions: 0, operations: 0 }, false)).toBe(true);
  });

  it('cokolwiek w portfelu (także sama wpłata) → bez karty', () => {
    expect(shouldShowGettingStarted({ transactions: 1, operations: 0 }, false)).toBe(false);
    expect(shouldShowGettingStarted({ transactions: 0, operations: 1 }, false)).toBe(false);
  });

  it('status jeszcze się nie wczytał → bez karty (żadnego mignięcia)', () => {
    expect(shouldShowGettingStarted(undefined, false)).toBe(false);
  });

  it('tryb demo → nigdy', () => {
    expect(shouldShowGettingStarted({ transactions: 0, operations: 0 }, true)).toBe(false);
  });
});
