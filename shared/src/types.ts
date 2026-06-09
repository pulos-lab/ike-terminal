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
  swap?: number; // CFD: swap cost (from Closed Positions sheet)
  rollover?: number; // CFD: rollover cost (from Closed Positions sheet)
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

/**
 * Typ operacji gotówkowej.
 *
 * Dwa typy "zdarzenia korporacyjnego" zostały dodane po P17:
 * - `capital_return` — zwrot kapitału z istniejącej pozycji (obniżenie wartości nominalnej,
 *   korekta wykupu PW). Cash wpływa na konto, qty pozycji bez zmian. Dla MWR liczy się jak
 *   "zysk zrealizowany" (nie powiększa mianownika totalDeposited, ale wchodzi do totalValue),
 *   dla TWR jak "dywidenda" (portfolio value rośnie o amount, brak netCashFlow → return pozytywny).
 * - `corporate_action_pending` — zdarzenie wykryte ale niedomknięte (np. nieznane wezwanie
 *   skupu, nieznany wzorzec). Nie wchodzi do cashflow portfela dopóki user ręcznie nie domknie
 *   (tworzy synthetic SELL). Widoczne w panelu "Zdarzenia korporacyjne" z CTA "Domknij".
 */
export type OperationType =
  | 'deposit'
  | 'withdrawal'
  | 'dividend'
  | 'fx_exchange'
  | 'fee'
  | 'trade_fee'
  | 'commission_refund'
  | 'capital_return'
  | 'corporate_action_pending'
  | 'other';

/**
 * Subkategoria zdarzenia korporacyjnego (gdy `operationType` jest jednym z typów CA).
 *
 * - `nominal_reduction` — obniżenie wartości nominalnej akcji (np. GETIN 2022-12-30).
 *   Kapitał zwracany bez zmiany liczby akcji. MWR/TWR: liczy się jak zrealizowany zwrot.
 * - `redemption_adjustment` — "Wykup PW - wyrównanie TICKER", końcowa dopłata/korekta po
 *   wcześniejszym wykupie papieru wartościowego. Zwykle mała kwota, czasem ujemna.
 * - `unknown_tender` — "Rozliczenie oferty TICKER" z tickerem spoza `tender-offers-map`.
 *   Reconciliation nie potrafi wyliczyć qty/ceny → czeka na ręczne domknięcie przez user.
 * - `unknown_warrant` — "Wykup PW - wyrównanie TICKER" bez kontekstu wcześniejszego wykupu
 *   (wcześniej wpadał w `unknown → other`). Czeka na manualną klasyfikację.
 */
export type CashOperationSubkind =
  | 'nominal_reduction'
  | 'redemption_adjustment'
  | 'unknown_tender'
  | 'unknown_warrant'
  /**
   * `interest` — odsetki (od wolnych środków na rachunku brokerskim, lokaty overnight itp.).
   * Używane razem z `operationType='other'` (nie `dividend`, bo to nie zysk ze spółki).
   * Dodatni cashflow, zielony badge w panelu "Pozostałe przepływy". UI traktuje subkind
   * jako wirtualną kategorię ("Odsetki") żeby odróżnić od innych `other`.
   */
  | 'interest';

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
  /** Opcjonalna subkategoria — używana gdy `operationType` ∈ { capital_return, corporate_action_pending }. */
  subkind?: CashOperationSubkind;
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
  supersector?: string;
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
  description?: string;
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
  /** Suma zwrotów kapitałowych (capital_return) w walucie bazowej portfela.
   *  Osobna metryka obok dywidend — GETIN obniżenie nominału, wyrównania PW itp.
   *  Wchodzi do totalValue (cash na koncie) ale NIE do totalDeposited (nie jest wpłatą). */
  totalCapitalReturn: number;
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
  /** **Główna metryka**: wpływ walut jako % WARTOŚCI CAŁEGO PORTFELA w PLN.
   *  Intuicyjne: "o ile portfel urósł/spadł dzięki zmianom FX".
   *  Mała wartość jeśli obca część to tylko mały wycinek portfela. */
  fxImpactPct: number;
  /** Wpływ walut jako % EKSPOZYCJI ZAGRANICZNEJ (tylko obce waluty).
   *  Pokazuje "ile ruszyła sama walutowa część" — większa liczba niż
   *  fxImpactPct jeśli obce waluty to tylko kawałek portfela. */
  fxImpactPctOfForeign: number;
  /** Łączna kwota w PLN — suma per-currency impactów. */
  fxImpactPln: number;
  /** Łączna ekspozycja na obce waluty w PLN (suma exposurePln z breakdown). */
  foreignExposurePln: number;
  /** Jaki % portfela stanowi część zagraniczna (obce waluty łącznie). */
  foreignExposurePctOfPortfolio: number;
  /** Wartość całego portfela w PLN (baza do liczenia % portfela). */
  totalPortfolioValuePln: number;
  /** Rozkład per waluta obca (USD, EUR, …). */
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
  /** Jaki % całego portfela stanowi ta waluta (exposurePln / totalPortfolio). */
  exposurePctOfPortfolio: number;
  /** Średni ważony kurs PLN za 1 jednostkę waluty przy zakupach.
   *  `null` gdy waluta jest w portfelu (np. CSU.TO/CAD kupione przez Bossa za PLN),
   *  ale brak operacji `fx_exchange`/`deposit` z fxRate ani implied rate z Yahoo —
   *  ekspozycja jest znana, ale kurs wejścia nie. Frontend pokazuje "brak danych". */
  avgPlnPerCurrency: number | null;
  /** Dzisiejszy kurs PLN za 1 jednostkę waluty. */
  todayPlnPerCurrency: number;
  /** Wpływ walut dla tej waluty w PLN (exposureNative × (today − avg)).
   *  0 gdy `avgPlnPerCurrency` jest null (impact niemożliwy do policzenia). */
  impactPln: number;
  /** Wpływ walut dla tej waluty jako % zmiany kursu (today/avg − 1).
   *  0 gdy `avgPlnPerCurrency` jest null. */
  impactPct: number;
  /** Łączna suma wydarzeń "zakupu" tej waluty (natywnie). */
  totalAcquiredNative: number;
}

