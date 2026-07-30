import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createEarningsStore,
  type EarningsRow,
  type EarningsStore,
} from '../earnings/earnings-store.js';

function row(overrides: Partial<EarningsRow> = {}): EarningsRow {
  return {
    market: 'US',
    symbolKey: 'AAPL',
    reportDate: '2026-08-05',
    confidence: 'confirmed',
    session: 'amc',
    fiscalLabel: 'Q3 2026',
    reportKind: 'quarterly',
    source: 'nasdaq',
    epsForecast: 1.23,
    ...overrides,
  };
}

const OPTS = { fromDate: '2026-08-01', fetchedAt: '2026-08-01T10:00:00.000Z' };

describe('earnings-store', () => {
  let store: EarningsStore;

  beforeEach(() => {
    store = createEarningsStore({ dbFile: ':memory:' });
  });
  afterEach(() => store.close());

  it('zapisuje i odczytuje wiersze po symbolach', () => {
    store.replaceSource('nasdaq', 'US', [row(), row({ symbolKey: 'MSFT' })], OPTS);
    const rows = store.getForSymbols('US', ['AAPL'], '2026-08-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbolKey: 'AAPL',
      confidence: 'confirmed',
      epsForecast: 1.23,
    });
  });

  it('podmiana źródła usuwa nieaktualny termin (przesunięcie daty publikacji)', () => {
    store.replaceSource('nasdaq', 'US', [row({ reportDate: '2026-08-05' })], OPTS);
    store.replaceSource('nasdaq', 'US', [row({ reportDate: '2026-08-12' })], OPTS);
    const rows = store.getForSymbols('US', ['AAPL'], '2026-08-01');
    expect(rows.map((r) => r.reportDate)).toEqual(['2026-08-12']);
  });

  it('podmiana JEDNEGO źródła nie rusza pozostałych', () => {
    store.replaceSource('nasdaq', 'US', [row()], OPTS);
    store.replaceSource(
      'bankier',
      'PL',
      [row({ market: 'PL', symbolKey: 'CDPROJEKT', source: 'bankier' })],
      OPTS,
    );
    store.replaceSource('nasdaq', 'US', [], OPTS);

    expect(store.getForSymbols('US', ['AAPL'], '2026-08-01')).toEqual([]);
    expect(store.getForSymbols('PL', ['CDPROJEKT'], '2026-08-01')).toHaveLength(1);
  });

  it('podmiana nie kasuje przeszłości sprzed okna', () => {
    store.replaceSource('nasdaq', 'US', [row({ reportDate: '2026-05-01' })], {
      ...OPTS,
      fromDate: '2026-01-01',
    });
    store.replaceSource('nasdaq', 'US', [row({ reportDate: '2026-08-05' })], OPTS);
    const rows = store.getForSymbols('US', ['AAPL'], '2026-01-01');
    expect(rows.map((r) => r.reportDate)).toEqual(['2026-05-01', '2026-08-05']);
  });

  it('rozróżnia rynki o tym samym kluczu symbolu', () => {
    store.replaceSource('nasdaq', 'US', [row({ symbolKey: 'GPW' })], OPTS);
    store.replaceSource(
      'bankier',
      'PL',
      [row({ market: 'PL', symbolKey: 'GPW', source: 'bankier' })],
      OPTS,
    );
    expect(store.getForSymbols('US', ['GPW'], '2026-08-01')).toHaveLength(1);
    expect(store.getForSymbols('PL', ['GPW'], '2026-08-01')[0].source).toBe('bankier');
  });

  it('trzyma stan odświeżania i mapowania symboli', () => {
    expect(store.getStateMs('us:last_success')).toBeNull();
    store.setState('us:last_success', '2026-08-01T10:00:00.000Z');
    expect(store.getStateMs('us:last_success')).toBe(Date.parse('2026-08-01T10:00:00.000Z'));

    store.putSymbolMapping(
      'PL',
      'cdr.wa',
      { symbolKey: 'CDPROJEKT', resolvedBy: 'name-index', confidence: 1 },
      OPTS.fetchedAt,
    );
    // Klucz jest case-insensitive — ticker normalizowany do uppercase przy zapisie i odczycie.
    expect(store.getSymbolMapping('PL', 'CDR.WA')).toMatchObject({ symbolKey: 'CDPROJEKT' });
  });

  it('liczy wiersze i sprząta przeszłość', () => {
    store.replaceSource(
      'nasdaq',
      'US',
      [row({ reportDate: '2026-05-01' }), row({ reportDate: '2026-08-05' })],
      {
        ...OPTS,
        fromDate: '2026-01-01',
      },
    );
    expect(store.countFrom('US', '2026-01-01')).toBe(2);
    store.pruneBefore('2026-07-01');
    expect(store.countFrom('US', '2026-01-01')).toBe(1);
  });

  it('pusta lista symboli nie odpytuje bazy', () => {
    expect(store.getForSymbols('US', [], '2026-08-01')).toEqual([]);
  });
});
