// ============ Broker Types ============

export type BrokerType = 'auto' | 'bossa' | 'mbank' | 'degiro' | 'xtb';

export const BROKER_LABELS: Record<BrokerType, string> = {
  auto: 'Wykryj automatycznie',
  bossa: 'Bossa',
  mbank: 'mBank eMakler',
  degiro: 'DEGIRO',
  xtb: 'XTB',
};

// ============ Transaction Types ============

export type InstrumentCategory = 'stock' | 'etf' | 'cfd';

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
  /**
   * QUOTE currency — waluta kwotowania papieru na giełdzie (np. USD dla AAPL, PLN dla CDR.WA).
   * Od PR14: `currency` ma zawsze oznaczać quote currency. Historycznie w parserach
   * Bossa/mBank trzymano tu payment currency; po migracji pole jest znormalizowane.
   */
  currency: string;
  /**
   * PAYMENT currency — waluta faktycznego rozliczenia (co user zapłacił).
   * Może być inna niż `currency` gdy broker przewalutował (np. PLN → USD przy Bossa Zagranica).
   * Opcjonalne dla backward compat ze starymi rekordami; fallback = `currency`.
   */
  paymentCurrency?: string;
  /** Kurs wymiany user'a: paymentCurrency × fxRate ≈ quote currency amount. */
  fxRate?: number;
  category?: InstrumentCategory;
  source: 'bossa' | 'mbank' | 'degiro' | 'xtb' | 'manual' | 'auto-yahoo';
  importBatch?: string;
  swap?: number;       // CFD: swap cost (from Closed Positions sheet)
  rollover?: number;   // CFD: rollover cost (from Closed Positions sheet)
  cfdPositionId?: string; // CFD: unique position ID for FIFO grouping (prevents mixing overlapping positions)
  cfdGrossProfit?: number; // CFD: gross profit from XTB (includes contract multiplier + FX, before fees)
  /**
   * Jeśli transakcja została wygenerowana automatycznie (reconciliation), tu trafia ludzki
   * opis źródła — np. "Wykup w ofercie skupu GAMIVO" albo "Wykup certyfikatów INTLGLD46805".
   * Dla zwykłych K/S z pliku brokera: undefined. UI pokazuje ikonę ℹ i tooltip.
   */
  syntheticOrigin?: string;
}

// ============ Cash Operation Types ============

export type OperationType = 'deposit' | 'withdrawal' | 'dividend' | 'fx_exchange' | 'fee' | 'trade_fee' | 'commission_refund' | 'other';

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
  source: 'bossa' | 'mbank' | 'degiro' | 'xtb' | 'manual' | 'auto-yahoo';
  importBatch?: string;
}

// ============ Portfolio Types ============

export interface OpenBuyLot {
  quantity: number;
  price: number;
  commission: number;
  date: string;
  currency: string;
}

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
  category?: InstrumentCategory;
  buyLots?: OpenBuyLot[];
  /** true when price comes from last transaction, not live market data */
  priceManual?: boolean;
}

export interface ClosedTradeFee {
  type: string;
  amount: number;
  description: string;
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
  sellSource: 'bossa' | 'mbank' | 'degiro' | 'xtb' | 'manual' | 'auto-yahoo';
  category?: InstrumentCategory;
  fees?: ClosedTradeFee[];
  totalCost?: number;
  isShort?: boolean;
}

export interface DividendRecord {
  id: number;
  date: string;
  ticker: string;
  description: string;
  amount: number;
  currency: string;
  source: 'bossa' | 'mbank' | 'degiro' | 'xtb' | 'manual' | 'auto-yahoo';
}

export interface UpcomingDividend {
  ticker: string;
  name: string;
  exDividendDate: string;
  paymentDate: string | null;
  estimatedAmount: number;
  currency: string;
  shares: number;
  dividendPerShare: number | null;
  dividendYield: number | null;
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
  fromOperationId?: number;
  toOperationId?: number;
  source?: string;
}

export interface FxExchangeInput {
  date: string;
  currencyFrom: string;
  currencyTo: string;
  amountFrom: number;
  rate: number;
}

export interface CashFlowRecord {
  date: string;
  depositAmount: number;
  withdrawalAmount: number;
  cumulativeDeposits: number;
  cumulativeWithdrawals: number;
  netCashFlow: number;
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
  /** Skumulowane wpłaty w PLN (wszystkie waluty konwertowane per-day FX).
   * Dla portfeli multi-currency to jest MWR base. */
  cumulativeDepositsPln: number;
  /** Skumulowane wypłaty w PLN (wszystkie waluty konwertowane per-day FX). */
  cumulativeWithdrawalsPln: number;
}

export interface PortfolioMetrics {
  currentValue: number;
  totalInvested: number;
  xirr: number;
  totalReturn: number;
  totalReturnPct: number;
  totalDividends: number;
}

