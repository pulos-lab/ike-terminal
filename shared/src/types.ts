// ============ Broker Types ============

export type BrokerType = 'auto' | 'bossa' | 'mbank' | 'degiro';

export const BROKER_LABELS: Record<BrokerType, string> = {
  auto: 'Wykryj automatycznie',
  bossa: 'Bossa',
  mbank: 'mBank eMakler',
  degiro: 'DEGIRO',
};

// ============ Transaction Types ============

export interface Transaction {
  id?: number;
  date: string; // ISO 8601
  paperName: string;
  isin: string;
  quantity: number;
  side: 'K' | 'S'; // K=buy, S=sell
  price: number;
  value: number;
  commission: number;
  total: number; // po prowizji
  currency: string;
  source: 'bossa' | 'mbank' | 'degiro' | 'manual';
  importBatch?: string;
}

// ============ Cash Operation Types ============

export type OperationType = 'deposit' | 'dividend' | 'fx_exchange' | 'fee' | 'commission_refund' | 'other';

export interface CashOperation {
  id?: number;
  date: string;
  operationType: OperationType;
  description: string;
  details?: string;
  amount: number;
  currency: string;
  ticker?: string; // for dividends
  fxRate?: number; // for fx exchanges
  fxPair?: string; // e.g., 'PLN/USD'
  source: 'bossa' | 'mbank' | 'degiro' | 'manual';
  importBatch?: string;
}

// ============ Portfolio Types ============

export interface Position {
  paperName: string;
  isin: string;
  ticker: string;
  shares: number;
  avgBuyPrice: number;
  totalCommission: number;
  currentPrice: number | null;
  currentValue: number;
  currentValuePln: number;
  profitLoss: number;
  profitLossPln: number;
  profitLossPct: number;
  currency: string;
  weight: number;
  exchange?: string;
  sector?: string;
  dailyChangePct: number | null;
}

export interface ClosedTrade {
  paperName: string;
  isin: string;
  ticker: string;
  quantity: number;
  buyDate: string;
  buyPrice: number;
  buyCommission: number;
  sellDate: string;
  sellPrice: number;
  sellCommission: number;
  profitLoss: number;
  profitLossPct: number;
  holdingDays: number;
  currency: string;
  sellTransactionId: number;
  sellSource: 'bossa' | 'mbank' | 'degiro' | 'manual';
}

export interface DividendRecord {
  id: number;
  date: string;
  ticker: string;
  description: string;
  amount: number;
  currency: string;
  source: 'bossa' | 'mbank' | 'degiro' | 'manual';
}

export interface DividendInput {
  date: string;
  ticker: string;
  amount: number;
  currency: string;
}

export interface DepositInput {
  date: string;
  amount: number;
}

export interface FxExchangeRecord {
  date: string;
  pair: string;
  rate: number;
  amountFrom: number;
  currencyFrom: string;
  amountTo: number;
  currencyTo: string;
}

export interface CashFlowRecord {
  date: string;
  depositAmount: number;
  cumulativeDeposits: number;
  portfolioValue: number;
}

// ============ Chart Types ============

export interface PortfolioHistoryPoint {
  date: string;
  portfolioValue: number;
  returnPct: number;
  twrPct: number;
  benchmarkValue: number;
  benchmarkReturnPct: number;
  benchmarkTwrPct: number;
  investedCumulative: number;
}

export interface PortfolioMetrics {
  currentValue: number;
  totalInvested: number;
  xirr: number;
  totalReturn: number;
  totalReturnPct: number;
  totalDividends: number;
}

// ============ Ticker Map Types ============

export interface TickerMapEntry {
  isin: string;
  ticker: string;
  name: string;
  exchange: 'GPW' | 'NC' | 'NYSE' | 'NASDAQ' | 'TSX' | 'XETRA' | 'OTHER';
  currency: string;
  priceSource: 'yahoo' | 'stooq' | 'auto';
  sector?: string;
}

// ============ Price Types ============

export interface LivePrice {
  price: number;
  currency: string;
  change?: number;
  changePct?: number;
  timestamp?: string;
}

export interface HistoricalPrice {
  date: string;
  close: number;
}

// ============ Ticker Search Types ============

export interface TickerSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  currency?: string;
}

// ============ Transaction Input Types ============

export interface TransactionInput {
  date: string;
  ticker: string;
  side: 'K' | 'S';
  quantity: number;
  price: number;
  commission: number;
}

// ============ Import Parse Types ============

export type SkipReason =
  | 'missing_date' | 'missing_isin' | 'missing_name'
  | 'invalid_side' | 'invalid_quantity' | 'invalid_price'
  | 'invalid_date' | 'corporate_action' | 'short_row'
  | 'zero_amount' | 'settlement_record';

export interface SkippedRow {
  row: number;
  reason: SkipReason;
  paperName?: string;
}

export interface ParseResult<T> {
  data: T[];
  skipped: SkippedRow[];
}

// ============ API Response Types ============

export interface CashPosition {
  currency: string;
  balance: number;
  valuePln: number;
  weight: number;
}

export interface PortfolioPositionsResponse {
  positions: Position[];
  cashPositions: CashPosition[];
  totalValuePln: number;
  stocksValuePln: number;
  cashValuePln: number;
}

export interface PortfolioHistoryResponse {
  history: PortfolioHistoryPoint[];
  metrics: PortfolioMetrics;
}

export interface LivePricesResponse {
  prices: Record<string, LivePrice>;
  fx: Record<string, number>;
  timestamp: string;
}

export interface ImportResult {
  success: boolean;
  transactionsImported: number;
  operationsImported: number;
  errors: string[];
  importBatch: string;
  tickersResolved?: number;
  tickersUnresolved?: string[];
  skipped?: SkippedRow[];
}

// ============ Portfolio Management ============

export interface PortfolioSettings {
  isIKE: boolean;
  isIKZE: boolean;
  ikzeIsDG: boolean; // działalność gospodarcza
}

export const DEFAULT_PORTFOLIO_SETTINGS: PortfolioSettings = {
  isIKE: false,
  isIKZE: false,
  ikzeIsDG: false,
};

export interface Portfolio {
  id: string;
  name: string;
  createdAt: string;
  settings: PortfolioSettings;
}
