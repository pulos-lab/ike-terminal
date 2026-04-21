import type { Portfolio, PortfolioSettings } from 'shared';

const API_BASE = '/api';

let activePortfolioId = (() => {
  try { return localStorage.getItem('activePortfolioId') || 'default'; }
  catch { return 'default'; }
})();

export function setActivePortfolioId(id: string) {
  activePortfolioId = id;
  try { localStorage.setItem('activePortfolioId', id); } catch { /* Safari Private */ }
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
  updateDividend: (id: number, body: { date: string; ticker: string; amount: number; currency: string }) =>
    request<{ success: boolean }>(`/portfolio/dividends/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  scanDividends: () =>
    request<{ scanned: number; newDividends: number; errors: string[] }>('/portfolio/dividends/scan', {
      method: 'POST',
    }),
  getUpcomingDividends: () =>
    request<{ upcoming: import('shared').UpcomingDividend[] }>('/portfolio/dividends/upcoming'),
  deleteDividend: (id: number) =>
    request<{ success: boolean }>(`/portfolio/dividends/${id}`, {
      method: 'DELETE',
    }),
  // Transactions CRUD
  getTransactions: () => request<any>('/portfolio/transactions'),
  createTransaction: (body: { date: string; ticker: string; side: 'K' | 'S'; quantity: number; price: number; commission: number; currency?: string; fxRate?: number; category?: string }) =>
    request<{ id: number }>('/portfolio/transactions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateTransaction: (id: number, body: Partial<{ date: string; ticker: string; side: 'K' | 'S'; quantity: number; price: number; commission: number }>) =>
    request<{ success: boolean }>(`/portfolio/transactions/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteTransaction: (id: number) =>
    request<{ success: boolean }>(`/portfolio/transactions/${id}`, {
      method: 'DELETE',
    }),

  // Ticker search
  searchTickers: (query: string) =>
    request<Array<{ symbol: string; name: string; exchange: string; currency?: string }>>(`/portfolio/ticker-search?q=${encodeURIComponent(query)}`),

  // Deposits CRUD
  getDeposits: () => request<any>('/portfolio/deposits'),
  createDeposit: (body: { date: string; amount: number }, type: 'deposit' | 'withdrawal' = 'deposit') =>
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

  // Fees
  getFees: () => request<{ fees: any[]; total: number }>('/portfolio/fees'),

  getFxHistory: () => request<any>('/portfolio/fx-history'),
  createFxExchange: (body: { date: string; currencyFrom: string; currencyTo: string; amountFrom: number; rate: number }) =>
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
   * Atomowy import — jeden request, oba pliki naraz. Zastępuje stare uploadTransactions
   * i uploadOperations. Backend robi wszystko w jednej transakcji SQLite.
   */
  bulkImport: (transactionsFile: File | null, operationsFile: File | null) => {
    const formData = new FormData();
    if (transactionsFile) formData.append('transactions', transactionsFile);
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
    request<Array<{
      id: string;
      userId: string;
      userEmail: string;
      category: string;
      description: string;
      userAgent: string;
      url: string;
      createdAt: string;
    }>>('/bug-reports'),
};
