import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AppliedSpinOff } from 'shared';

// DATA_DIR przed importem modułu (portfolio-views ciągnie łańcuch db/config)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-views-'));
process.env.DATA_DIR = tmpDir;

const { selectRecentSpinOffs } = await import('../portfolio-views.js');

function spinOff(overrides: Partial<AppliedSpinOff> = {}): AppliedSpinOff {
  return {
    parentIsin: 'SNT.WA',
    parentTicker: 'SNT.WA',
    childIsin: 'PLSNBIO00013',
    childTicker: 'S2B.WA',
    exDate: '2026-04-02',
    ratio: 1,
    allocationPct: 0.107,
    childQty: 6,
    currency: 'PLN',
    status: 'applied',
    source: 'map',
    ...overrides,
  };
}

const NOW = new Date('2026-07-08T12:00:00Z');

describe('selectRecentSpinOffs — okno badge’a', () => {
  it('stare ex + ŚWIEŻE zastosowanie → badge widoczny (wpis do mapy po miesiącach)', () => {
    // Scenariusz Syn2bio: ex 2026-04-02, zdarzenie dodane do mapy i zastosowane
    // 2026-07-08 — pozycja dziecka właśnie pojawiła się użytkownikowi.
    const rows = selectRecentSpinOffs([spinOff({ appliedAt: '2026-07-08 09:00:00' })], NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].childIsin).toBe('PLSNBIO00013');
  });

  it('świeże ex bez appliedAt → badge widoczny (okno od ex jak dotąd)', () => {
    const rows = selectRecentSpinOffs(
      [spinOff({ exDate: '2026-07-01', appliedAt: undefined })],
      NOW,
    );
    expect(rows).toHaveLength(1);
  });

  it('stare ex + stare zastosowanie → bez badge’a', () => {
    const rows = selectRecentSpinOffs([spinOff({ appliedAt: '2026-04-03 09:00:00' })], NOW);
    expect(rows).toHaveLength(0);
  });

  it('status ≠ applied nigdy nie daje badge’a', () => {
    const rows = selectRecentSpinOffs(
      [
        spinOff({ status: 'reverted', appliedAt: '2026-07-08 09:00:00' }),
        spinOff({ status: 'skipped_broker', appliedAt: '2026-07-08 09:00:00' }),
      ],
      NOW,
    );
    expect(rows).toHaveLength(0);
  });
});
