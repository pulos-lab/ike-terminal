import type { QueryClient } from '@tanstack/react-query';

export const QUERY_KEYS = {
  positions: ['portfolio', 'positions'] as const,
  transactions: ['portfolio', 'transactions'] as const,
  closedTrades: ['portfolio', 'closed-trades'] as const,
  metrics: ['portfolio', 'metrics'] as const,
  history: ['portfolio', 'history'] as const,
  dividends: ['portfolio', 'dividends'] as const,
  upcomingDividends: ['portfolio', 'dividends', 'upcoming'] as const,
  deposits: ['portfolio', 'deposits'] as const,
  cashFlow: ['portfolio', 'cash-flow'] as const,
  fxHistory: ['portfolio', 'fx-history'] as const,
  fees: ['portfolio', 'fees'] as const,
  splits: ['portfolio', 'splits'] as const,
  corporateActions: ['portfolio', 'corporate-actions'] as const,
  additionalCosts: ['portfolio', 'additional-costs'] as const,
  livePrices: ['prices', 'live'] as const,
  importStatus: ['import', 'status'] as const,
};

/** Invalidate all portfolio-related data (positions, transactions, closed trades, metrics, history) */
export function invalidatePortfolio(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: QUERY_KEYS.positions });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.transactions });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.closedTrades });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.metrics });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.history });
}

/** Invalidate cash flow related data */
export function invalidateCashFlow(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: QUERY_KEYS.deposits });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.cashFlow });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.metrics });
}

/** Invalidate dividend related data */
export function invalidateDividends(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: QUERY_KEYS.dividends });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.metrics });
}

/** Invalidate FX exchange related data */
export function invalidateFx(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: QUERY_KEYS.fxHistory });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.positions });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.metrics });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.cashFlow });
}

/** Invalidate corporate actions data — rippels through metrics/transactions po resolve (synthetic SELL). */
export function invalidateCorporateActions(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: QUERY_KEYS.corporateActions });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.transactions });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.closedTrades });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.metrics });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.history });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.positions });
}
