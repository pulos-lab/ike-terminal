import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PortfolioPositionsResponse } from 'shared';
import {
  buildPositionsViewMemoized,
  clearPositionsMemo,
  getPositionsMemoSize,
} from '../positions-memo.js';
import { bumpPortfolioDataVersion } from '../../db/data-version.js';

/** Minimalna odpowiedź — memo nie zagląda do środka poza polem `quotes`. */
function makeView(nextRefreshInMs: number): PortfolioPositionsResponse {
  return {
    positions: [],
    cashPositions: [],
    totalValuePln: 0,
    stocksValuePln: 0,
    cashValuePln: 0,
    recentSplits: [],
    recentSpinOffs: [],
    pendingRatioSpinOffs: [],
    upcomingEarnings: [],
    baseCurrency: 'PLN',
    quotes: {
      asOf: new Date().toISOString(),
      nextRefreshAt: new Date(Date.now() + nextRefreshInMs).toISOString(),
      marketOpen: true,
    },
  } as PortfolioPositionsResponse;
}

let pidCounter = 0;
function freshPid(): string {
  return `positions-memo-${++pidCounter}`;
}

beforeEach(() => {
  clearPositionsMemo();
  vi.useRealTimers();
});

describe('positions-memo', () => {
  it('drugie wywołanie w oknie TTL nie przelicza', async () => {
    const pid = freshPid();
    const build = vi.fn(async () => makeView(15 * 60_000));

    await buildPositionsViewMemoized(pid, build as never);
    await buildPositionsViewMemoized(pid, build as never);

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('równoległe requesty współdzielą jedno przeliczenie', async () => {
    const pid = freshPid();
    const build = vi.fn(async () => makeView(15 * 60_000));

    await Promise.all([
      buildPositionsViewMemoized(pid, build as never),
      buildPositionsViewMemoized(pid, build as never),
      buildPositionsViewMemoized(pid, build as never),
    ]);

    expect(build).toHaveBeenCalledTimes(1);
  });

  it('po wygaśnięciu TTL przelicza ponownie', async () => {
    const pid = freshPid();
    // TTL z odpowiedzi już minął → wpis jest martwy zaraz po zapisaniu.
    const build = vi.fn(async () => makeView(-1000));

    await buildPositionsViewMemoized(pid, build as never);
    await buildPositionsViewMemoized(pid, build as never);

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('zapis danych (bump dataVersion) unieważnia natychmiast, bez czekania na TTL', async () => {
    const pid = freshPid();
    const build = vi.fn(async () => makeView(60 * 60_000));

    await buildPositionsViewMemoized(pid, build as never);
    bumpPortfolioDataVersion(pid);
    await buildPositionsViewMemoized(pid, build as never);

    expect(build).toHaveBeenCalledTimes(2);
  });

  it('inny portfel to osobny wpis — bez wzajemnego unieważniania', async () => {
    const a = freshPid();
    const b = freshPid();
    const build = vi.fn(async () => makeView(15 * 60_000));

    await buildPositionsViewMemoized(a, build as never);
    await buildPositionsViewMemoized(b, build as never);
    await buildPositionsViewMemoized(a, build as never);

    expect(build).toHaveBeenCalledTimes(2);
    expect(getPositionsMemoSize()).toBe(2);
  });

  it('odrzucony Promise nie jest cache’owany', async () => {
    const pid = freshPid();
    let failFirst = true;
    const build = vi.fn(async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error('Yahoo down');
      }
      return makeView(15 * 60_000);
    });

    await expect(buildPositionsViewMemoized(pid, build as never)).rejects.toThrow('Yahoo down');
    await expect(buildPositionsViewMemoized(pid, build as never)).resolves.toBeDefined();
    expect(build).toHaveBeenCalledTimes(2);
  });
});
