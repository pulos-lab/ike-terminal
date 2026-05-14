import { describe, it, expect } from 'vitest';
import { tryNcOfflineGuard } from '../isin-resolver.js';

describe('tryNcOfflineGuard', () => {
  it('zwraca NC entry dla SEVENET-NC (rzeczywisty polski ISIN) — pułapka Yahoo SEV.WA bez OHLC', () => {
    const result = tryNcOfflineGuard('PLSEVNT00018', 'SEVENET-NC');
    expect(result).toEqual({
      isin: 'PLSEVNT00018',
      ticker: 'SEV.WA',
      name: 'SEVENET',
      exchange: 'NC',
      currency: 'PLN',
      priceSource: 'stooq',
    });
  });

  it('regression: MINERAL-NC → MND.WA NC stooq (już dziś działa, sanity check)', () => {
    const result = tryNcOfflineGuard('PLMNRLM00018', 'MINERAL-NC');
    expect(result).toEqual({
      isin: 'PLMNRLM00018',
      ticker: 'MND.WA',
      name: 'MINERAL',
      exchange: 'NC',
      currency: 'PLN',
      priceSource: 'stooq',
    });
  });

  it('obsługuje wariant sufiksu -NC-FIX', () => {
    const result = tryNcOfflineGuard('PLSEVNT00018', 'SEVENET-NC-FIX');
    expect(result?.ticker).toBe('SEV.WA');
    expect(result?.exchange).toBe('NC');
  });

  it('zwraca null gdy paper name nie ma sufiksu -NC (regularna GPW lub ręczny wpis)', () => {
    expect(tryNcOfflineGuard('PLPKO0000016', 'PKO BP')).toBeNull();
    expect(tryNcOfflineGuard('PLSEVNT00018', 'SEVENET')).toBeNull();
  });

  it('zwraca null gdy spółka nie jest w NC offline map', () => {
    expect(tryNcOfflineGuard('PLXXXXX00010', 'NIEZNANASPOLKA-NC')).toBeNull();
  });

  it('zwraca null dla zbyt krótkich nazw (ochrona przed false-positive)', () => {
    expect(tryNcOfflineGuard('PLX0000000010', 'A-NC')).toBeNull();
  });
});
