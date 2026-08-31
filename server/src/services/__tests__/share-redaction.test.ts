import { describe, it, expect } from 'vitest';
import type { PortfolioHistoryPoint, PortfolioHistoryResponse, Position } from 'shared';
import { toPublicHistory, toPublicPositions } from '../share-redaction.js';

function point(overrides: Partial<PortfolioHistoryPoint>): PortfolioHistoryPoint {
  return {
    date: '2025-01-01',
    portfolioValue: 0,
    returnPct: 0,
    twrPct: 0,
    benchmarkValue: 0,
    benchmarkReturnPct: 0,
    benchmarkTwrPct: 0,
    investedCumulative: 0,
    cumulativeDepositsPln: 0,
    cumulativeWithdrawalsPln: 0,
    ...overrides,
  };
}

const HISTORY: PortfolioHistoryPoint[] = [
  point({ date: '2025-01-01', portfolioValue: 10000, investedCumulative: 10000, returnPct: 0 }),
  point({
    date: '2025-01-02',
    portfolioValue: 10500,
    investedCumulative: 10000,
    returnPct: 5,
    benchmarkValue: 4000,
  }),
  point({
    date: '2025-01-03',
    portfolioValue: 13000,
    investedCumulative: 12000, // wpłata 2000
    returnPct: 9.8,
    benchmarkValue: 4100,
    cumulativeDepositsPln: 12000,
  }),
];

const RESPONSE: PortfolioHistoryResponse = {
  history: HISTORY,
  metrics: {
    currentValue: 13000,
    totalInvested: 12000,
    xirr: 12.5,
    totalReturn: 1000,
    totalReturnPct: 9.8,
    totalDividends: 150,
    totalCapitalReturn: 0,
  },
  baseCurrency: 'PLN',
};

/** Dzienne zwroty wzorem z PerformanceStats: (V_t − V_{t−1} − CF_t) / V_{t−1}. */
function dailyReturns(history: PortfolioHistoryPoint[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].portfolioValue;
    if (prev > 0) {
      const cf = history[i].investedCumulative - history[i - 1].investedCumulative;
      out.push((history[i].portfolioValue - prev - cf) / prev);
    }
  }
  return out;
}

describe('toPublicHistory', () => {
  it('showAmounts=true: przekazuje wszystko bez zmian', () => {
    const pub = toPublicHistory(RESPONSE, true);
    expect(pub.history).toEqual(HISTORY);
    expect(pub.metrics.currentValue).toBe(13000);
    expect(pub.metrics.totalInvested).toBe(12000);
  });

  it('unpricedInstruments (nazwy papierów właściciela) nie wycieka do widoku publicznego', () => {
    const withUnpriced = {
      ...RESPONSE,
      unpricedInstruments: [
        {
          isin: 'BRIJU',
          name: 'BRIJU',
          firstHeld: '2017-03-15',
          lastHeld: '2017-09-15',
          mode: 'tx-price-fallback' as const,
        },
      ],
    };
    for (const showAmounts of [true, false]) {
      expect(toPublicHistory(withUnpriced, showAmounts)).not.toHaveProperty('unpricedInstruments');
    }
  });

  it('showAmounts=false: normalizuje kwoty (ostatnia wartość = 1000), % nietknięte', () => {
    const pub = toPublicHistory(RESPONSE, false);
    const last = pub.history[pub.history.length - 1];
    expect(last.portfolioValue).toBeCloseTo(1000);
    expect(last.returnPct).toBe(9.8);
    expect(pub.history[1].returnPct).toBe(5);
    // skala k jest wspólna dla wszystkich serii
    const k = 1000 / 13000;
    expect(pub.history[0].portfolioValue).toBeCloseTo(10000 * k);
    expect(last.investedCumulative).toBeCloseTo(12000 * k);
    expect(last.benchmarkValue).toBeCloseTo(4100 * k);
    expect(last.cumulativeDepositsPln).toBeCloseTo(12000 * k);
  });

  it('showAmounts=false: dzienne zwroty (Sharpe/volatility) identyczne przed i po skalowaniu', () => {
    const pub = toPublicHistory(RESPONSE, false);
    const original = dailyReturns(HISTORY);
    const scaled = dailyReturns(pub.history);
    expect(scaled.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(scaled[i]).toBeCloseTo(original[i], 12);
    }
  });

  it('showAmounts=false: metryki kwotowe znullowane, procentowe zostają', () => {
    const pub = toPublicHistory(RESPONSE, false);
    expect(pub.metrics.currentValue).toBeNull();
    expect(pub.metrics.totalInvested).toBeNull();
    expect(pub.metrics.totalReturn).toBeNull();
    expect(pub.metrics.totalDividends).toBeNull();
    expect(pub.metrics.xirr).toBe(12.5);
    expect(pub.metrics.totalReturnPct).toBe(9.8);
  });

  it('pusta historia / same zera nie wybucha', () => {
    const empty = toPublicHistory({ ...RESPONSE, history: [] }, false);
    expect(empty.history).toEqual([]);
    const zeros = toPublicHistory({ ...RESPONSE, history: [point({ portfolioValue: 0 })] }, false);
    expect(zeros.history[0].portfolioValue).toBe(0);
  });
});

