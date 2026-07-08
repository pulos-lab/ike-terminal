import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Transaction, TickerMapEntry, SpinOffMapEntry } from 'shared';

// DATA_DIR musi być ustawiony PRZED importem config/connection (czytane przy load)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-spinoffs-'));
process.env.DATA_DIR = tmpDir;

// ── Mocki sieci ──
const mockHistoryDirect = vi.fn<(ticker: string, date: string) => Promise<number | null>>();
const mockHistory =
  vi.fn<(ticker: string, start: string) => Promise<Array<{ date: string; close: number }>>>();
const mockYahooPrice = vi.fn();
const mockTickerName = vi.fn();

vi.mock('../yahoo-finance.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../yahoo-finance.js')>();
  return {
    ...orig,
    fetchYahooPrice: (...args: unknown[]) => mockYahooPrice(...args),
    fetchYahooHistoryDirect: (ticker: string, date: string) => mockHistoryDirect(ticker, date),
    // Fallback firstCloseAfter (dziecko debiutuje po ex) — bez mocka test
    // strzelałby w prawdziwe Yahoo i znajdował realne notowania.
    fetchYahooHistory: (ticker: string, start: string) => mockHistory(ticker, start),
  };
});
vi.mock('../ticker-search.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../ticker-search.js')>();
  return {
    ...orig,
    fetchYahooTickerName: (...args: unknown[]) => mockTickerName(...args),
  };
});

const PARENT_ISIN = 'US78409V1044';

const CANDIDATE: SpinOffMapEntry = {
  parentTicker: 'SPGI',
  parentIsin: PARENT_ISIN,
  childTicker: 'MBGL',
  childName: 'Mobility Global',
  exDate: '2026-07-01',
  ratio: 1,
};

function makeTx(
  overrides: Partial<Transaction> & { side: 'K' | 'S'; quantity: number; price: number },
): Transaction {
  const value = overrides.quantity * overrides.price;
  return {
    date: '2026-01-10',
    paperName: 'SPGI',
    isin: PARENT_ISIN,
    currency: 'USD',
    value,
    commission: 0,
    total: value,
    source: 'bossa',
    ...overrides,
  };
}

function makeTickerMap(): Map<string, TickerMapEntry> {
  return new Map([
    [
      PARENT_ISIN,
      {
        isin: PARENT_ISIN,
        ticker: 'SPGI',
        name: 'S&P Global',
        exchange: 'NYSE' as const,
        currency: 'USD',
        priceSource: 'yahoo' as const,
      },
    ],
  ]);
}

let applier: typeof import('../spin-offs-applier.js');
let repo: typeof import('../../db/spin-offs-repo.js');
let dataVersion: typeof import('../../db/data-version.js');
let connection: typeof import('../../db/connection.js');
let pidCounter = 0;
let pid: string;

beforeAll(async () => {
  applier = await import('../spin-offs-applier.js');
  repo = await import('../../db/spin-offs-repo.js');
  dataVersion = await import('../../db/data-version.js');
  connection = await import('../../db/connection.js');
});

afterAll(() => {
  connection.closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Świeży portfel per test — izolacja bez sprzątania wierszy
  pid = `test-spinoff-${++pidCounter}`;
  applier._resetSpinOffDeferrals();
  mockHistoryDirect.mockReset();
  mockHistory.mockReset();
  mockYahooPrice.mockReset();
  mockTickerName.mockReset();
  mockYahooPrice.mockResolvedValue({ price: 41, currency: 'USD' });
  mockTickerName.mockResolvedValue('Mobility Global Inc.');
  mockHistoryDirect.mockImplementation(async (ticker) => (ticker === 'SPGI' ? 455 : 41));
  mockHistory.mockResolvedValue([]);
});

