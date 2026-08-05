import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  computePortfolioHistoryMemoized,
  clearHistoryMemo,
  getHistoryMemoSize,
} from '../history-memo.js';
import { bumpPortfolioDataVersion } from '../../db/data-version.js';
import type { computePortfolioHistory } from '../portfolio-engine.js';
import type { TickerMapEntry } from 'shared';

type ComputeFn = typeof computePortfolioHistory;
type HistoryResult = Awaited<ReturnType<ComputeFn>>;

/** Stub wyniku silnika — memo nie zagląda do środka, więc minimalny kształt wystarcza. */
function makeResult(): HistoryResult {
  return {
    history: [],
    metrics: {
      totalInvested: 0,
      currentValue: 0,
      totalReturn: 0,
      totalReturnPct: 0,
      xirr: 0,
      totalDividends: 0,
    },
    detectedSplits: [],
    dailyFxRates: new Map(),
  } as unknown as HistoryResult;
}

/** Licznik wywołań compute fn — wstrzykiwany do memoized wrappera. */
function makeComputeSpy(impl?: () => Promise<HistoryResult>) {
  return vi.fn(impl ?? (async () => makeResult())) as unknown as ComputeFn & {
    mock: { calls: unknown[][] };
  };
}

const emptyTickerMap = new Map<string, TickerMapEntry>();

let pidCounter = 0;
/** Świeży portfolioId per test — liczniki wersji w data-version są procesowe. */
function freshPid(): string {
  return `memo-test-${++pidCounter}`;
}

describe('computePortfolioHistoryMemoized', () => {
  beforeEach(() => {
    clearHistoryMemo();
  });

  function call(pid: string, computeFn: ComputeFn, benchmark = '^GSPC') {
    return computePortfolioHistoryMemoized(
      pid,
      [],
      [],
      emptyTickerMap,
      benchmark,
      'yahoo',
      [],
      'PLN',
      computeFn,
    );
  }

  it('drugi call z tymi samymi wejściami zwraca wynik z cache (1 przeliczenie)', async () => {
    const pid = freshPid();
    const compute = makeComputeSpy();

    const first = await call(pid, compute);
    const second = await call(pid, compute);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // identyczna referencja — wynik z cache
  });

  it('bump wersji danych portfela wymusza przeliczenie', async () => {
    const pid = freshPid();
    const compute = makeComputeSpy();

    await call(pid, compute);
    bumpPortfolioDataVersion(pid);
    await call(pid, compute);

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('bump innego portfela NIE unieważnia cache', async () => {
    const pid = freshPid();
    const otherPid = freshPid();
    const compute = makeComputeSpy();

    await call(pid, compute);
    bumpPortfolioDataVersion(otherPid);
    await call(pid, compute);

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('inny benchmark to osobny wpis cache', async () => {
    const pid = freshPid();
    const compute = makeComputeSpy();

    await call(pid, compute, '^GSPC');
    await call(pid, compute, 'WIG');
    await call(pid, compute, '^GSPC'); // hit
    await call(pid, compute, 'WIG'); // hit

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('równoległe requesty współdzielą jedno przeliczenie w locie', async () => {
    const pid = freshPid();
    const compute = makeComputeSpy();

    const [a, b] = await Promise.all([call(pid, compute), call(pid, compute)]);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it('odrzucony Promise nie jest cache-owany — kolejny call próbuje od nowa', async () => {
    const pid = freshPid();
    let failFirst = true;
    const compute = makeComputeSpy(async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error('Yahoo down');
      }
      return makeResult();
    });

    await expect(call(pid, compute)).rejects.toThrow('Yahoo down');
    await expect(call(pid, compute)).resolves.toBeDefined();
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('cache ma ograniczoną pojemność — najstarsze wpisy są usuwane (LRU-ish)', async () => {
    const pid = freshPid();
    const compute = makeComputeSpy();

    // Wypchnij pierwszy wpis poza limit (MAX_MEMO_ENTRIES = 24)
    for (let i = 0; i < 25; i++) {
      await call(pid, compute, `BENCH_${i}`);
    }
    expect(compute).toHaveBeenCalledTimes(25);

    // BENCH_0 wyleciał z cache → recompute; BENCH_24 wciąż jest → hit
    await call(pid, compute, 'BENCH_0');
    expect(compute).toHaveBeenCalledTimes(26);
    await call(pid, compute, 'BENCH_24');
    expect(compute).toHaveBeenCalledTimes(26);
  });

  it('wpisy z poprzedniego dnia są usuwane, a nie zajmują slotów LRU', async () => {
    const pid = freshPid();
    const compute = makeComputeSpy();

    // Wpisy „wczorajsze": klucz zawiera dzień kalendarzowy, więc podmiana zegara
    // na wczoraj tworzy wpisy, których nikt już nie odczyta.
    const realNow = Date.now;
    const yesterday = realNow() - 86_400_000;
    Date.now = () => yesterday;
    vi.setSystemTime(new Date(yesterday));
    for (let i = 0; i < 5; i++) await call(pid, compute, `OLD_${i}`);
    expect(compute).toHaveBeenCalledTimes(5);

    // Powrót do dziś — pierwszy zapis czyści wczorajszy balast.
    vi.useRealTimers();
    Date.now = realNow;
    await call(pid, compute, 'TODAY');
    expect(compute).toHaveBeenCalledTimes(6);
    expect(getHistoryMemoSize()).toBe(1);
  });
});
