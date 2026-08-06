import { describe, it, expect } from 'vitest';
import type { Position } from 'shared';
import {
  selectEarningsCandidates,
  buildUpcomingEarnings,
  daysBetweenIso,
} from '../earnings/earnings-window.js';
import type { EarningsRow } from '../earnings/earnings-store.js';

function position(overrides: Partial<Position>): Position {
  return {
    paperName: 'Test',
    isin: 'US0000000001',
    ticker: 'TEST',
    shares: 10,
    avgBuyPrice: 100,
    totalCommission: 0,
    currentPrice: 110,
    currentValue: 1100,
    currentValuePln: 4400,
    profitLoss: 100,
    profitLossPln: 400,
    profitLossPct: 10,
    currency: 'USD',
    weight: 1,
    exchange: 'NASDAQ',
    dailyChangePct: null,
    category: 'stock',
    ...overrides,
  };
}

function row(overrides: Partial<EarningsRow>): EarningsRow {
  return {
    market: 'US',
    symbolKey: 'TEST',
    reportDate: '2026-08-05',
    confidence: 'confirmed',
    session: 'amc',
    fiscalLabel: 'Q2 2026',
    reportKind: 'quarterly',
    source: 'nasdaq',
    epsForecast: null,
    ...overrides,
  };
}