/** Metryka "Wpływ walut" — różnica między dzisiejszym kursem PLN a
 *  średnim ważonym kursem zakupu wszystkich walut obcych w portfelu.
 *
 *  Obsługuje dwa scenariusze:
 *  1. Single-currency portfel (baseCurrency != 'PLN', np. XTB USD sub-konto):
 *     deposits z fxRate są eventami "zakupu" waluty bazowej. Exposure = cały
 *     portfel w walucie bazowej.
 *  2. Multi-currency portfel (baseCurrency='PLN' z obcymi instrumentami,
 *     np. Bossa/DEGIRO z USD stocks): fx_exchange ops są eventami "zakupu"
 *     walut obcych. Exposure per waluta = cash_X + Σ stocks denominated in X.
 *     FX impact liczony per-waluta, sumowany jako total. */
export interface FxImpact {
  /** Ważona procentowa zmiana (łączny impact / łączna exposure w PLN). */
  fxImpactPct: number;
  /** Łączna kwota w PLN — suma per-currency impactów. */
  fxImpactPln: number;
  /** Rozkład per waluta obca (USD, EUR, …). Zawsze tablica, może mieć 1 lub N
   *  elementów w zależności od liczby walut obcych w portfelu. */
  breakdown: FxImpactCurrencyEntry[];
}

/** Pojedynczy wpis breakdown per waluta obca — składowa FxImpact. */
export interface FxImpactCurrencyEntry {
  /** Waluta, np. 'USD', 'EUR'. */
  currency: string;
  /** Dzisiejsza ekspozycja w walucie natywnej (cash + stock values). */
  exposureNative: number;
  /** Ekspozycja przeliczona na PLN po dzisiejszym kursie. */
  exposurePln: number;
  /** Średni ważony kurs PLN za 1 jednostkę waluty przy zakupach. */
  avgPlnPerCurrency: number;
  /** Dzisiejszy kurs PLN za 1 jednostkę waluty. */
  todayPlnPerCurrency: number;
  /** Wpływ walut dla tej waluty w PLN (exposureNative × (today − avg)). */
  impactPln: number;
  /** Wpływ walut dla tej waluty jako % (today/avg − 1). */
  impactPct: number;
  /** Łączna suma wydarzeń "zakupu" tej waluty (natywnie). */
  totalAcquiredNative: number;
}

// ============ Stock Split Types ============

