import { describe, it, expect } from 'vitest';
import {
  applySpinOffs,
  parentSharesAtExDate,
  filterDetectedSplitsForSpinOffs,
} from '../spin-off-transform.js';
import {
  computePositionMetrics,
  computeClosedTrades,
  computeCashBalances,
} from '../portfolio-engine.js';
import { adjustTransactionsForSplits } from '../split-detector.js';
import type { Transaction, AppliedSpinOff, TickerMapEntry, DetectedSplit } from 'shared';

// ─── Helpers ───

const PARENT_ISIN = 'US78409V1044';
const CHILD_ISIN = 'AUTO_MBGL';

function makeTx(
  overrides: Partial<Transaction> & { side: 'K' | 'S'; quantity: number; price: number },
): Transaction {
  const value = overrides.quantity * overrides.price;
  return {
    date: '2026-01-15',
    paperName: 'SPGI',
    isin: PARENT_ISIN,
    currency: 'USD',
    value,
    commission: 0,
    total: value,
    source: 'manual',
    ...overrides,
  };
}

function makeSpinOff(overrides: Partial<AppliedSpinOff> = {}): AppliedSpinOff {
  return {
    parentIsin: PARENT_ISIN,
    parentTicker: 'SPGI',
    childIsin: CHILD_ISIN,
    childTicker: 'MBGL',
    childName: 'Mobility Global',
    exDate: '2026-07-01',
    ratio: 1,
    allocationPct: 0.2,
    childQty: 10,
    currency: 'USD',
    status: 'applied',
    source: 'map',
    ...overrides,
  };
}

function makeTickerMap(): Map<string, TickerMapEntry> {
  const map = new Map<string, TickerMapEntry>();
  for (const [isin, ticker] of [
    [PARENT_ISIN, 'SPGI'],
    [CHILD_ISIN, 'MBGL'],
  ] as const) {
    map.set(isin, {
      isin,
      ticker,
      name: ticker,
      exchange: 'NYSE',
      currency: 'USD',
      priceSource: 'yahoo',
    });
  }
  return map;
}

function costBasis(txs: Transaction[], isin: string): number {
  const metrics = computePositionMetrics(txs.filter((t) => t.isin === isin));
  return metrics.buyLots.reduce((s, l) => s + l.quantity * l.price, 0);
}

// ─── parentSharesAtExDate ───

describe('parentSharesAtExDate', () => {
  it('liczy FIFO: zakupy minus sprzedaże sprzed ex; transakcja Z ex-date nie wchodzi', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 100, date: '2026-01-10' }),
      makeTx({ side: 'S', quantity: 4, price: 120, date: '2026-03-01' }),
      makeTx({ side: 'K', quantity: 5, price: 110, date: '2026-07-01' }), // ex-date — bez prawa
    ];
    expect(parentSharesAtExDate(txs, PARENT_ISIN, '2026-07-01')).toBe(6);
  });

  it('pozycja krótka na ex nie daje prawa (0 akcji)', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 5, price: 100, date: '2026-01-10' }),
      makeTx({ side: 'S', quantity: 8, price: 120, date: '2026-03-01' }),
    ];
    expect(parentSharesAtExDate(txs, PARENT_ISIN, '2026-07-01')).toBe(0);
  });
});

// ─── applySpinOffs — inwarianty ───

