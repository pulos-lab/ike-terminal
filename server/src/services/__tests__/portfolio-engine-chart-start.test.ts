/**
 * #165 — wykres „All" nie pokazywał pełnej historii.
 *
 * Pętla dzienna w computePortfolioHistory bramkowała start serii na pierwszej
 * operacji typu `deposit`. Portfel, w którym pierwsza pozycja (kupno albo
 * przeniesienie papierów in-kind) wyprzedza pierwszą zaksięgowaną wpłatę, tracił
 * wcześniejsze lata — oś wykresu startowała za późno. Fix: bramkować na pierwszej
 * AKTYWNOŚCI (wpłata LUB zmiana pozycji).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Transaction, CashOperation, TickerMapEntry } from 'shared';

vi.mock('../stooq.js', () => ({
  fetchStooqPrice: vi.fn().mockResolvedValue(null),
  fetchStooqPreviousClose: vi.fn().mockResolvedValue(null),
  fetchStooqHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../yahoo-finance.js', () => ({
  fetchYahooPrice: vi.fn().mockResolvedValue(null),
  fetchFxRate: vi.fn().mockResolvedValue(null),
  fetchYahooHistory: vi.fn(),
  fetchYahooHistoryDirect: vi.fn().mockResolvedValue(null),
  fetchYahooSplitEvents: vi.fn().mockResolvedValue([]),
}));

import { computePortfolioHistory } from '../portfolio-engine.js';
import * as yahoo from '../yahoo-finance.js';

function series(from: string, to: string, close: number) {
  const out: Array<{ date: string; close: number }> = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    out.push({ date: cur.toISOString().slice(0, 10), close });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

const XYZ: TickerMapEntry = {
  isin: 'PL_XYZ',
  ticker: 'XYZ',
  name: 'XYZ',
  exchange: 'OTHER',
  currency: 'PLN',
  priceSource: 'yahoo',
};
const tickerMap = new Map([['PL_XYZ', XYZ]]);

function buy(qty: number, price: number, date: string): Transaction {
  return {
    date: date + 'T10:00:00',
    paperName: 'XYZ',
    isin: 'PL_XYZ',
    quantity: qty,
    side: 'K',
    price,
    value: qty * price,
    commission: 0,
    total: qty * price,
    currency: 'PLN',
    paymentCurrency: 'PLN',
    category: 'stock',
    source: 'ibkr',
  } as Transaction;
}

function op(type: CashOperation['operationType'], amount: number, date: string): CashOperation {
  return {
    date: date + 'T00:00:00',
    operationType: type,
    description: '',
    amount,
    currency: 'PLN',
  } as CashOperation;
}

async function run(txs: Transaction[], ops: CashOperation[]) {
  const { history } = await computePortfolioHistory(
    txs,
    ops,
    tickerMap,
    '',
    'none',
    undefined,
    undefined,
    [],
    'PLN',
    [],
    undefined,
  );
  return history;
}

describe('computePortfolioHistory — start wykresu (#165)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('kupno przed pierwszą wpłatą → historia startuje od kupna, nie od wpłaty', async () => {
    (yahoo.fetchYahooHistory as any).mockResolvedValue(series('2019-01-01', '2026-12-31', 100));

    const history = await run([buy(10, 100, '2019-06-03')], [op('deposit', 5000, '2021-01-04')]);

    // Przed fixem history[0].date byłoby '2021-01-04' (pierwsza wpłata).
    expect(history[0].date).toBe('2019-06-03');
    // Wcześniej ucinane lata są teraz w serii.
    expect(history.some((h) => h.date.startsWith('2020'))).toBe(true);
    // Żaden punkt nie jest NaN (okres z pozycją, ale bez bazy wpłat → returnPct/twrPct = 0).
    expect(
      history.every(
        (h) =>
          Number.isFinite(h.portfolioValue) &&
          Number.isFinite(h.returnPct) &&
          Number.isFinite(h.twrPct),
      ),
    ).toBe(true);
  });

  it('regresja: normalne konto (wpłata przed kupnem) startuje od wpłaty', async () => {
    (yahoo.fetchYahooHistory as any).mockResolvedValue(series('2024-01-01', '2026-12-31', 100));

    const history = await run([buy(10, 100, '2024-01-05')], [op('deposit', 5000, '2024-01-02')]);

    // Wpłata jest pierwszą aktywnością → start bez zmian względem zachowania sprzed fixu.
    expect(history[0].date).toBe('2024-01-02');
  });
});