// ============ Stock Split Types ============

export interface DetectedSplit {
  ticker: string;
  isin: string;
  date: string; // YYYY-MM-DD — date when split was detected/occurred
  ratio: number; // e.g. 25 for 25:1 split
  txPrice: number; // transaction price (pre-split)
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
  supersector?: string;
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
  /**
   * QUOTE currency — waluta notowania papieru. Opcjonalna; jeśli undefined, backend ustawia
   * z `ticker_map.currency`. Override stosuj tylko w wyjątkowych sytuacjach (np. auto-create).
   */
  currency?: string;
  /**
   * PAYMENT currency — waluta zakupu/rozliczenia (co broker zdjął z konta).
   * Gdy różna od `currency`, oznacza że broker dokonał przewalutowania.
   */
  paymentCurrency?: string;
  /** Kurs wymiany broker'a: 1 unit `currency` = `fxRate` × `paymentCurrency`. */
  fxRate?: number;
  category?: InstrumentCategory;
}

// ============ Import Parse Types ============

export type SkipReason =
  | 'missing_date'
  | 'missing_isin'
  | 'missing_name'
  | 'invalid_side'
  | 'invalid_quantity'
  | 'invalid_price'
  | 'invalid_date'
  | 'corporate_action'
  | 'short_row'
  | 'zero_amount'
  | 'settlement_record'
  | 'summary_row'
  | 'unparseable_comment'
  | 'close_trade_entry'
  | 'missing_description'
  | 'unmatched_fx_credit'
  | 'duplicate'
  | 'redemption_reconciled' // Wykup certyfikatów / Rozliczenie oferty — obsłużone przez reconciliation jako synthetic sell
  | 'capital_return_reconciled' // Obniżenie nominału / wyrównanie — obsłużone przez reconciliation jako CashOperation(capital_return)
  | 'unknown_operation_type' // Nierozpoznany tytuł operacji — wrzucone jako 'other', ale raportowane w warnings
  | 'unparseable_fx_comment' // XTB Transfer — brak pary walutowej + kursu w Comment
  | 'invalid_fx_rate' // XTB Transfer — Exchange rate ≤ 0 w Comment
  | 'fx_currency_mismatch'; // XTB Transfer — ani fromCur ani toCur nie zgadza się z walutą konta

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
 * Marker zwrotu kapitału z istniejącej pozycji — obniżenie wartości nominalnej, korekta wykupu.
 *
 * RÓŻNICA w stosunku do `RedemptionMarker`:
 *  - RedemptionMarker emituje synthetic SELL → qty pozycji spada, cash rośnie z proceeds.
 *  - CapitalReturnMarker emituje tylko CashOperation(type='capital_return') → qty pozycji
 *    się NIE zmienia, cash rośnie, a engine traktuje to jak "dywidendę w kapitale" (wchodzi
 *    do totalValue ale nie do totalDeposited / nie jako netCashFlow dla TWR).
 *
 * Typowy przykład (dane z Bossa IKE): "Obniżenie wartości nominalnej GETIN" — emitent obniża
 * nominał akcji i zwraca różnicę akcjonariuszom. Akcji jest dalej tyle samo, ale użytkownik
 * otrzymuje gotówkę. To NIE jest ani dywidenda (nie z zysku, tylko z kapitału), ani sprzedaż
 * (qty bez zmian), ani wpłata (pochodzi z trzymanej pozycji).
 *
 * Parser emituje te markery w pre-scanie; reconciliation w import-service wstawia je do
 * `cash_operations` jako operationType='capital_return' + subkind=marker.kind.
 */
export interface CapitalReturnMarker {
  /**
   * Rodzaj zwrotu kapitału:
   * - 'nominal_reduction' — obniżenie wartości nominalnej (bez zmiany qty akcji).
   * - 'redemption_adjustment' — "Wykup PW - wyrównanie" (korekta po wcześniejszym wykupie).
   */
  kind: 'nominal_reduction' | 'redemption_adjustment';
  date: string; // ISO 8601
  ticker: string;
  amount: number; // dodatni (wpływ gotówki) lub ujemny (korekta w drugą stronę)
  currency: string;
  source: 'bossa'; // rozszerzymy gdy inni brokerzy pokażą podobne eventy
  /** Ludzki opis (z humanizeDescription) — pokazywany w UI. */
  description: string;
  /** Oryginalny tytuł z CSV — przydatne do debugu. */
  originalTitle: string;
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
  commissionPl: number; // prowizja GPW w % (np. 0.39)
  commissionForeign: number; // prowizja zagraniczne w % (np. 0.29)
  minCommissionPl: number; // minimalna prowizja GPW w PLN
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