describe('applySpinOffs — inwarianty', () => {
  it('basic 1:1 — redukcja kosztu rodzica + zakup dziecka, konserwacja kosztu co do centa', () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500, date: '2026-01-10' })];
    const out = applySpinOffs(txs, [makeSpinOff({ allocationPct: 0.08 })]);

    // Rodzic: qty bez zmian, cena ×0.92
    const parent = computePositionMetrics(out.filter((t) => t.isin === PARENT_ISIN));
    expect(parent.shares).toBe(10);
    expect(parent.buyLots[0].price).toBeCloseTo(460, 10);

    // Dziecko: 10 szt. na ex-date, koszt = 8% z 5000 = 400
    const child = out.find((t) => t.isin === CHILD_ISIN)!;
    expect(child).toBeDefined();
    expect(child.side).toBe('K');
    expect(child.date).toBe('2026-07-01');
    expect(child.quantity).toBeCloseTo(10, 10);
    expect(child.quantity * child.price).toBeCloseTo(400, 8);
    expect(child.syntheticOrigin).toContain('Spin-off');

    // Konserwacja: koszt rodzica po + koszt dziecka = koszt przed
    const before = costBasis(txs, PARENT_ISIN);
    const after = costBasis(out, PARENT_ISIN) + costBasis(out, CHILD_ISIN);
    expect(after).toBeCloseTo(before, 8);
  });

  it('cash-neutralność: computeCashBalances identyczne z i bez spin-offu', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 500, date: '2026-01-10' }),
      makeTx({ side: 'S', quantity: 3, price: 520, date: '2026-05-01' }),
    ];
    const out = applySpinOffs(txs, [makeSpinOff()]);
    expect(computeCashBalances(out, [])).toEqual(computeCashBalances(txs, []));
  });

  it('częściowa sprzedaż pre-ex: closed trades identyczne z i bez spin-offu, reszta z obniżonym kosztem', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 500, date: '2026-01-10', commission: 10 }),
      makeTx({ side: 'S', quantity: 4, price: 520, date: '2026-05-01', commission: 5 }),
    ];
    const spinOff = makeSpinOff({ allocationPct: 0.1 });
    const tickerMap = makeTickerMap();

    // Inwariant 4: sprzedaż sprzed ex rozlicza się po ORYGINALNEJ cenie zakupu
    const tradesWithout = computeClosedTrades(txs, tickerMap);
    const tradesWith = computeClosedTrades(applySpinOffs(txs, [spinOff]), tickerMap);
    expect(tradesWith).toHaveLength(tradesWithout.length);
    expect(tradesWith[0].profitLoss).toBeCloseTo(tradesWithout[0].profitLoss, 8);

    // Pozostałe 6 szt. rodzica ma cenę ×0.9; dziecko qty=6, koszt = 10% × 6 × 500
    const out = applySpinOffs(txs, [spinOff]);
    const parent = computePositionMetrics(out.filter((t) => t.isin === PARENT_ISIN));
    expect(parent.shares).toBeCloseTo(6, 10);
    expect(parent.buyLots.reduce((s, l) => s + l.quantity * l.price, 0)).toBeCloseTo(
      6 * 500 * 0.9,
      8,
    );
    const child = out.find((t) => t.isin === CHILD_ISIN)!;
    expect(child.quantity).toBeCloseTo(6, 10);
    expect(child.quantity * child.price).toBeCloseTo(6 * 500 * 0.1, 8);
  });

  it('rodzic w pełni sprzedany przed ex → no-op (brak dziecka, brak zmian)', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 500, date: '2026-01-10' }),
      makeTx({ side: 'S', quantity: 10, price: 520, date: '2026-05-01' }),
    ];
    const out = applySpinOffs(txs, [makeSpinOff()]);
    expect(out).toEqual(txs);
  });

  it('sprzedaż dziecka post-ex FIFO-uje z wstrzykniętym kosztem', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 500, date: '2026-01-10' }),
      // realna sprzedaż dziecka po ex (np. z późniejszego importu)
      makeTx({
        side: 'S',
        quantity: 10,
        price: 45,
        date: '2026-08-15',
        isin: CHILD_ISIN,
        paperName: 'MBGL',
      }),
    ];
    const out = applySpinOffs(txs, [makeSpinOff({ allocationPct: 0.08 })]);
    const trades = computeClosedTrades(out, makeTickerMap());
    const childTrade = trades.find((t) => t.isin === CHILD_ISIN)!;
    expect(childTrade).toBeDefined();
    // koszt lotu dziecka = 400 (8% z 5000) → profit = 450 - 400 = 50
    expect(childTrade.profitLoss).toBeCloseTo(50, 6);
  });

  it('zakupy rodzica PO ex-date nie są przeskalowane', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 10, price: 500, date: '2026-01-10' }),
      makeTx({ side: 'K', quantity: 5, price: 400, date: '2026-09-01' }),
    ];
    const out = applySpinOffs(txs, [makeSpinOff({ allocationPct: 0.2 })]);
    const postEx = out.find((t) => t.isin === PARENT_ISIN && t.date === '2026-09-01')!;
    expect(postEx.price).toBe(400);
    const child = out.find((t) => t.isin === CHILD_ISIN)!;
    expect(child.quantity).toBeCloseTo(10, 10); // tylko akcje z ex, nie 15
  });

  it('dwa spin-offy tego samego rodzica składają frakcje (1-f1)(1-f2)', () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500, date: '2026-01-10' })];
    const out = applySpinOffs(txs, [
      makeSpinOff({ allocationPct: 0.1, exDate: '2026-07-01' }),
      makeSpinOff({
        allocationPct: 0.2,
        exDate: '2026-10-01',
        childIsin: 'AUTO_OTHR',
        childTicker: 'OTHR',
      }),
    ]);
    const parent = computePositionMetrics(out.filter((t) => t.isin === PARENT_ISIN));
    expect(parent.buyLots[0].price).toBeCloseTo(500 * 0.9 * 0.8, 8);
    // Konserwacja całkowita
    const total =
      costBasis(out, PARENT_ISIN) + costBasis(out, CHILD_ISIN) + costBasis(out, 'AUTO_OTHR');
    expect(total).toBeCloseTo(5000, 8);
  });

  it('split rodzica PRZED ex — strumień skorygowany, ilość dziecka w skali post-split', () => {
    // Zakup 5 szt. @1000, split 2:1 w 2026-03-01 (→ 10 szt. @500), spin-off ex 2026-07-01
    const raw = [makeTx({ side: 'K', quantity: 5, price: 1000, date: '2026-01-10' })];
    const splits: DetectedSplit[] = [
      {
        isin: PARENT_ISIN,
        ticker: 'SPGI',
        date: '2026-03-01',
        ratio: 2,
        txPrice: 0,
        providerPrice: 0,
        source: 'manual',
      },
    ];
    const adjusted = adjustTransactionsForSplits(raw, splits);
    const out = applySpinOffs(adjusted, [makeSpinOff({ allocationPct: 0.1 })], splits);
    const child = out.find((t) => t.isin === CHILD_ISIN)!;
    expect(child.quantity).toBeCloseTo(10, 10); // realne akcje na ex = 10 (post-split)
  });

  it('split rodzica PO ex — ilość dziecka liczona od realnych akcji na ex', () => {
    // Zakup 10 szt. @500; spin-off ex 2026-07-01 (prawo od 10 szt.);
    // potem split rodzica 2:1 w 2026-09-01 → strumień pokazuje 20 szt. @250.
    const raw = [makeTx({ side: 'K', quantity: 10, price: 500, date: '2026-01-10' })];
    const splits: DetectedSplit[] = [
      {
        isin: PARENT_ISIN,
        ticker: 'SPGI',
        date: '2026-09-01',
        ratio: 2,
        txPrice: 0,
        providerPrice: 0,
        source: 'manual',
      },
    ];
    const adjusted = adjustTransactionsForSplits(raw, splits);
    const out = applySpinOffs(adjusted, [makeSpinOff({ allocationPct: 0.1 })], splits);
    const child = out.find((t) => t.isin === CHILD_ISIN)!;
    expect(child.quantity).toBeCloseTo(10, 10); // NIE 20 — prawo naliczone od 10 realnych
    // Konserwacja kosztu nadal trzyma się co do centa
    const total = costBasis(out, PARENT_ISIN) + costBasis(out, CHILD_ISIN);
    expect(total).toBeCloseTo(5000, 8);
  });

  it('split DZIECKA po ex skaluje wstrzykniętą transakcję', () => {
    const raw = [makeTx({ side: 'K', quantity: 10, price: 500, date: '2026-01-10' })];
    const splits: DetectedSplit[] = [
      {
        isin: CHILD_ISIN,
        ticker: 'MBGL',
        date: '2026-11-01',
        ratio: 4,
        txPrice: 0,
        providerPrice: 0,
        source: 'manual',
      },
    ];
    const out = applySpinOffs(raw, [makeSpinOff({ allocationPct: 0.08 })], splits);
    const child = out.find((t) => t.isin === CHILD_ISIN)!;
    expect(child.quantity).toBeCloseTo(40, 10);
    expect(child.quantity * child.price).toBeCloseTo(400, 8); // koszt niezmieniony
  });

  it('statusy reverted i skipped_broker są no-opami', () => {
    const txs = [makeTx({ side: 'K', quantity: 10, price: 500, date: '2026-01-10' })];
    expect(applySpinOffs(txs, [makeSpinOff({ status: 'reverted' })])).toEqual(txs);
    expect(applySpinOffs(txs, [makeSpinOff({ status: 'skipped_broker' })])).toEqual(txs);
  });

  it('loty w wielu walutach → osobne transakcje dziecka per waluta, suma kosztu zachowana', () => {
    const txs = [
      makeTx({ side: 'K', quantity: 6, price: 500, date: '2026-01-10', currency: 'USD' }),
      makeTx({ side: 'K', quantity: 4, price: 450, date: '2026-02-10', currency: 'EUR' }),
    ];
    const out = applySpinOffs(txs, [makeSpinOff({ allocationPct: 0.1 })]);
    const childTxs = out.filter((t) => t.isin === CHILD_ISIN);
    expect(childTxs).toHaveLength(2);
    const qtySum = childTxs.reduce((s, t) => s + t.quantity, 0);
    expect(qtySum).toBeCloseTo(10, 8);
    const usd = childTxs.find((t) => t.currency === 'USD')!;
    const eur = childTxs.find((t) => t.currency === 'EUR')!;
    expect(usd.quantity * usd.price).toBeCloseTo(0.1 * 6 * 500, 8);
    expect(eur.quantity * eur.price).toBeCloseTo(0.1 * 4 * 450, 8);
  });
});

