import type { Portfolio, PortfolioSettings } from 'shared';

const API_BASE = '/api';

let activePortfolioId = (() => {
  try {
    return localStorage.getItem('activePortfolioId') || 'default';
  } catch {
    return 'default';
  }
})();

export function setActivePortfolioId(id: string) {
  activePortfolioId = id;
  try {
    localStorage.setItem('activePortfolioId', id);
  } catch {
    /* Safari Private */
  }
}

export function getActivePortfolioId(): string {
  return activePortfolioId;
}

function portfolioHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Portfolio-Id': activePortfolioId,
  };
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    headers: portfolioHeaders(),
    credentials: 'include', // send auth cookies
    ...options,
  });

  // Redirect to login on 401 (session expired or not authenticated)
  if (response.status === 401) {
    window.location.href = '/login';
    throw new Error('Session expired');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

async function uploadFile(endpoint: string, formData: FormData) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'X-Portfolio-Id': activePortfolioId },
    credentials: 'include',
    body: formData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }));
    return { success: false, error: err.error || `HTTP ${response.status}`, skipped: err.skipped };
  }
  return response.json();
}

export const api = {
  // Portfolio management
  getPortfolios: () => request<Portfolio[]>('/portfolios'),
  createPortfolio: (name: string) =>
    request<Portfolio>('/portfolios', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  updatePortfolio: (id: string, body: { name?: string; settings?: PortfolioSettings }) =>
    request<Portfolio>(`/portfolios/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deletePortfolio: (id: string) =>
    request<{ success: boolean }>(`/portfolios/${id}`, {
      method: 'DELETE',
    }),
  purgePortfolioData: (id: string) =>
    request<{ success: boolean }>(`/portfolios/${id}/data`, {
      method: 'DELETE',
    }),

  // Portfolio
  getPositions: () => request<any>('/portfolio/positions'),
  getMetrics: () => request<any>('/portfolio/metrics'),
  getClosedTrades: () => request<any>('/portfolio/closed-trades'),
  getDividends: () => request<any>('/portfolio/dividends'),
  createDividend: (body: { date: string; ticker: string; amount: number; currency: string }) =>
    request<{ id: number }>('/portfolio/dividends', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateDividend: (
    id: number,
    body: {
      date: string;
      ticker: string;
      amount: number;
      currency: string;
      description?: string;
    },
  ) =>
    request<{ success: boolean }>(`/portfolio/dividends/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  scanDividends: () =>
    request<{ scanned: number; newDividends: number; errors: string[] }>(
      '/portfolio/dividends/scan',
      {
        method: 'POST',
      },
    ),
  getUpcomingDividends: () =>
    request<{ upcoming: import('shared').UpcomingDividend[] }>('/portfolio/dividends/upcoming'),
  deleteDividend: (id: number) =>
    request<{ success: boolean }>(`/portfolio/dividends/${id}`, {
      method: 'DELETE',
    }),
  // Transactions CRUD
  getTransactions: () => request<any>('/portfolio/transactions'),
  createTransaction: (body: {
    date: string;
    ticker: string;
    side: 'K' | 'S';
    quantity: number;
    price: number;
    commission: number;
    currency?: string;
    fxRate?: number;
    category?: string;
  }) =>
    request<{ id: number }>('/portfolio/transactions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateTransaction: (
    id: number,
    body: Partial<{
      date: string;
      ticker: string;
      side: 'K' | 'S';
      quantity: number;
      price: number;
      commission: number;
    }>,
  ) =>
    request<{ success: boolean }>(`/portfolio/transactions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteTransaction: (id: number) =>
    request<{ success: boolean }>(`/portfolio/transactions/${id}`, {
      method: 'DELETE',
    }),
  bulkDeleteTransactions: (ids: number[]) =>
    request<{ success: boolean; deleted: number }>(`/portfolio/transactions/bulk-delete`, {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),
  getFifoMatching: (isin: string) =>
    request<{
      isin: string;
      ticker: string;
      paperName: string;
      currency: string;
      transactions: Array<{
        txId: number;
        date: string;
        side: 'K' | 'S';
        quantity: number;
        price: number;
        currency: string;
        commission: number;
        source?: string;
        syntheticOrigin?: string;
        isCfd: boolean;
        matches: Array<{
          counterpartyTxId: number;
          counterpartyDate: string;
          counterpartyPrice: number;
          counterpartyCurrency: string;
          quantity: number;
        }>;
        matchedQty: number;
        residualQty: number;
        status: 'fully-matched' | 'partial' | 'open' | 'orphan';
      }>;
      hasComplexity: boolean;
      netOpenQty: number;
      totalBuys: number;
      totalSells: number;
    }>(`/portfolio/transactions/fifo-matching?isin=${encodeURIComponent(isin)}`),
  smartDeletePreview: (id: number) =>
    request<{
      deletes: number[];
      edits: Array<{ txId: number; newQuantity: number; originalQuantity: number }>;
      warnings: string[];
      unsupported?: string;
    }>(`/portfolio/transactions/${id}/smart-delete-preview`, { method: 'POST' }),
  smartDeleteApply: (id: number) =>
    request<{ success: boolean; deleted: number; edited: number; warnings: string[] }>(
      `/portfolio/transactions/${id}/smart-delete-apply`,
      { method: 'POST' },
    ),

  // Ticker search
  searchTickers: (query: string) =>
    request<Array<{ symbol: string; name: string; exchange: string; currency?: string }>>(
      `/portfolio/ticker-search?q=${encodeURIComponent(query)}`,
    ),

  // Ticker map — sector backfill (dla istniejących entries bez sectora)
  refreshSectors: () =>
    request<{
      total: number;
      needingUpdate: number;
      updated: number;
      fromCfdMap: number;
      fromYahoo: number;
      failed: string[];
    }>('/portfolio/ticker-map/refresh-sectors', { method: 'POST' }),

  // Deposits CRUD
  getDeposits: () => request<any>('/portfolio/deposits'),
  createDeposit: (
    body: { date: string; amount: number },
    type: 'deposit' | 'withdrawal' = 'deposit',
  ) =>
    request<{ id: number }>('/portfolio/deposits', {
      method: 'POST',
      body: JSON.stringify({ ...body, type }),
    }),
  updateDeposit: (id: number, body: { date?: string; amount?: number }) =>
    request<{ success: boolean }>(`/portfolio/deposits/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteDeposit: (id: number) =>
    request<{ success: boolean }>(`/portfolio/deposits/${id}`, {
      method: 'DELETE',
    }),

  // Fees (legacy — zachowane dla backward compat, UI używa getAdditionalCosts)
  getFees: () => request<{ fees: any[]; total: number }>('/portfolio/fees'),

  // Additional costs (ujednolicony endpoint: fee + trade_fee + commission_refund + other)
  // Konsumowany przez CorrectionsAndCostsPage w sekcji "Pozostałe przepływy".
  getAdditionalCosts: () =>
    request<{
      operations: Array<{
        id: number;
        date: string;
        category: 'fee' | 'trade_fee' | 'commission_refund' | 'other';
        /** Opcjonalny subkind. 'interest' oznacza odsetki (UI pokazuje je jako osobną kategorię). */
        subkind?: 'interest' | string;
        ticker?: string;
        amount: number;
        currency: string;
        description: string;
        source: string;
      }>;
      totals: {
        fees: number;
        commissionRefunds: number;
        tradeFees: number;
        other: number;
        grandTotal: number;
      };
      /** Waluta bazowa portfela (np. 'PLN' dla Bossa, 'USD' dla XTB USD sub-account). */
      baseCurrency: string;
    }>('/portfolio/additional-costs'),

  // Ręczne dodanie operacji do "Pozostałe przepływy". Subkind opcjonalnie —
  // używane dla kategorii "Odsetki" (category='other', subkind='interest').
  createAdditionalCost: (body: {
    date: string;
    category: 'fee' | 'trade_fee' | 'commission_refund' | 'other';
    amount: number;
    currency?: string;
    description?: string;
    subkind?: 'interest';
  }) =>
    request<{ id: number }>('/portfolio/additional-costs', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteAdditionalCost: (id: number) =>
    request<{ success: boolean }>(`/portfolio/additional-costs/${id}`, {
      method: 'DELETE',
    }),

  // Corporate actions (capital_return + corporate_action_pending)
  getCorporateActions: () =>
    request<{
      actions: Array<{
        id: number;
        date: string;
        operationType: 'capital_return' | 'corporate_action_pending';
        subkind?:
          | 'nominal_reduction'
          | 'redemption_adjustment'
          | 'unknown_tender'
          | 'unknown_warrant';
        ticker?: string;
        amount: number;
        currency: string;
        description: string;
        source: string;
        status: 'resolved' | 'pending';
      }>;
      totals: { capitalReturn: number; pendingCount: number };
      /** Waluta bazowa portfela (np. 'PLN' dla Bossa, 'USD' dla XTB USD sub-account). */
      baseCurrency: string;
    }>('/portfolio/corporate-actions'),
  resolveCorporateAction: (
    id: number,
    body: { quantity: number; price: number; ticker?: string; isin?: string },
  ) =>
    request<{ success: boolean; transactionsInserted: number; duplicates: number }>(
      `/portfolio/corporate-actions/${id}/resolve`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  deleteCorporateAction: (id: number) =>
    request<{ success: boolean }>(`/portfolio/corporate-actions/${id}`, {
      method: 'DELETE',
    }),

  getFxHistory: () => request<any>('/portfolio/fx-history'),
  createFxExchange: (body: {
    date: string;
    currencyFrom: string;
    currencyTo: string;
    amountFrom: number;
    rate: number;
  }) =>
    request<{ success: boolean }>('/portfolio/fx-exchanges', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteFxExchange: (fromId: number, toId: number) =>
    request<{ success: boolean }>(`/portfolio/fx-exchanges/${fromId}/${toId}`, {
      method: 'DELETE',
    }),
  getCashFlow: () => request<any>('/portfolio/cash-flow'),

  postHistory: (body: { benchmark: string; startDate?: string; endDate?: string }) =>
    request<any>('/portfolio/history', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Stock Splits
  getSplits: () => request<any>('/portfolio/splits'),
  createSplit: (body: { isin: string; ticker: string; splitDate: string; ratio: number }) =>
    request<{ success: boolean }>('/portfolio/splits', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteSplit: (id: number) =>
    request<{ success: boolean }>(`/portfolio/splits/${id}`, {
      method: 'DELETE',
    }),

  // Prices
  getLivePrices: () => request<any>('/prices/live'),

  // Import
  getImportStatus: () => request<any>('/import/status'),

  /**
   * Klasyfikacja pliku — zwraca wykryty broker + rolę (transactions/operations).
   * UI używa tego żeby zdecydować, czy drugie pole (operacje) jest potrzebne.
   */
  detectImportFile: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return uploadFile('/import/detect', formData) as Promise<import('shared').DetectResult>;
  },

  /**
   * Atomowy import — jeden request, wszystkie pliki naraz. Backend parsuje,
   * inserteruje i wykonuje reconciliation w jednej transakcji SQLite.
   * `transactionsFiles` może mieć 1-N plików (np. Bossa eksportuje osobno
   * per waluta: hisPW-PLN.csv + hisPW-USD.csv + hisPW-EUR.csv).
   */
  bulkImport: (transactionsFiles: File[], operationsFile: File | null) => {
    const formData = new FormData();
    for (const file of transactionsFiles) {
      formData.append('transactions', file);
    }
    if (operationsFile) formData.append('operations', operationsFile);
    return uploadFile('/import/bulk', formData);
  },

  // Bug reports
  submitBugReport: (data: { category: string; description: string }) =>
    request<{ success: boolean; id: string }>('/bug-reports', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getBugReports: () =>
    request<
      Array<{
        id: string;
        userId: string;
        userEmail: string;
        category: string;
        description: string;
        userAgent: string;
        url: string;
        createdAt: string;
      }>
    >('/bug-reports'),
};