export interface DetectedSplit {
  ticker: string;
  isin: string;
  date: string;        // YYYY-MM-DD — date when split was detected/occurred
  ratio: number;       // e.g. 25 for 25:1 split
  txPrice: number;     // transaction price (pre-split)
  providerPrice: number; // Yahoo/Stooq price (post-split adjusted)
  source: 'auto' | 'manual';
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

// ============ Stock Split Types ============

export interface StockSplit {
  id?: number;
  isin: string;
  ticker: string;
  splitDate: string;
  /** Split ratio: e.g. 10 for 10:1 forward split, 0.2 for 1:5 reverse split */
  ratio: number;
  source: 'auto' | 'manual';
  detectedAt?: string;
}

export interface StockSplitInput {
  isin: string;
  ticker: string;
  splitDate: string;
  ratio: number;
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
  currency?: string;  // override waluty z tickera
  fxRate?: number;    // kurs wymiany brokera (informacyjny)
  category?: InstrumentCategory;
}

// ============ Import Parse Types ============

export type SkipReason =
  | 'missing_date' | 'missing_isin' | 'missing_name'
  | 'invalid_side' | 'invalid_quantity' | 'invalid_price'
  | 'invalid_date' | 'corporate_action' | 'short_row'
  | 'zero_amount' | 'settlement_record'
  | 'summary_row' | 'unparseable_comment' | 'close_trade_entry'
  | 'missing_description' | 'unmatched_fx_credit'
  | 'duplicate'
  | 'redemption_reconciled' // Wykup certyfikatów / Rozliczenie oferty — obsłużone przez reconciliation jako synthetic sell
  | 'unknown_operation_type' // Nierozpoznany tytuł operacji — wrzucone jako 'other', ale raportowane w warnings
  | 'unparseable_fx_comment' // XTB Transfer — brak pary walutowej + kursu w Comment
  | 'invalid_fx_rate'        // XTB Transfer — Exchange rate ≤ 0 w Comment
  | 'fx_currency_mismatch';  // XTB Transfer — ani fromCur ani toCur nie zgadza się z walutą konta

export interface SkippedRow {
  row: number;
  reason: SkipReason;
  paperName?: string;
}

export interface ParseResult<T> {
  data: T[];
  skipped: SkippedRow[];
}

/**
 * Marker subskrypcji IPO z nadpłatą — Bossa zapisuje parę wierszy w pliku operacji:
 *   Zapisy na akcje X SERIA Y          -MAX_AMOUNT (withdrawal, subskrypcja maksymalna)
 *   Zwrot nadpłaty X                   +REFUND      (deposit, nadpłata po alokacji)
 * Netto koszt = |zapisy| − refund. Akcje NIE pojawiają się jako K w hisPW.
 * Reconciliation tworzy syntetyczną K na dacie `allocationDate` (data Zwrotu nadpłaty).
 */
export interface IpoSubscriptionMarker {
  /** Data wiersza `Zapisy na akcje` (ISO YYYY-MM-DD). */
  subscriptionDate: string;
  /** Data wiersza `Zwrot nadpłaty` — używana jako data syntetycznej K transakcji. */
  allocationDate: string;
  /** Ticker z pliku Bossy (może mieć suffix `_IPO`). */
  ticker: string;
  /** ISIN z mapy `ipo-subscriptions-map`. */
  isin: string;
  /** Cena emisyjna per akcja (z mapy). */
  ipoPrice: number;
  /** |zapisy.amount| = kwota zablokowana przy subskrypcji maksymalnej. */
  subscriptionAmount: number;
  /** zwrot.amount = nadpłata oddana przez brokera. */
  refundAmount: number;
  /** Currency (zawsze PLN dla Bossa IKE/IKZE). */
  currency: string;
  /** Seria akcji (opcjonalnie). */
  series?: string;
  /** URL źródłowy komunikatu ESPI. */
  sourceUrl?: string;
}

/**
 * Marker dla operacji domykających otwartą pozycję (wykup certyfikatów, wezwanie skupu).
 * Parser emituje listę takich markerów ZAMIAST CashOperation — reconciliation w service
 * tworzy z nich syntetyczną sprzedaż, eliminując ryzyko double-count (deposit + synthetic sell).
 */
export interface RedemptionMarker {
  date: string; // ISO 8601
  ticker: string;
  amount: number; // brutto cashflow z wykupu/wezwania
  commission: number; // sparowana prowizja (np. `Rozliczenie oferty - prowizja TICKER`)
  description: string;
  currency: string;
  source: 'bossa'; // na razie tylko Bossa; jeśli DEGIRO dostanie analogiczny wzorzec — rozszerzyć
  /**
   * Typ wydarzenia:
   * - 'certificate' — wykup certyfikatów (all-or-nothing, reconciliation zamyka pełne openQty)
   * - 'tender'      — wezwanie skupu (qty = amount / tenderPrice; wymaga ceny z mapy)
   */
  kind: 'certificate' | 'tender';
  /** Cena per akcja (PLN) — wymagana dla `kind === 'tender'`, niewykorzystywana dla 'certificate'. */
  tenderPrice?: number;
  /** URL źródłowy komunikatu ESPI (dla 'tender' z mapy) — pokazywany w tooltipie. */
  sourceUrl?: string;
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

export interface OrphanedSell {
  paperName: string;
  isin: string;
  ticker: string;
  missingQuantity: number;
  firstSellDate: string;
  currency: string;
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
  duplicatesSkipped?: number;
  orphanedSells?: OrphanedSell[];
  /** Parser-level warnings (np. XTB missing Closed Positions sheet) */
  warnings?: string[];
  /** Cross-file validation warnings from the bulk reconciliation step */
  crossFileWarnings?: string[];
  /** DEGIRO: liczba transakcji, do których zaaplikowano stamp duty / french tax z pliku Account */
  taxesApplied?: number;
  /** Bossa: liczba syntetycznych sprzedaży wygenerowanych przez reconcileRedemptions */
  syntheticSells?: number;
  /** Detected broker for transactions file */
  detectedSource?: string;
  /** Detected broker for operations file (bulk import, może się różnić) */
  detectedOperationsSource?: string;
}

/** Result of POST /api/import/detect — used by UI to decide if second dropzone is needed */
export interface DetectResult {
  broker: BrokerType | null;
  fileRole: 'transactions' | 'operations' | 'unknown';
  /** Whether this broker requires an operations file for full import */
  requiresOperationsFile: boolean;
}

// ============ Portfolio Management ============

export interface PortfolioSettings {
  isIKE: boolean;
  isIKZE: boolean;
  ikzeIsDG: boolean; // działalność gospodarcza
  commissionPl: number;         // prowizja GPW w % (np. 0.39)
  commissionForeign: number;    // prowizja zagraniczne w % (np. 0.29)
  minCommissionPl: number;      // minimalna prowizja GPW w PLN
  minCommissionForeign: number; // minimalna prowizja zagraniczne
}

export const DEFAULT_PORTFOLIO_SETTINGS: PortfolioSettings = {
  isIKE: false,
  isIKZE: false,
  ikzeIsDG: false,
  commissionPl: 0,
  commissionForeign: 0,
  minCommissionPl: 0,
  minCommissionForeign: 0,
};

export interface Portfolio {
  id: string;
  name: string;
  createdAt: string;
  settings: PortfolioSettings;
  userId?: string; // owner (multi-tenancy)
}