// ─── Guard C ───

describe('filterDetectedSplitsForSpinOffs', () => {
  const guard = [
    { parentIsin: PARENT_ISIN, parentTicker: 'SPGI', childIsin: CHILD_ISIN, exDate: '2026-07-01' },
  ];

  function det(isin: string, date: string, ticker?: string) {
    return { isin, date, ratio: 2, ticker };
  }

  it('odrzuca detekcję price-based na rodzicu w oknie ±30 dni', () => {
    const inside = [det(PARENT_ISIN, '2026-07-15'), det(PARENT_ISIN, '2026-06-10')];
    expect(filterDetectedSplitsForSpinOffs(inside, guard, 'price')).toEqual([]);
  });

  it('zostawia detekcję na rodzicu poza oknem', () => {
    const outside = [det(PARENT_ISIN, '2026-09-15')];
    expect(filterDetectedSplitsForSpinOffs(outside, guard, 'price')).toEqual(outside);
  });

  it('quantity: odrzuca dziecko niezależnie od daty, price: zostawia dziecko', () => {
    const childDet = [det(CHILD_ISIN, '2027-03-01')];
    expect(filterDetectedSplitsForSpinOffs(childDet, guard, 'quantity')).toEqual([]);
    expect(filterDetectedSplitsForSpinOffs(childDet, guard, 'price')).toEqual(childDet);
  });

  it('obcy ISIN nietknięty; dopasowanie po tickerze gdy brak ISIN w guardzie', () => {
    const other = [det('US0000000001', '2026-07-02')];
    expect(filterDetectedSplitsForSpinOffs(other, guard, 'price')).toEqual(other);

    const tickerGuard = [{ parentTicker: 'SPGI', exDate: '2026-07-01' }];
    const byTicker = [det('COKOLWIEK', '2026-07-02', 'SPGI')];
    expect(filterDetectedSplitsForSpinOffs(byTicker, tickerGuard, 'price')).toEqual([]);
  });
});
