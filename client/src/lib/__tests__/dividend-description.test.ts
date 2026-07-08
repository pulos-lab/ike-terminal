import { describe, it, expect } from 'vitest';
import { formatDividendDescription } from '../dividend-description';

describe('formatDividendDescription', () => {
  it('skraca długi opis auto-dywidendy z artefaktem FP w liczbie akcji', () => {
    expect(
      formatDividendDescription(
        'Dywidenda META (8.881784197001252e-16 szt. × 0.525 USD, podatek 19% [zwykłe])',
      ),
    ).toBe('0.525 USD/szt · podatek 19%');
  });

  it('skraca opis z normalną liczbą akcji i kontem IKE/IKZE', () => {
    expect(
      formatDividendDescription('Dywidenda MSFT (100 szt. × 0.91 USD, podatek 15% [IKE/IKZE])'),
    ).toBe('0.91 USD/szt · podatek 15%');
  });

  it('skraca opis dywidendy zaimportowanej z IBKR (Cash Dividend per Share)', () => {
    expect(
      formatDividendDescription('MA(US57636Q1040) Cash Dividend USD 0.76 per Share (podatek 15%)'),
    ).toBe('0.76 USD/szt · podatek 15%');
    // Bez podatku (np. NRA exempt) — sama stawka na akcję
    expect(
      formatDividendDescription('TSM(US8740391003) Cash Dividend USD 0.491246 per Share'),
    ).toBe('0.491246 USD/szt');
  });

  it('zostawia bez zmian opisy ręczne, kupony i już krótkie', () => {
    expect(formatDividendDescription('Wypłata dywidendy PKN')).toBe('Wypłata dywidendy PKN');
    expect(formatDividendDescription('0.525 USD/szt · podatek 19%')).toBe(
      '0.525 USD/szt · podatek 19%',
    );
    expect(
      formatDividendDescription('Kupon obligacji: Bond Coupon Payment (T 2 7/8 05/15/32)'),
    ).toBe('Kupon obligacji: Bond Coupon Payment (T 2 7/8 05/15/32)');
  });
});
