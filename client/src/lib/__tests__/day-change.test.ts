import { describe, it, expect } from 'vitest';
import type { PortfolioDayChange } from 'shared';
import { describeDayChange, quoteFreshnessText } from '../day-change';

const NOW = new Date(2026, 10, 9, 14, 0); // poniedziałek 9.11.2026, czas lokalny

const full: PortfolioDayChange = {
  change: 1234.56,
  changePct: 0.62,
  currency: 'PLN',
  coveredCount: 14,
  totalCount: 14,
  missingTickers: [],
  fxIncluded: false,
  hasForeignPositions: false,
};

const quotes = (over: Partial<{ asOf: string | null; marketOpen: boolean }> = {}) => ({
  asOf: new Date(2026, 10, 9, 13, 45).toISOString(),
  nextRefreshAt: new Date(2026, 10, 9, 14, 15).toISOString(),
  marketOpen: true,
  ...over,
});

describe('describeDayChange', () => {
  it('brak kontraktu (portfel bez pozycji, stary serwer) → null', () => {
    expect(describeDayChange(null, quotes(), NOW)).toBeNull();
    expect(describeDayChange(undefined, undefined, NOW)).toBeNull();
  });

  it('pełne pokrycie w trakcie sesji: „Dziś”, bez dopisków', () => {
    expect(describeDayChange(full, quotes(), NOW)).toEqual({
      label: 'Dziś',
      amount: 1234.56,
      pct: 0.62,
      currency: 'PLN',
      coverageNote: null,
      missingTickers: [],
      fxNote: null,
    });
  });

  it('niepełne pokrycie zawsze dostaje dopisek z liczbami', () => {
    const v = describeDayChange(
      { ...full, coveredCount: 12, missingTickers: ['NCX', 'OPT'] },
      quotes(),
      NOW,
    );
    expect(v?.coverageNote).toBe('bez danych: 2 z 14');
    expect(v?.missingTickers).toEqual(['NCX', 'OPT']);
  });

  it('zerowe pokrycie przenosi null — UI pokaże „brak danych”, nie 0', () => {
    const v = describeDayChange(
      { ...full, change: null, changePct: null, coveredCount: 0 },
      quotes(),
      NOW,
    );
    expect(v?.amount).toBeNull();
    expect(v?.coverageNote).toBe('bez danych: 14 z 14');
  });

  it('kursy z innego dnia przy zamkniętym rynku → „Ostatnia sesja”', () => {
    const friday = new Date(2026, 10, 6, 17, 5).toISOString();
    const v = describeDayChange(full, quotes({ asOf: friday, marketOpen: false }), NOW);
    expect(v?.label).toBe('Ostatnia sesja');
  });

  it('po zamknięciu, ale kursy z dziś → nadal „Dziś”', () => {
    const v = describeDayChange(full, quotes({ marketOpen: false }), NOW);
    expect(v?.label).toBe('Dziś');
  });

  it('pozycje zagraniczne dostają dopisek o kursach walut', () => {
    const v = describeDayChange({ ...full, hasForeignPositions: true }, quotes(), NOW);
    expect(v?.fxNote).toBe('bez ruchu kursów walut');
  });
});

describe('quoteFreshnessText', () => {
  it('kurs z dziś: sama godzina + stan rynku', () => {
    expect(quoteFreshnessText(quotes(), NOW)).toBe('Kursy z 13:45 · sesja trwa');
  });

  it('kurs z innego dnia: z datą', () => {
    const friday = new Date(2026, 10, 6, 17, 5).toISOString();
    expect(quoteFreshnessText(quotes({ asOf: friday, marketOpen: false }), NOW)).toBe(
      'Kursy z 06.11 17:05 · rynek zamknięty',
    );
  });

  it('brak znacznika czasu', () => {
    expect(quoteFreshnessText(quotes({ asOf: null, marketOpen: false }), NOW)).toBe(
      'Kursy z cache · rynek zamknięty',
    );
  });
});