describe('daysBetweenIso', () => {
  it('liczy dni kalendarzowe bez wpływu stref', () => {
    expect(daysBetweenIso('2026-08-01', '2026-08-08')).toBe(7);
    expect(daysBetweenIso('2026-08-08', '2026-08-08')).toBe(0);
    expect(daysBetweenIso('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('przechodzi przez zmianę czasu bez gubienia doby', () => {
    // Ostatnia niedziela października — w strefie lokalnej doba ma 25 h.
    expect(daysBetweenIso('2026-10-24', '2026-10-26')).toBe(2);
  });
});

describe('selectEarningsCandidates', () => {
  it('bierze akcje, odrzuca ETF, obligacje i CFD', () => {
    const result = selectEarningsCandidates([
      position({ isin: 'A', ticker: 'AAPL', category: 'stock' }),
      position({ isin: 'B', ticker: 'SPY', category: 'etf' }),
      position({ isin: 'C', ticker: 'DS1023', category: 'bond' }),
      position({ isin: 'D', ticker: 'GOLD', category: 'cfd' }),
    ]);
    expect(result.map((c) => c.ticker)).toEqual(['AAPL']);
  });

  it('odrzuca obligacje Catalyst po giełdzie', () => {
    const result = selectEarningsCandidates([
      position({ isin: 'E', ticker: 'BST0728', exchange: 'CATALYST', category: 'stock' }),
    ]);
    expect(result).toEqual([]);
  });

  it('pomija pozycje zerowe', () => {
    expect(selectEarningsCandidates([position({ shares: 0 })])).toEqual([]);
  });

  it('REGRESJA: pozycja krótka DOSTAJE terminarz', () => {
    // Odwrotnie niż w /dividends/upcoming (tam shares <= 0 jest pomijane):
    // wystawiona opcja / short jest najbardziej wrażliwa na publikację wyników.
    const result = selectEarningsCandidates([position({ shares: -100, ticker: 'MSTR' })]);
    expect(result.map((c) => c.ticker)).toEqual(['MSTR']);
  });

  it('mapuje opcję na spółkę bazową i dziedziczy jej giełdę', () => {
    const result = selectEarningsCandidates([
      position({ isin: 'US1', ticker: 'DKNG', exchange: 'NASDAQ', category: 'stock' }),
      position({
        isin: 'OPT:DKNG220520P00045000',
        ticker: 'DKNG220520P00045000',
        exchange: 'OTHER',
        category: 'option',
        shares: -1,
        optionMeta: {
          underlying: 'DKNG',
          expiry: '2022-05-20',
          strike: 45,
          optionType: 'P',
          multiplier: 100,
        },
      }),
    ]);
    const option = result.find((c) => c.isin.startsWith('OPT:'));
    expect(option).toMatchObject({ ticker: 'DKNG', exchange: 'NASDAQ', viaUnderlying: true });
  });

  it('wyciąga spółkę bazową z symbolu OCC, gdy brak metadanych', () => {
    const result = selectEarningsCandidates([
      position({
        isin: 'OPT:PLTR260116C00030000',
        ticker: 'PLTR260116C00030000',
        exchange: 'OTHER',
        category: 'option',
        optionMeta: undefined,
      }),
    ]);
    expect(result[0]).toMatchObject({ ticker: 'PLTR', viaUnderlying: true });
  });

  it('bez kategorii przepuszcza papiery i zostawia filtr rozpoznaniu rynku', () => {
    // Wcześniej ta ścieżka zawężała po liście dozwolonych giełd, przez co akcja
    // z `exchange='OTHER'` przepadała. Kandydatów odsiewa teraz dopiero
    // `resolveEarningsMarket` — nierozpoznany rynek i tak nie ma jak dopasować.
    const result = selectEarningsCandidates([
      position({ isin: 'F', ticker: 'CDR.WA', exchange: 'GPW', category: undefined }),
      position({ isin: 'G', ticker: 'XXX', exchange: 'OTHER', category: undefined }),
    ]);
    expect(result.map((c) => c.ticker)).toEqual(['CDR.WA', 'XXX']);
  });

  it('przenosi kraj i walutę, żeby rynek dał się rozpoznać mimo giełdy OTHER', () => {
    const result = selectEarningsCandidates([
      position({
        isin: 'AUTO_FIG',
        ticker: 'FIG',
        exchange: 'OTHER',
        country: 'United States',
        currency: 'USD',
      }),
    ]);
    expect(result[0]).toMatchObject({
      ticker: 'FIG',
      exchange: 'OTHER',
      country: 'United States',
      currency: 'USD',
    });
  });

  it('opcja dziedziczy podpowiedzi rynku po pozycji bazowej', () => {
    const result = selectEarningsCandidates([
      position({
        isin: 'AUTO_FIG',
        ticker: 'FIG',
        exchange: 'OTHER',
        country: 'United States',
        currency: 'USD',
      }),
      position({
        isin: 'OPT:FIG260220C00050000',
        ticker: 'FIG260220C00050000',
        exchange: 'OTHER',
        category: 'option',
        optionMeta: {
          underlying: 'FIG',
          expiry: '2026-02-20',
          strike: 50,
          optionType: 'C',
          multiplier: 100,
        },
      }),
    ]);
    const option = result.find((c) => c.isin.startsWith('OPT:'));
    expect(option).toMatchObject({ ticker: 'FIG', country: 'United States', currency: 'USD' });
  });
});

describe('buildUpcomingEarnings', () => {
  const candidate = {
    isin: 'US0000000001',
    ticker: 'TEST',
    name: null,
    exchange: 'NASDAQ',
    viaUnderlying: false,
    market: 'US' as const,
    symbolKey: 'TEST',
  };

  it('wybiera najbliższą przyszłą publikację', () => {
    const result = buildUpcomingEarnings(
      [candidate],
      [row({ reportDate: '2026-11-04' }), row({ reportDate: '2026-08-05' })],
      '2026-08-01',
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ reportDate: '2026-08-05', daysUntil: 4 });
  });

  it('pomija daty przeszłe', () => {
    const result = buildUpcomingEarnings(
      [candidate],
      [row({ reportDate: '2026-07-01' })],
      '2026-08-01',
    );
    expect(result).toEqual([]);
  });

  it('przy tej samej dacie wygrywa pewniejsze źródło', () => {
    const result = buildUpcomingEarnings(
      [candidate],
      [
        row({ reportDate: '2026-08-05', confidence: 'estimated', source: 'sec-estimate' }),
        row({ reportDate: '2026-08-05', confidence: 'confirmed', source: 'nasdaq' }),
      ],
      '2026-08-01',
    );
    expect(result[0]).toMatchObject({ confidence: 'confirmed', source: 'nasdaq' });
  });

  it('odcina publikacje poza horyzontem zbierania', () => {
    const result = buildUpcomingEarnings(
      [candidate],
      [row({ reportDate: '2027-01-05' })],
      '2026-08-01',
    );
    expect(result).toEqual([]);
  });

  it('nie miesza rynków o tym samym kluczu symbolu', () => {
    const plCandidate = { ...candidate, isin: 'PL1', market: 'PL' as const, symbolKey: 'TEST' };
    const result = buildUpcomingEarnings(
      [plCandidate],
      [row({ market: 'US', symbolKey: 'TEST', reportDate: '2026-08-05' })],
      '2026-08-01',
    );
    expect(result).toEqual([]);
  });

  it('oznacza pozycje opcyjne flagą viaUnderlying', () => {
    const result = buildUpcomingEarnings(
      [{ ...candidate, isin: 'OPT:X', viaUnderlying: true }],
      [row({ reportDate: '2026-08-05' })],
      '2026-08-01',
    );
    expect(result[0].viaUnderlying).toBe(true);
  });
});
