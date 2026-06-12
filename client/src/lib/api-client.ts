import type {
  CashFlowResponse,
  ClosedTradesResponse,
  DepositsResponse,
  DividendsResponse,
  FeesResponse,
  FxHistoryResponse,
  ImportStatusResponse,
  LivePricesResponse,
  Portfolio,
  PortfolioHistoryResponse,
  PortfolioMetricsResponse,
  PortfolioPositionsResponse,
  PortfolioSettings,
  PortfolioShare,
  PublicHistoryResponse,
  PublicPositionsResponse,
  PublicShareMeta,
  ShareSettingsInput,
  SplitsResponse,
  TransactionsResponse,
} from 'shared';

const API_BASE = '/api';

/**
 * Błąd HTTP z API — zachowuje `message` identycznie jak wcześniejsze `Error`
 * (wszyscy konsumenci czytają `.message`), ale dokłada `status`, żeby logika
 * (np. PortfolioProvider) mogła rozróżniać 403/404 bez substring-matchowania
 * treści komunikatu.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

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
  // Merge headers zamiast spread całych options PO headers — caller podający własne
  // options.headers nadpisałby cały obiekt i zgubił Content-Type + X-Portfolio-Id.
  // Teraz defaults przeżywają, a pojedyncze nagłówki można świadomie nadpisać.
  const { headers: optionHeaders, ...restOptions } = options ?? {};
  const response = await fetch(`${API_BASE}${url}`, {
    credentials: 'include', // send auth cookies
    ...restOptions,
    headers: { ...portfolioHeaders(), ...(optionHeaders ?? {}) },
  });

  // Redirect to login on 401 (session expired or not authenticated)
  if (response.status === 401) {
    window.location.href = '/login';
    throw new ApiError('Session expired', 401);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(error.error || `HTTP ${response.status}`, response.status);
  }

  return response.json();
}

/**
 * Upload multipart. W przeciwieństwie do `request()` NIE rzuca na błędy HTTP —
 * zwraca `{ success: false, error, skipped }`, bo ImportDialog renderuje błędy
 * i pominięte wiersze w dialogu zamiast w toaście. 401 obsługujemy identycznie
 * jak w `request()` (wygasła sesja → redirect na /login).
 */
