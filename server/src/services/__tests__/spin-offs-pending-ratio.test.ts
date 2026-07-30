import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TickerMapEntry, AppliedSpinOff } from 'shared';

// DATA_DIR przed importem modułu (applier ciągnie łańcuch db/config)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-pending-ratio-'));
process.env.DATA_DIR = tmpDir;

const pendingEvents = vi.fn<
  () => Array<{
    parentTicker: string;
    childTicker: string;
    exDate: string;
    childName: string | null;
  }>
>();
const knownSpinOffs = vi.fn<() => AppliedSpinOff[]>();

vi.mock('../spinoff-events.js', () => ({
  getSpinoffEventsService: () => ({
    getEvents: async () => [],
    getPendingRatioEvents: pendingEvents,
    close: () => {},
  }),
}));

vi.mock('../../db/spin-offs-repo.js', () => ({
  getSpinOffs: knownSpinOffs,
  insertSpinOff: vi.fn(),
  updateSpinOffStatus: vi.fn(),
}));

const { getPendingRatioSpinOffs } = await import('../spin-offs-applier.js');

const NOW = new Date('2026-07-31T12:00:00Z');
const PID = 'test-portfolio';

/** Portfel trzymający SPGI (rodzic zdarzenia ze scrapera). */
function heldSpgi(): Map<string, TickerMapEntry> {
  return new Map([
    [
      'US78409V1044',
      {
        isin: 'US78409V1044',
        ticker: 'SPGI',
        name: 'S&P Global',
        exchange: 'NYSE',
        currency: 'USD',
        priceSource: 'yahoo',
      } as TickerMapEntry,
    ],
  ]);
}

function knownRow(overrides: Partial<AppliedSpinOff> = {}): AppliedSpinOff {
  return {
    parentIsin: 'US78409V1044',
    parentTicker: 'SPGI',
    childIsin: 'AUTO_MBGL',
    childTicker: 'MBGL',
    exDate: '2026-07-25',
    ratio: 1,
    allocationPct: 0.08,
    childQty: 10,
    currency: 'USD',
    status: 'applied',
    source: 'map',
    ...overrides,
  };
}

describe('getPendingRatioSpinOffs — wygaszanie sygnalizacji', () => {
  beforeEach(() => {
    knownSpinOffs.mockReturnValue([]);
    pendingEvents.mockReturnValue([
      { parentTicker: 'SPGI', childTicker: 'MBGL', exDate: '2026-07-25', childName: null },
    ]);
  });

  it('świeże zdarzenie u trzymanego rodzica → sygnalizowane', () => {
    const rows = getPendingRatioSpinOffs(PID, heldSpgi(), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ parentTicker: 'SPGI', childTicker: 'MBGL' });
  });

  it('zdarzenie zapowiedziane (ex w przyszłości) → sygnalizowane', () => {
    pendingEvents.mockReturnValue([
      { parentTicker: 'SPGI', childTicker: 'MBGL', exDate: '2026-08-20', childName: null },
    ]);
    expect(getPendingRatioSpinOffs(PID, heldSpgi(), NOW)).toHaveLength(1);
  });

  it('ex starsza niż okno → komunikat gaśnie (nie wisi w nieskończoność)', () => {
    // Bez tego filtra zdarzenie wisi bezterminowo — na produkcji CMCSA→VSNT
    // (ex 2026-01-05) sygnalizowało się nieprzerwanie od siedmiu miesięcy.
    pendingEvents.mockReturnValue([
      { parentTicker: 'SPGI', childTicker: 'MBGL', exDate: '2026-07-16', childName: null },
    ]);
    expect(getPendingRatioSpinOffs(PID, heldSpgi(), NOW)).toHaveLength(0);
  });

  it('portfel zna już zdarzenie (applied) → bez sygnalizacji, także po wygaśnięciu badge’a', () => {
    // SPGI→MBGL: rozliczone z mapy statycznej, ale w spinoff_events ratio dalej NULL.
    knownSpinOffs.mockReturnValue([knownRow()]);
    expect(getPendingRatioSpinOffs(PID, heldSpgi(), NOW)).toHaveLength(0);
  });

  it.each(['skipped_broker', 'reverted'] as const)(
    'wiersz o statusie %s też maskuje sygnalizację',
    (status) => {
      knownSpinOffs.mockReturnValue([knownRow({ status })]);
      expect(getPendingRatioSpinOffs(PID, heldSpgi(), NOW)).toHaveLength(0);
    },
  );

  it('inna konwencja ex-date (±kilka dni) nadal maskuje', () => {
    // Mapa: dzień dystrybucji; scraper: ostatnia sesja z prawem.
    knownSpinOffs.mockReturnValue([knownRow({ exDate: '2026-07-22' })]);
    expect(getPendingRatioSpinOffs(PID, heldSpgi(), NOW)).toHaveLength(0);
  });

  it('wiersz o tym samym rodzicu, ale INNYM zdarzeniu nie maskuje', () => {
    knownSpinOffs.mockReturnValue([knownRow({ exDate: '2025-03-10', childTicker: 'OLD' })]);
    expect(getPendingRatioSpinOffs(PID, heldSpgi(), NOW)).toHaveLength(1);
  });

  it('rodzic spoza portfela → bez sygnalizacji', () => {
    expect(getPendingRatioSpinOffs(PID, new Map(), NOW)).toHaveLength(0);
  });

  it('awaria serwisu zdarzeń → pusta lista, bez wyjątku', () => {
    pendingEvents.mockImplementation(() => {
      throw new Error('DB padła');
    });
    expect(getPendingRatioSpinOffs(PID, heldSpgi(), NOW)).toEqual([]);
  });
});
