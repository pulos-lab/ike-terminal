import { describe, it, expect } from 'vitest';
import { parseOccTicker, displayOptionTicker } from 'shared';
import {
  parseOptionSymbol,
  toOccTicker,
  toOptionPseudoIsin,
  normalizeBondSymbol,
  parseForexSymbol,
  normalizeOccSymbol,
} from '../ibkr/symbols.js';

/**
 * Symbole z realnych wyciągów IBKR 2021-2025 (konta IB Central Europe / IB Ireland).
 */

describe('parseOptionSymbol', () => {
  it('parsuje puta USA "DKNG 20MAY22 45.0 P"', () => {
    expect(parseOptionSymbol('DKNG 20MAY22 45.0 P')).toEqual({
      underlying: 'DKNG',
      expiry: '2022-05-20',
      strike: 45,
      optionType: 'P',
    });
  });

  it('parsuje calla Eurex z ułamkowym strikiem "LHA 16DEC22 5.6 C"', () => {
    expect(parseOptionSymbol('LHA 16DEC22 5.6 C')).toEqual({
      underlying: 'LHA',
      expiry: '2022-12-16',
      strike: 5.6,
      optionType: 'C',
    });
  });

  it('parsuje strike całkowity bez kropki "SOFI 17JAN25 5 C"', () => {
    expect(parseOptionSymbol('SOFI 17JAN25 5 C')).toEqual({
      underlying: 'SOFI',
      expiry: '2025-01-17',
      strike: 5,
      optionType: 'C',
    });
  });

  it('zwraca null dla zwykłych akcji i obligacji', () => {
    expect(parseOptionSymbol('AAPL')).toBeNull();
    expect(parseOptionSymbol('T 2 7/8 05/15/32 3.92547561%')).toBeNull();
    expect(parseOptionSymbol('USD.PLN')).toBeNull();
  });
});

describe('toOccTicker / toOptionPseudoIsin', () => {
  it('koduje strike ×1000 na 8 cyfrach (format akceptowany przez Yahoo v8 chart)', () => {
    const opt = parseOptionSymbol('DKNG 20MAY22 45.0 P')!;
    expect(toOccTicker(opt)).toBe('DKNG220520P00045000');
    expect(toOptionPseudoIsin(opt)).toBe('OPT:DKNG220520P00045000');
  });

  it('obsługuje strike ułamkowy (5.6 → 00005600)', () => {
    const opt = parseOptionSymbol('LHA 16DEC22 5.6 C')!;
    expect(toOccTicker(opt)).toBe('LHA221216C00005600');
  });

  it('jest zgodny z symbolem OCC z sekcji ContractInfo realnego wyciągu', () => {
    // ContractInfo 2024: "INTC  240906P00018000" ↔ Trades: "INTC 06SEP24 18 P"
    const opt = parseOptionSymbol('INTC 06SEP24 18 P')!;
    expect(toOccTicker(opt)).toBe(normalizeOccSymbol('INTC  240906P00018000'));
  });
});

describe('normalizeBondSymbol', () => {
  it('odcina yield z symbolu w Trades', () => {
    expect(normalizeBondSymbol('T 2 7/8 05/15/32 3.92547561%')).toBe('T 2 7/8 05/15/32');
  });

  it('symbol bez yieldu (ContractInfo/CombInt) zostaje bez zmian', () => {
    expect(normalizeBondSymbol('T 2 7/8 05/15/32')).toBe('T 2 7/8 05/15/32');
  });
});

describe('parseForexSymbol', () => {
  it('parsuje parę walutową z Trades', () => {
    expect(parseForexSymbol('USD.PLN')).toEqual({ base: 'USD', quote: 'PLN' });
    expect(parseForexSymbol('EUR.PLN')).toEqual({ base: 'EUR', quote: 'PLN' });
  });

  it('zwraca null dla akcji', () => {
    expect(parseForexSymbol('AAPL')).toBeNull();
  });
});

describe('parseOccTicker / displayOptionTicker (etykiety UI)', () => {
  it('parsuje ticker OCC z powrotem na parametry kontraktu', () => {
    expect(parseOccTicker('OKLO271217P00015000')).toEqual({
      underlying: 'OKLO',
      expiry: '2027-12-17',
      strike: 15,
      optionType: 'P',
    });
    expect(parseOccTicker('LHA221216C00005600')?.strike).toBe(5.6);
  });

  it('formatuje czytelną etykietę z datą w formacie UI', () => {
    expect(displayOptionTicker('OKLO271217P00015000')).toBe('OKLO 15 PUT 17.12.2027');
    expect(displayOptionTicker('AAPL261218C00250000')).toBe('AAPL 250 CALL 18.12.2026');
  });

  it('zwykłe tickery przechodzą bez zmian (bezpieczny wrapper)', () => {
    expect(displayOptionTicker('AAPL')).toBe('AAPL');
    expect(displayOptionTicker('CDR.WA')).toBe('CDR.WA');
    expect(displayOptionTicker('DS1030')).toBe('DS1030'); // obligacja z cyframi
    expect(parseOccTicker('SPOT')).toBeNull();
  });
});