async function uploadFile<T>(endpoint: string, formData: FormData): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'X-Portfolio-Id': activePortfolioId },
    credentials: 'include',
    body: formData,
  });
  if (response.status === 401) {
    window.location.href = '/login';
    throw new ApiError('Session expired', 401);
  }
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Unknown error' }));
    return {
      success: false,
      error: err.error || `HTTP ${response.status}`,
      skipped: err.skipped,
    } as unknown as T;
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
  getPositions: () => request<PortfolioPositionsResponse>('/portfolio/positions'),
  getMetrics: () => request<PortfolioMetricsResponse>('/portfolio/metrics'),
  getClosedTrades: () => request<ClosedTradesResponse>('/portfolio/closed-trades'),
  getDividends: () => request<DividendsResponse>('/portfolio/dividends'),
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
    request<{ scanned: number; newDividends: number; errors: string[]; warnings: string[] }>(
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
  getTransactions: () => request<TransactionsResponse>('/portfolio/transactions'),
  createTransaction: (body: {
    date: string;
    ticker: string;
    side: 'K' | 'S';
    quantity: number;
    price: number;
    commission: number;
    currency?: string;
    paymentCurrency?: string;
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
      paymentCurrency: string;
      fxRate: number;
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
  // Pojedynczy lookup waluty + nazwy ticker'a (sprawdza ticker_map + Yahoo)
  getTickerInfo: (symbol: string) =>
    request<{ currency: string | null; name: string | null }>(
      `/portfolio/ticker-info?symbol=${encodeURIComponent(symbol)}`,
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
  getDeposits: () => request<DepositsResponse>('/portfolio/deposits'),
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
  getFees: () => request<FeesResponse>('/portfolio/fees'),

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

  getFxHistory: () => request<FxHistoryResponse>('/portfolio/fx-history'),
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
  getCashFlow: () => request<CashFlowResponse>('/portfolio/cash-flow'),

  postHistory: (body: { benchmark: string; startDate?: string; endDate?: string }) =>
    request<PortfolioHistoryResponse>('/portfolio/history', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // Stock Splits
  getSplits: () => request<SplitsResponse>('/portfolio/splits'),
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
  getLivePrices: () => request<LivePricesResponse>('/prices/live'),

  // Import
  getImportStatus: () => request<ImportStatusResponse>('/import/status'),

  /**
   * Klasyfikacja pliku — zwraca wykryty broker + rolę (transactions/operations).
   * UI używa tego żeby zdecydować, czy drugie pole (operacje) jest potrzebne.
   */
  detectImportFile: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return uploadFile<import('shared').DetectResult>('/import/detect', formData);
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
    // `error` (singular) pochodzi z gałęzi !response.ok w uploadFile.
    return uploadFile<import('shared').ImportResult & { error?: string }>('/import/bulk', formData);
  },

  // ── Import uniwersalny (profile-driven) ────────────────────────────────────

  /**
   * Analiza pliku pod import uniwersalny: znany broker → known:true (użyj
   * bulkImport); inaczej fingerprint + profil z biblioteki + zredagowana próbka.
   */
  genericAnalyze: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return uploadFile<import('shared').GenericAnalyzeResult & { error?: string }>(
      '/import/generic/analyze',
      formData,
    );
  },

  /**
   * Generacja mapowania przez LLM (wymaga jawnej zgody użytkownika w UI —
   * do API AI idą wyłącznie nagłówki + zredagowana próbka). 503 = AI off.
   */
  genericGenerateProfile: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return uploadFile<import('shared').GenericGenerateProfileResult & { error?: string }>(
      '/import/generic/generate-profile',
      formData,
    );
  },

  /** Wykonanie profilu BEZ zapisu — obowiązkowy podgląd przed importem. */
  genericPreview: (file: File, profile: unknown) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('profile', JSON.stringify(profile));
    return uploadFile<import('shared').GenericPreviewResult & { error?: string }>(
      '/import/generic/preview',
      formData,
    );
  },

  /** Atomowy import: profil z biblioteki (profileId) ALBO inline (zapisany jako pending). */
  genericCommit: (file: File, opts: { profileId?: string; profile?: unknown }) => {
    const formData = new FormData();
    formData.append('file', file);
    if (opts.profileId) formData.append('profileId', opts.profileId);
    else formData.append('profile', JSON.stringify(opts.profile));
    return uploadFile<import('shared').GenericCommitResult & { error?: string }>(
      '/import/generic/commit',
      formData,
    );
  },

  genericBatches: () =>
    request<{ batches: import('shared').GenericBatchInfo[] }>('/import/generic/batches'),

  genericReimport: (importBatch: string) =>
    request<import('shared').GenericCommitResult>(
      `/import/generic/reimport/${encodeURIComponent(importBatch)}`,
      { method: 'POST' },
    ),

  // Public share (CRUD właściciela — wymaga sesji + X-Portfolio-Id)
  getShare: () => request<{ share: PortfolioShare | null }>('/share'),
  createShare: (body: ShareSettingsInput) =>
    request<{ share: PortfolioShare }>('/share', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateShare: (body: ShareSettingsInput) =>
    request<{ share: PortfolioShare }>('/share', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteShare: () =>
    request<{ success: boolean }>('/share', {
      method: 'DELETE',
    }),

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

/**
 * Minimalny fetch dla publicznej strony share — bez X-Portfolio-Id (portfel
 * wynika z tokenu) i bez redirectu na /login przy 401 (endpointy publiczne
 * zwracają 404, a anonimowy widz nie ma się gdzie logować).
 */
async function publicRequest<T>(url: string): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new ApiError(error.error || `HTTP ${response.status}`, response.status);
  }
  return response.json();
}

export const publicApi = {
  getShareMeta: (token: string) =>
    publicRequest<PublicShareMeta>(`/public/share/${encodeURIComponent(token)}/meta`),
  getShareHistory: (token: string) =>
    publicRequest<PublicHistoryResponse>(`/public/share/${encodeURIComponent(token)}/history`),
  getSharePositions: (token: string) =>
    publicRequest<PublicPositionsResponse>(`/public/share/${encodeURIComponent(token)}/positions`),
};
