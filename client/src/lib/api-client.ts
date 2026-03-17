import type { Portfolio, PortfolioSettings } from 'shared';

const API_BASE = '/api';

let activePortfolioId = localStorage.getItem('activePortfolioId') || 'default';

export function setActivePortfolioId(id: string) {
  activePortfolioId = id;
  localStorage.setItem('activePortfolioId', id);
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
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
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
  deleteDividend: (id: number) =>
    request<{ success: boolean }>(`/portfolio/dividends/${id}`, {
      method: 'DELETE',
    }),
  // Transactions CRUD
  getTransactions: () => request<any>('/portfolio/transactions'),
  createTransaction: (body: { date: string; ticker: string; side: 'K' | 'S'; quantity: number; price: number; commission: number }) =>
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
  createDeposit: (body: { date: string; amount: number }) =>
    request<{ id: number }>('/portfolio/deposits', {
      method: 'POST',
      body: JSON.stringify(body),
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

  getFxHistory: () => request<any>('/portfolio/fx-history'),
  getCashFlow: () => request<any>('/portfolio/cash-flow'),

  postHistory: (body: { benchmark: string; startDate?: string; endDate?: string }) =>
    request<any>('/portfolio/history', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Prices
  getLivePrices: () => request<any>('/prices/live'),

  // Import
  getImportStatus: () => request<any>('/import/status'),

  uploadTransactions: async (file: File, broker: string = 'auto') => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('broker', broker);
    const response = await fetch(`${API_BASE}/import/transactions`, {
      method: 'POST',
      headers: { 'X-Portfolio-Id': activePortfolioId },
      body: formData,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Unknown error' }));
      return { success: false, error: err.error || `HTTP ${response.status}`, skipped: err.skipped };
    }
    return response.json();
  },

  uploadOperations: async (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(`${API_BASE}/import/operations`, {
      method: 'POST',
      headers: { 'X-Portfolio-Id': activePortfolioId },
      body: formData,
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Unknown error' }));
      return { success: false, error: err.error || `HTTP ${response.status}`, skipped: err.skipped };
    }
    return response.json();
  },
};
