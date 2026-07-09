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

// Dzienna seria {date, close}; segmenty [{to, close}] pozwalają zmieniać cenę w czasie.
function series(from: string, segments: Array<{ to: string; close: number }>) {
  const out: Array<{ date: string; close: number }> = [];
  const cur = new Date(from + 'T00:00:00Z');
  for (const seg of segments) {
    const end = new Date(seg.to + 'T00:00:00Z');
    while (cur <= end) {
      out.push({ date: cur.toISOString().slice(0, 10), close: seg.close });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
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
  };
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

async function twrLast(txs: Transaction[], ops: CashOperation[], priceTo = '2026-12-31') {
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

describe('computePortfolioHistory — TWR odporny na przepływy i wartość bliską zeru', () => {
  beforeEach(() => vi.clearAllMocks());

  it('duża wypłata przy płaskiej cenie NIE tworzy sztucznego zwrotu (twr ≈ 0)', async () => {
    // Cena płaska → zwrot cenowy 0%. Wypłata 6000 z 16000 (>30%, próg starego Modified Dietz).
    (yahoo.fetchYahooHistory as any).mockResolvedValue(
      series('2024-01-01', [{ to: '2026-12-31', close: 100 }]),
    );
    const history = await twrLast(
      [buy(100, 100, '2024-01-02')],
      [op('deposit', 16000, '2024-01-01'), op('withdrawal', -6000, '2024-02-01')],
    );
    const last = history[history.length - 1];
    // Stary Modified Dietz dawał tu fałszywy ~−23%; formuła standardowa → 0%.
    expect(Math.abs(last.twrPct)).toBeLessThan(0.5);
  });

  it('ZAMRAŻA TWR przy wartości <5% szczytu — brak eksplozji przy odbiciu z ~zera', async () => {
    // 100 → krach do 1 (wartość 100 = 0.6% szczytu 16000) → powrót do 100. Bez zamrożenia
    // dzień odbicia dawałby ratio ~100 → twr ~+9900%. Z zamrożeniem TWR zostaje sensowny.
    (yahoo.fetchYahooHistory as any).mockResolvedValue(
      series('2024-01-01', [
        { to: '2024-05-31', close: 100 },
        { to: '2024-06-30', close: 1 },
        { to: '2026-12-31', close: 100 },
      ]),
    );
    const history = await twrLast(
      [buy(100, 100, '2024-01-02')],
      [op('deposit', 16000, '2024-01-01')],
    );
    const maxTwr = Math.max(...history.map((h) => h.twrPct));
    const last = history[history.length - 1];
    expect(maxTwr).toBeLessThan(50); // brak eksplozji
    expect(Math.abs(last.twrPct)).toBeLessThan(50); // round-trip ceny → ~0, zamrożone bez artefaktu
  });
});
