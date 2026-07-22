import type { QueryClient } from '@tanstack/react-query';

export const QUERY_KEYS = {
  /** Lista portfeli użytkownika (PortfolioProvider) — niezależna od aktywnego portfela. */
  portfolios: ['portfolios'] as const,
  positions: ['portfolio', 'positions'] as const,
  positionsGreeks: ['portfolio', 'positions', 'greeks'] as const,
  riskReturn: ['portfolio', 'risk-return'] as const,
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
  /** Aktywny publiczny link portfela (ShareDialog) — prefix 'portfolio' =
   *  auto-reset przy zmianie portfela (resetPortfolioScopedQueries). */
  share: ['portfolio', 'share'] as const,
  livePrices: ['prices', 'live'] as const,
  /** Historia kursu jednego instrumentu (wykres pozycji z markerami K/S);
   *  full = pełna historia notowań (preset sięgający przed pierwszą transakcję). */
  instrumentHistory: (isin: string, full = false) =>
    ['prices', 'instrument-history', isin, full ? 'full' : 'tx'] as const,
  importStatus: ['import', 'status'] as const,
  /** Sprzedaże bez kupna (hub Importu) — detekcja liczona na żywo z transakcji. */
  orphanedSells: ['import', 'orphaned-sells'] as const,
  /** Historia portfela w widoku Porównanie — kluczowana JAWNIE per portfolioId,
   *  więc celowo z prefiksem 'portfolios' (nie 'portfolio'): dane nie zależą od
   *  aktywnego portfela i mają przeżyć resetPortfolioScopedQueries przy jego
   *  przełączeniu (reset = 5 ciężkich przeliczeń historii na serwerze na darmo). */
  compareHistory: (portfolioId: string, benchmark: string) =>
    ['portfolios', 'compare-history', portfolioId, benchmark] as const,
  /** Prefix wszystkich analiz FIFO — do invalidacji po mutacjach transakcji. */
  fifoMatchingAll: ['portfolio', 'fifo-matching'] as const,
  /** Analiza dopasowań FIFO per ISIN (DeleteTransactionDialog). */
  fifoMatching: (isin: string) => ['portfolio', 'fifo-matching', isin] as const,
  /** Prefix wszystkich smart-delete preview — do invalidacji po mutacjach transakcji. */
  smartDeletePreviewAll: ['portfolio', 'smart-delete-preview'] as const,
  /** Plan kaskadowego usunięcia per transakcja (DeleteTransactionDialog). */
  smartDeletePreview: (id: number) => ['portfolio', 'smart-delete-preview', id] as const,
};

/** Invalidate all portfolio-related data (positions, transactions, closed trades, metrics, history) */
export function invalidatePortfolio(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: QUERY_KEYS.positions });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.transactions });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.closedTrades });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.metrics });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.history });
  // Pochodne analizy FIFO — bez invalidacji DeleteTransactionDialog pokazywałby
  // stale dane (staleTime 30s) po edycji/usunięciu transakcji.
  qc.invalidateQueries({ queryKey: QUERY_KEYS.fifoMatchingAll });
  qc.invalidateQueries({ queryKey: QUERY_KEYS.smartDeletePreviewAll });
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
