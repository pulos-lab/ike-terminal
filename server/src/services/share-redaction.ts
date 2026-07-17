import type {
  PortfolioHistoryResponse,
  PortfolioPositionsResponse,
  PortfolioHistoryPoint,
  Position,
  PublicHistoryResponse,
  PublicPosition,
  PublicPositionsResponse,
  PublicShareMetrics,
} from 'shared';

/**
 * Redakcja danych dla publicznego widoku share — wszystko po stronie serwera,
 * ukryte wartości nigdy nie opuszczają backendu.
 *
 * Kwoty w historii NIE są zerowane, tylko normalizowane: każda seria absolutna
 * jest mnożona przez wspólną stałą k. Statystyki na kliencie (Sharpe, volatility
 * w PerformanceStats) liczą dzienne zwroty wzorem (V_t − V_{t−1} − CF_t) / V_{t−1},
 * który jest niezmienniczy względem skali — działają więc bez modyfikacji,
 * a realne kwoty są nieodtwarzalne.
 */

const NORMALIZED_LAST_VALUE = 1000;

function scaleHistory(history: PortfolioHistoryPoint[]): PortfolioHistoryPoint[] {
  const lastNonZero = [...history].reverse().find((p) => p.portfolioValue > 0);
  const k = lastNonZero ? NORMALIZED_LAST_VALUE / lastNonZero.portfolioValue : 1;
  return history.map((p) => ({
    date: p.date,
    portfolioValue: p.portfolioValue * k,
    returnPct: p.returnPct,
    twrPct: p.twrPct,
    benchmarkValue: p.benchmarkValue * k,
    benchmarkReturnPct: p.benchmarkReturnPct,
    benchmarkTwrPct: p.benchmarkTwrPct,
    investedCumulative: p.investedCumulative * k,
    cumulativeDepositsPln: p.cumulativeDepositsPln * k,
    cumulativeWithdrawalsPln: p.cumulativeWithdrawalsPln * k,
  }));
}

export function toPublicHistory(
  view: PortfolioHistoryResponse,
  showAmounts: boolean,
): PublicHistoryResponse {
  const metrics: PublicShareMetrics = {
    xirr: view.metrics.xirr,
    totalReturnPct: view.metrics.totalReturnPct,
    currentValue: showAmounts ? view.metrics.currentValue : null,
    totalInvested: showAmounts ? view.metrics.totalInvested : null,
    totalReturn: showAmounts ? view.metrics.totalReturn : null,
    totalDividends: showAmounts ? view.metrics.totalDividends : null,
  };
  return {
    history: showAmounts ? view.history : scaleHistory(view.history),
    metrics,
    baseCurrency: view.baseCurrency,
    // Rynkowa stopa (UST 1Y) — nie jest daną portfela, przechodzi bez redakcji.
    riskFreeRatePct: view.riskFreeRatePct,
  };
}

/** Whitelist mapper — nowe pole dodane do Position domyślnie NIE wycieka. */
function toPublicPosition(pos: Position, showAmounts: boolean): PublicPosition {
  const pub: PublicPosition = {
    isin: pos.isin,
    ticker: pos.ticker,
    paperName: pos.paperName,
    currency: pos.currency,
    currentPrice: pos.currentPrice,
    dailyChangePct: pos.dailyChangePct,
    profitLossPct: pos.profitLossPct,
    weight: pos.weight,
    exchange: pos.exchange,
    sector: pos.sector,
    supersector: pos.supersector,
    category: pos.category,
    priceManual: pos.priceManual,
  };
  if (showAmounts) {
    pub.shares = pos.shares;
    pub.avgBuyPrice = pos.avgBuyPrice;
    pub.currentValue = pos.currentValue;
    pub.currentValuePln = pos.currentValuePln;
    pub.profitLoss = pos.profitLoss;
    pub.profitLossPln = pos.profitLossPln;
  }
  return pub;
}

export function toPublicPositions(
  view: PortfolioPositionsResponse,
  showAmounts: boolean,
): PublicPositionsResponse {
  const result: PublicPositionsResponse = {
    positions: view.positions.map((p) => toPublicPosition(p, showAmounts)),
    cashPositions: view.cashPositions.map((cp) =>
      showAmounts
        ? { currency: cp.currency, weight: cp.weight, balance: cp.balance, valuePln: cp.valuePln }
        : { currency: cp.currency, weight: cp.weight },
    ),
    baseCurrency: view.baseCurrency,
  };
  if (showAmounts) {
    result.totalValuePln = view.totalValuePln;
    result.stocksValuePln = view.stocksValuePln;
    result.cashValuePln = view.cashValuePln;
  }
  return result;
}