describe('applyPendingSpinOffs', () => {
  it('aplikuje zdarzenie: frakcja z cen, zamrożony wiersz, ticker_map dziecka, bump wersji', async () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500 })];
    const versionBefore = dataVersion.getPortfolioDataVersion(pid);

    const { appliedNow } = await applier.applyPendingSpinOffs(
      pid,
      txs,
      makeTickerMap(),
      [],
      [CANDIDATE],
    );

    expect(appliedNow).toHaveLength(1);
    const rows = repo.getSpinOffs(pid);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('applied');
    expect(rows[0].childQty).toBeCloseTo(10, 8);
    // frac = (1×41)/(455 + 1×41) = 41/496
    expect(rows[0].allocationPct).toBeCloseTo(41 / 496, 8);
    expect(rows[0].parentPriceUsed).toBe(455);
    expect(rows[0].childPriceUsed).toBe(41);
    expect(rows[0].childIsin).toBe('AUTO_MBGL');
    expect(dataVersion.getPortfolioDataVersion(pid)).toBeGreaterThan(versionBefore);
  });

  it('idempotencja: drugie wywołanie nie tworzy wiersza ani nie bumpuje wersji', async () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500 })];
    await applier.applyPendingSpinOffs(pid, txs, makeTickerMap(), [], [CANDIDATE]);
    const versionAfterFirst = dataVersion.getPortfolioDataVersion(pid);

    const { appliedNow } = await applier.applyPendingSpinOffs(
      pid,
      txs,
      makeTickerMap(),
      [],
      [CANDIDATE],
    );
    expect(appliedNow).toHaveLength(0);
    expect(repo.getSpinOffs(pid)).toHaveLength(1);
    expect(dataVersion.getPortfolioDataVersion(pid)).toBe(versionAfterFirst);
  });

  it('costAllocPct z mapy pomija fetch cen historycznych', async () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500 })];
    await applier.applyPendingSpinOffs(
      pid,
      txs,
      makeTickerMap(),
      [],
      [{ ...CANDIDATE, costAllocPct: 0.15 }],
    );
    const rows = repo.getSpinOffs(pid);
    expect(rows[0].allocationPct).toBe(0.15);
    expect(mockHistoryDirect).not.toHaveBeenCalled();
  });

  it('defer przy braku ceny dziecka — brak wiersza; po pojawieniu się cen aplikuje', async () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500 })];
    mockHistoryDirect.mockImplementation(async (ticker) => (ticker === 'SPGI' ? 455 : null));

    await applier.applyPendingSpinOffs(pid, txs, makeTickerMap(), [], [CANDIDATE]);
    expect(repo.getSpinOffs(pid)).toHaveLength(0); // zero częściowych zapisów

    // Ceny się pojawiły (kolejny dzień) — reset backoffu symuluje upływ godziny
    mockHistoryDirect.mockImplementation(async (ticker) => (ticker === 'SPGI' ? 455 : 41));
    applier._resetSpinOffDeferrals();
    const { appliedNow } = await applier.applyPendingSpinOffs(
      pid,
      txs,
      makeTickerMap(),
      [],
      [CANDIDATE],
    );
    expect(appliedNow).toHaveLength(1);
  });

  it('dziecko debiutuje PO dniu ex (wzorzec GPW): frakcja z pierwszego notowania dziecka i kursu rodzica z tej samej sesji', async () => {
    // Syn2bio/Creotech Quantum: debiut ~2 tygodnie po ex — fetchYahooHistoryDirect
    // (okno 5 dni) nie widzi dziecka; fallback bierze pierwszy close ≤30 dni po ex
    // i kurs rodzica z TEGO SAMEGO dnia.
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500 })];
    mockHistoryDirect.mockImplementation(async (ticker, date) => {
      if (ticker !== 'SPGI') return null; // dziecko: brak notowań przy ex
      return date === '2026-07-15' ? 440 : 455; // rodzic: kurs w dniu debiutu dziecka vs ex
    });
    mockHistory.mockImplementation(async (ticker) =>
      ticker === 'MBGL' ? [{ date: '2026-07-15', close: 110 }] : [],
    );

    const { appliedNow } = await applier.applyPendingSpinOffs(
      pid,
      txs,
      makeTickerMap(),
      [],
      [CANDIDATE],
    );

    expect(appliedNow).toHaveLength(1);
    const row = repo.getSpinOffs(pid)[0];
    // frac = 110 / (440 + 110) = 0.2 — oba kursy z sesji debiutu (post-ex)
    expect(row.allocationPct).toBeCloseTo(0.2, 10);
    expect(row.parentPriceUsed).toBe(440);
    expect(row.childPriceUsed).toBe(110);
  });

  it('dziecko bez notowań w oknie 30 dni po ex → nadal defer (zero częściowych zapisów)', async () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500 })];
    mockHistoryDirect.mockImplementation(async (ticker) => (ticker === 'SPGI' ? 455 : null));
    mockHistory.mockImplementation(
      async (ticker) => (ticker === 'MBGL' ? [{ date: '2026-08-15', close: 110 }] : []), // 45 dni po ex
    );

    await applier.applyPendingSpinOffs(pid, txs, makeTickerMap(), [], [CANDIDATE]);
    expect(repo.getSpinOffs(pid)).toHaveLength(0);
  });

  it('backoff: po porażce kolejne wywołanie nie strzela do sieci przed upływem godziny', async () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500 })];
    mockHistoryDirect.mockImplementation(async () => null);
    await applier.applyPendingSpinOffs(pid, txs, makeTickerMap(), [], [CANDIDATE]);
    const callsAfterFirst = mockHistoryDirect.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await applier.applyPendingSpinOffs(pid, txs, makeTickerMap(), [], [CANDIDATE]);
    expect(mockHistoryDirect.mock.calls.length).toBe(callsAfterFirst); // bez nowych strzałów
  });

  it('tanie bramki: przyszły exDate / brak rodzica / rodzic sprzedany przed ex → nic', async () => {
    // przyszły exDate
    await applier.applyPendingSpinOffs(
      pid,
      [makeTx({ side: 'K', quantity: 10, price: 500 })],
      makeTickerMap(),
      [],
      [{ ...CANDIDATE, exDate: '2099-01-01' }],
    );
    // brak rodzica w tickerMap
    await applier.applyPendingSpinOffs(
      pid,
      [makeTx({ side: 'K', quantity: 10, price: 500 })],
      new Map(),
      [],
      [CANDIDATE],
    );
    // rodzic w pełni sprzedany przed ex
    await applier.applyPendingSpinOffs(
      pid,
      [
        makeTx({ side: 'K', quantity: 10, price: 500 }),
        makeTx({ side: 'S', quantity: 10, price: 520, date: '2026-05-01' }),
      ],
      makeTickerMap(),
      [],
      [CANDIDATE],
    );
    expect(repo.getSpinOffs(pid)).toHaveLength(0);
    expect(mockYahooPrice).not.toHaveBeenCalled();
  });

  it('dedup pre-apply: broker zaksięgował dziecko → skipped_broker bez syntetyka', async () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 500 }),
      // realne zaksięgowanie 10 szt. MBGL przez brokera dzień po ex
      makeTx({
        side: 'K',
        quantity: 10,
        price: 0,
        date: '2026-07-02',
        isin: 'AUTO_MBGL',
        paperName: 'MBGL',
      }),
    ];
    const { appliedNow } = await applier.applyPendingSpinOffs(
      pid,
      txs,
      makeTickerMap(),
      [],
      [CANDIDATE],
    );
    expect(appliedNow).toHaveLength(0);
    const rows = repo.getSpinOffs(pid);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped_broker');
    expect(rows[0].allocationPct).toBe(0);
    expect(mockHistoryDirect).not.toHaveBeenCalled(); // bez sieci
  });

  it('dedup post-apply: broker księguje dziecko PO aplikacji → flip na skipped_broker + bump', async () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500 })];
    await applier.applyPendingSpinOffs(pid, txs, makeTickerMap(), [], [CANDIDATE]);
    expect(repo.getSpinOffs(pid)[0].status).toBe('applied');
    const versionAfterApply = dataVersion.getPortfolioDataVersion(pid);

    // Kolejny import dokłada realne wiersze dziecka
    const txsWithBroker = [
      ...txs,
      makeTx({
        side: 'K',
        quantity: 10,
        price: 0,
        date: '2026-07-02',
        isin: 'AUTO_MBGL',
        paperName: 'MBGL',
      }),
    ];
    await applier.applyPendingSpinOffs(pid, txsWithBroker, makeTickerMap(), [], [CANDIDATE]);
    const rows = repo.getSpinOffs(pid);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped_broker');
    expect(dataVersion.getPortfolioDataVersion(pid)).toBeGreaterThan(versionAfterApply);
  });

  it('tombstone: wiersz reverted blokuje ponowną auto-aplikację', async () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500 })];
    await applier.applyPendingSpinOffs(pid, txs, makeTickerMap(), [], [CANDIDATE]);
    const row = repo.getSpinOffs(pid)[0];
    repo.updateSpinOffStatus(pid, row.id!, 'reverted');

    const { appliedNow } = await applier.applyPendingSpinOffs(
      pid,
      txs,
      makeTickerMap(),
      [],
      [CANDIDATE],
    );
    expect(appliedNow).toHaveLength(0);
    expect(repo.getSpinOffs(pid)).toHaveLength(1);
    expect(repo.getSpinOffs(pid)[0].status).toBe('reverted');
  });

  it('frakcja poza clamp (podejrzane ceny) → defer, brak wiersza', async () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500 })];
    // dziecko "warte" 50× rodzica → frac ≈ 0.98 > 0.9
    mockHistoryDirect.mockImplementation(async (ticker) => (ticker === 'SPGI' ? 1 : 50));
    await applier.applyPendingSpinOffs(pid, txs, makeTickerMap(), [], [CANDIDATE]);
    expect(repo.getSpinOffs(pid)).toHaveLength(0);
  });
});