describe('toPublicPositions', () => {
  const POSITION: Position = {
    paperName: 'CD Projekt',
    isin: 'PLOPTTC00011',
    ticker: 'CDR.WA',
    shares: 10,
    avgBuyPrice: 100,
    totalCommission: 3.9,
    currentPrice: 150,
    currentValue: 1500,
    currentValuePln: 1500,
    profitLoss: 500,
    profitLossPln: 500,
    profitLossPct: 50,
    currency: 'PLN',
    weight: 60,
    sector: 'Gry',
    supersector: 'Technologie',
    dailyChangePct: 1.2,
    category: 'stock',
    buyLots: [{ shares: 10, price: 100, commission: 3.9, date: '2024-01-01', currency: 'PLN' }],
    priceManual: false,
  };
  const VIEW = {
    positions: [POSITION],
    cashPositions: [{ currency: 'PLN', balance: 1000, valuePln: 1000, weight: 40 }],
    totalValuePln: 2500,
    stocksValuePln: 1500,
    cashValuePln: 1000,
    recentSplits: [{ isin: 'X', ticker: 'X', date: '2025-01-01', ratio: 2 }],
    upcomingEarnings: [
      {
        isin: 'PLOPTTC00011',
        ticker: 'CDR.WA',
        reportDate: '2026-08-05',
        daysUntil: 4,
        confidence: 'confirmed' as const,
        session: null,
        fiscalLabel: 'I półrocze 2026',
        reportKind: 'semiannual' as const,
        source: 'bankier' as const,
      },
    ],
    baseCurrency: 'PLN',
  };

  it('showAmounts=false: whitelist — bez ilości, kwot, lotów i sum', () => {
    const pub = toPublicPositions(VIEW, false);
    const p = pub.positions[0] as Record<string, unknown>;
    expect(p.ticker).toBe('CDR.WA');
    expect(p.profitLossPct).toBe(50);
    expect(p.weight).toBe(60);
    expect(p.currentPrice).toBe(150); // publiczne dane rynkowe
    expect(p).not.toHaveProperty('shares');
    expect(p).not.toHaveProperty('avgBuyPrice');
    expect(p).not.toHaveProperty('currentValue');
    expect(p).not.toHaveProperty('currentValuePln');
    expect(p).not.toHaveProperty('profitLoss');
    expect(p).not.toHaveProperty('profitLossPln');
    expect(p).not.toHaveProperty('buyLots');
    expect(p).not.toHaveProperty('totalCommission');
    expect(pub.cashPositions[0]).toEqual({ currency: 'PLN', weight: 40 });
    expect(pub).not.toHaveProperty('totalValuePln');
    expect(pub).not.toHaveProperty('recentSplits');
    expect(pub).not.toHaveProperty('upcomingEarnings');
  });

  it('kalendarz wyników nie wycieka do widoku publicznego', () => {
    // Terminarz sam w sobie jest informacją publiczną, ale ZESTAW spółek z terminami
    // zdradzałby skład portfela także wtedy, gdy właściciel ukrył kwoty.
    for (const showAmounts of [false, true]) {
      expect(toPublicPositions(VIEW, showAmounts)).not.toHaveProperty('upcomingEarnings');
    }
  });

  it('showAmounts=true: kwoty obecne, ale buyLots/recentSplits nadal ukryte', () => {
    const pub = toPublicPositions(VIEW, true);
    const p = pub.positions[0] as Record<string, unknown>;
    expect(p.shares).toBe(10);
    expect(p.currentValuePln).toBe(1500);
    expect(p).not.toHaveProperty('buyLots');
    expect(p).not.toHaveProperty('totalCommission');
    expect(pub.totalValuePln).toBe(2500);
    expect(pub.cashPositions[0].balance).toBe(1000);
    expect(pub).not.toHaveProperty('recentSplits');
  });
});
