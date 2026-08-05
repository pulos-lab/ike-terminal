// ============ Broker Types ============

export type BrokerType =
  | 'auto'
  | 'bossa'
  | 'mbank'
  | 'degiro'
  | 'xtb'
  | 'ibkr'
  | 'trading212'
  | 'generic';

export const BROKER_LABELS: Record<BrokerType, string> = {
  auto: 'Wykryj automatycznie',
  bossa: 'Bossa',
  mbank: 'mBank eMakler',
  degiro: 'DEGIRO',
  xtb: 'XTB',
  ibkr: 'Interactive Brokers',
  trading212: 'Trading 212',
  generic: 'Inny broker (profil)',
};

/**
 * Źródło rekordu w bazie. 'generic' = import uniwersalny (silnik profili) —
 * etykieta brokera żyje wtedy w profilu (brokerLabel), nie w source.
 */
export type RecordSource =
  | 'bossa'
  | 'mbank'
  | 'degiro'
  | 'xtb'
  | 'ibkr'
  | 'trading212'
  | 'manual'
  | 'auto-yahoo'
  | 'auto-interest' // odsetki naliczone przez interest-scanner (oprocentowanie wolnych środków)
  | 'generic';

// ============ Transaction Types ============

export type InstrumentCategory = 'stock' | 'etf' | 'cfd' | 'bond' | 'option';

// ============ Option Types ============

/**
 * Metadane kontraktu opcyjnego. Instrument identyfikowany pseudo-ISIN-em `OPT:{ticker OCC}`
 * (opcje giełdowe nie mają ISIN); parametry kontraktu trzymane w tabeli `option_contracts`
 * (nie w `transactions` — są per kontrakt, nie per transakcja).
 */
export interface OptionContract {
  /** Pseudo-ISIN: `OPT:` + ticker OCC, np. "OPT:DKNG220520P00045000". */
  isin: string;
  /** Ticker w formacie OCC (SYMBOL + YYMMDD + C/P + strike×1000 pad 8), np. "DKNG220520P00045000". Yahoo v8 chart przyjmuje go wprost. */
  occTicker: string;
  /** Ticker instrumentu bazowego, np. "DKNG". */
  underlying: string;
  /** Data wygaśnięcia YYYY-MM-DD. */
  expiry: string;
  /** Cena wykonania w walucie kontraktu. */
  strike: number;
  /** C = call, P = put. */
  optionType: 'C' | 'P';
  /** Mnożnik kontraktu (US equity options: 100). */
  multiplier: number;
  /** Giełda notowania z wyciągu brokera (np. "CBOE", "DTB" dla Eurex). */
  listingExch?: string;
  currency: string;
}

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
  /**
   * Kurs wymiany rozliczenia: 1 jednostka `currency` (quote) = fxRate × `paymentCurrency`
   * (np. quote USD, payment PLN → fxRate ≈ 4.00). Kanoniczna konwencja w całym repo
   * ("payment per quote") — konsumują ją payment-currency-reconciler (total × fxRate = kwota
   * w paymentCurrency), TradesFeed i AddTransactionDialog. Parsery zapisujące kurs z pliku
   * brokera w odwrotnej konwencji (DEGIRO "Kurs wymiany" = quote per payment) MUSZĄ go
   * odwrócić przed zapisem.
   */
  fxRate?: number;
  category?: InstrumentCategory;
  source: RecordSource;
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
  /**
   * Transakcja powstała z przypisania (`assignment`) lub wykonania (`exercise`) opcji —
   * akcje zaksięgowane po cenie wykonania (strike), NIE po rynku. Ustawiane z kodów IBKR
   * ('A'/'Ex') przy imporcie lub backfillem. Wpływa na wycenę (nie nadpisujemy kursu
   * rynkowego ceną strike) i UI (badge „przypisanie"/„wykonanie").
   */
  optionEvent?: 'assignment' | 'exercise';
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
  | 'interest'
  /**
   * `coupon` — kupon/odsetki od obligacji (Catalyst). Używane razem z `operationType='dividend'`:
   * ekonomicznie to przychód z trzymanej pozycji, więc wchodzi do totalDividends i panelu
   * Dywidendy (z badge "Kupon"). NIE mylić z `interest` (odsetki od salda gotówki, bez pozycji).
   */
  | 'coupon'
  /**
   * Subkategorie kosztów brokera (operationType='fee', import IBKR) — napędzają grupowanie
   * kafli w panelu "Korekty i koszty". Silnik traktuje je jak zwykłe `fee` (cash tak, MWR nie).
   * - `margin_interest` — odsetki od kredytu margin (Investment/Debit Loan Interest)
   * - `borrow_fee` — koszt pożyczenia akcji pod krótką pozycję (Stock/USD Borrow Fees)
   * - `market_data` — subskrypcje danych rynkowych (NYSE Level I, Snapshot itd.)
   * - `fx_commission` — prowizje przewalutowań (IdealFX)
   * - `sales_tax` — VAT od opłat/prowizji (w wyciągu IBKR tylko agregat z Cash Report)
   * - `lending_income` — przychód/koszt programu pożyczania akcji (SYEP); przychód idzie
   *   z operationType='other' (dodatni cashflow), koszty z 'fee'
   */
  | 'margin_interest'
  | 'borrow_fee'
  | 'market_data'
  | 'fx_commission'
  | 'sales_tax'
  | 'lending_income';

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
  source: RecordSource;
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
  /** Kraj siedziby z ticker_map (EN, np. "United States") — patrz country-region-map. */
  country?: string;
  dailyChangePct: number | null;
  category?: InstrumentCategory;
  buyLots?: OpenBuyLot[];
  /** true when price comes from last transaction, not live market data */
  priceManual?: boolean;
  /**
   * ISO — moment pobrania ceny, gdy pochodzi z zapisanego notowania (ostatnia
   * cena widziana z rynku, użyta bo źródło milczy). Pozwala UI powiedzieć
   * „kurs z 01.08 17:05" zamiast samego „ręczna". Brak pola = cena live.
   */
  priceAsOf?: string;
  /**
   * Obligacja po terminie wykupu (maturityDate z bond-map < dziś) a pozycja wciąż otwarta —
   * najpewniej brakuje operacji wykupu w zaimportowanych plikach. UI pokazuje ostrzeżenie.
   */
  maturityPassed?: boolean;
  /**
   * Metadane kontraktu dla pozycji z category='option' (z tabeli `option_contracts`).
   * `shares` może być ujemne (pozycja krótka — wystawiona opcja); `currentValue` jest wtedy
   * ujemna (zobowiązanie odkupu).
   */
  optionMeta?: Pick<
    OptionContract,
    'underlying' | 'expiry' | 'strike' | 'optionType' | 'multiplier'
  >;
  /**
   * Opcja po dacie wygaśnięcia a pozycja wciąż otwarta — najpewniej brakuje wiersza
   * zamykającego (expiry/assignment) w zaimportowanych plikach. Analogiczne do maturityPassed.
   */
  expiryPassed?: boolean;
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
  sellSource: RecordSource;
  category?: InstrumentCategory;
  fees?: ClosedTradeFee[];
  totalCost?: number;
  isShort?: boolean;
  /**
   * Zaangażowany kapitał w walucie instrumentu: qty × buyPrice × bondMult + prowizja
   * otwarcia (dla short: wartość otwarcia shorta; dla CFD z cfdGrossProfit: notional).
   * Mianownik dla zagregowanego P/L% — w przeciwieństwie do buyPrice × qty po stronie
   * klienta uwzględnia nominał obligacji i mnożnik kontraktu CFD.
   */
  costBasis?: number;
  /**
   * P/L zrealizowany w PLN: przychód po kursie z dnia zamknięcia, koszt po kursie
   * z dnia otwarcia (zawiera więc efekt walutowy na kapitale). Dla PLN = profitLoss.
   * undefined gdy brak danych kursowych dla którejś z dat.
   */
  profitLossPln?: number;
  /** costBasis po kursie z dnia otwarcia pozycji. Dla PLN = costBasis. */
  costBasisPln?: number;
  /**
   * Kurs waluta→PLN użyty dla nogi otwarcia (1 dla PLN). computeClosedTrades
   * wstępnie ustawia DOKŁADNY kurs rozliczenia brokera z nogi transakcji
   * (tx.fxRate przy paymentCurrency=PLN, np. implied rate XTB z kwot);
   * convertClosedTradesToPln uzupełnia brakujące dziennym kursem rynkowym.
   */
  fxRateOpen?: number;
  /** Kurs waluta→PLN użyty dla nogi zamknięcia (1 dla PLN). Źródła jak fxRateOpen. */
  fxRateClose?: number;
  /**
   * Identyfikator round-tripu (epizodu pozycji flat→flat). Wszystkie nogi jednego cyklu
   * otwarcie → pełne zamknięcie dzielą ten sam id. Dzięki temu partial fille jednego zlecenia
   * oraz dokupienia/odsprzedaże tej samej pozycji liczą się jako JEDNA transakcja w win rate
   * i są zwijane do jednego wiersza w UI. Nowy epizod zaczyna się, gdy pozycja otwiera się od zera.
   */
  tradeGroupId?: string;
  /** true gdy round-trip nie wrócił jeszcze do zera (pozycja wciąż częściowo otwarta). */
  tradeGroupOpen?: boolean;
}

export interface DividendRecord {
  id: number;
  date: string;
  ticker: string;
  description: string;
  amount: number;
  currency: string;
  source: RecordSource;
  /** 'coupon' gdy rekord to kupon obligacji (operationType='dividend' + subkind='coupon'). */
  subkind?: 'coupon';
  /** Równowartość PLN po kursie z dnia wypłaty; null gdy brak kursu FX. */
  amountPln?: number | null;
  /**
   * ISIN instrumentu rozwiązany z tickera rekordu (dokładny ticker pozycji,
   * skrót GPW z transakcji Bossa albo nazwa z ticker_map) — do łączenia
   * dywidend z pozycjami (yield on cost). Null gdy nie udało się dopasować.
   */
  isin?: string | null;
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
  /** Stopa dywidendy instrumentu w PROCENTACH (np. 4.2 = 4,2%) — oba źródła znormalizowane. */
  dividendYield: number | null;
  /** Status z kalendarza GPW (stockwatch/biznesradar); brak dla źródła Yahoo. */
  status?: 'proponowana' | 'uchwalona' | 'wypłacona';
  /** Skąd pochodzi wpis: scrape'owany kalendarz GPW/NC czy Yahoo Finance. */
  source?: 'gpw-calendar' | 'yahoo';
}

/**
 * Jak pewny jest termin publikacji. Rozróżnienie jest widoczne w UI, bo alert „za 7 dni"
 * oparty na estymacie ±5 dni bez oznaczenia eroduje zaufanie do całej aplikacji.
 *  - `confirmed`  — spółka ogłosiła termin (PL: raport bieżący z terminami raportów
 *                   okresowych, obowiązkowy wg §84 rozporządzenia MF; US: Nasdaq podaje porę sesji),
 *  - `tentative`  — termin zapowiedziany, ale bez potwierdzenia pory / źródło nie gwarantuje,
 *  - `estimated`  — data wyliczona z historycznego rytmu raportowania, nie od spółki.
 */
export type EarningsConfidence = 'confirmed' | 'tentative' | 'estimated';

/** Pora publikacji względem sesji: before market open / after market close. */
export type EarningsSession = 'bmo' | 'amc' | 'unknown';

export type EarningsReportKind = 'quarterly' | 'semiannual' | 'annual';

export type EarningsSource = 'nasdaq' | 'bankier' | 'yahoo' | 'sec-estimate';

/**
 * Nadchodząca publikacja raportu okresowego dla pozycji w portfelu.
 *
 * `reportDate` to data KALENDARZOWA RYNKU EMITENTA — świadomie bez konwersji stref.
 * Publikacja `amc` (16:05 ET) wypada w Polsce nad ranem następnego dnia, ale przesuwanie
 * daty rozjechałoby nas z każdym serwisem, na którym użytkownik ją zweryfikuje; skutek
 * opisujemy słownie w tooltipie.
 */
export interface UpcomingEarnings {
  /** ISIN pozycji (dla opcji pseudo-ISIN `OPT:{OCC}`) — klucz mapy w UI. */
  isin: string;
  /** Ticker spółki RAPORTUJĄCEJ; dla opcji jest to spółka bazowa, nie ticker OCC. */
  ticker: string;
  /** YYYY-MM-DD w kalendarzu rynku emitenta. */
  reportDate: string;
  /** Dni do publikacji policzone serwerowo; klient i tak przelicza (patrz staleTime). */
  daysUntil: number;
  confidence: EarningsConfidence;
  session: EarningsSession | null;
  /** Surowa etykieta okresu ze źródła — „Q3 2026", „I półrocze 2026"; null gdy brak. */
  fiscalLabel: string | null;
  reportKind: EarningsReportKind | null;
  source: EarningsSource;
  /** true = pozycja opcyjna, termin dotyczy spółki bazowej. */
  viaUnderlying?: boolean;
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
 *  średnim kursem nabycia walut obcych AKTUALNIE trzymanych w portfelu.
 *
 *  Średni kurs liczony jest księgą walutową metodą średniej kroczącej
 *  (moving-average inventory): przepływy przekraczające granicę PLN↔X są
 *  przetwarzane chronologicznie — nabycia (wymiany, wpłaty, dywidendy,
 *  kupna rozliczane przez brokera z PLN) podnoszą saldo i koszt, rozchody
 *  (wymiany z powrotem, wypłaty, sprzedaże rozliczane do PLN) zdejmują
 *  saldo po bieżącej średniej i generują wynik ZREALIZOWANY. Dzięki temu
 *  waluta dawno wymieniona z powrotem na PLN nie zniekształca średniej
 *  dla obecnie trzymanego salda (dawniej: dożywotnia średnia wszystkich
 *  nabyć bez rozchodów).
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
  /** Łączna kwota w PLN — suma per-currency impactów (NIEZREALIZOWANY,
   *  na bieżącej ekspozycji). */
  fxImpactPln: number;
  /** ZREALIZOWANY wynik walutowy w PLN — suma per-currency realizedPln
   *  z rozchodów księgi (wymiany z powrotem na PLN, wypłaty, sprzedaże
   *  rozliczane do PLN). Osobno od fxImpactPln — nie wchodzi do głównej
   *  metryki %. Obejmuje tylko waluty z bieżącą ekspozycją > 0. */
  fxRealizedPln: number;
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
  /** Średni kurs PLN za 1 jednostkę waluty dla POZOSTAŁEGO salda księgi
   *  (średnia krocząca: rozchody zdejmują saldo po bieżącej średniej, więc
   *  waluta wymieniona z powrotem na PLN nie zniekształca kursu obecnych zasobów).
   *  `null` gdy waluta jest w portfelu (np. CSU.TO/CAD kupione przez Bossa za PLN),
   *  ale księga jest pusta — brak jakiegokolwiek wycenialnego przepływu nabycia.
   *  Frontend pokazuje "brak danych". */
  avgPlnPerCurrency: number | null;
  /** Dzisiejszy kurs PLN za 1 jednostkę waluty. */
  todayPlnPerCurrency: number;
  /** Wpływ walut dla tej waluty w PLN (exposureNative × (today − avg)).
   *  0 gdy `avgPlnPerCurrency` jest null (impact niemożliwy do policzenia). */
  impactPln: number;
  /** Wpływ walut dla tej waluty jako % zmiany kursu (today/avg − 1).
   *  0 gdy `avgPlnPerCurrency` jest null. */
  impactPct: number;
  /** Łączna suma wydarzeń "zakupu" tej waluty (natywnie) w całej historii —
   *  wliczając nabycia później rozchodowane. Diagnostyczne, nie do avg. */
  totalAcquiredNative: number;
  /** ZREALIZOWANY wynik walutowy tej waluty w PLN: Σ po rozchodach księgi
   *  `ilość × (kurs rozchodu − średnia w momencie rozchodu)`. 0 gdy brak
   *  rozchodów lub brak kursów rozchodu. */
  realizedPln: number;
}

/** Przepływ walutowy wynikający z TRANSAKCJI (nie CashOperation) — zasila księgę
 *  walutową computeFxImpact. Route buduje je z transakcji przekraczających granicę
 *  walut przy rozliczeniu:
 *  - Bossa Zagranica: tx w PLN na papierze kwotowanym w X → kwota natywna
 *    z historycznej ceny Yahoo (proxy), `pln` = tx.value;
 *  - XTB/DEGIRO z paymentCurrency: kurs brokera z tx.fxRate — dla rozliczeń
 *    w PLN `pln` dokładne; dla nóg X↔Y `pln` pominięte (silnik wycenia po
 *    historycznym kursie PLN z `historicalPlnRates`). */
export interface ImpliedFxFlow {
  /** Data transakcji (ISO; silnik używa części YYYY-MM-DD). */
  date: string;
  /** Waluta przepływu — uppercase, znormalizowana (GBX → GBP). */
  currency: string;
  /** Kwota natywna przepływu, zawsze > 0 (kierunek w `kind`). */
  amountNative: number;
  /** 'buy' = waluta weszła do ekspozycji, 'sell' = wyszła. */
  kind: 'buy' | 'sell';
  /** Dokładna kwota PLN zapłacona (buy) / otrzymana (sell), gdy znana.
   *  Brak → silnik wycenia amountNative po historycznym kursie z dnia. */
  pln?: number;
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
  /**
   * Kandydat z proporcji ceny wyraźnie splitowej, ale o ratio spoza listy „znanych"
   * (np. 1:12 Paysafe, 12:1). MUSI zostać potwierdzony zdarzeniem split z Yahoo w
   * resolveSplitEventDates; bez potwierdzenia jest odrzucany (może być crash/rally,
   * nie split). Zwykłe wykrycia (znane ratio) tego nie wymagają.
   */
  needsConfirmation?: boolean;
}

// ============ Ticker Map Types ============

export interface TickerMapEntry {
  isin: string;
  ticker: string;
  name: string;
  exchange: 'GPW' | 'NC' | 'CATALYST' | 'NYSE' | 'NASDAQ' | 'TSX' | 'XETRA' | 'OTHER';
  currency: string;
  priceSource: 'yahoo' | 'stooq' | 'auto';
  sector?: string;
  supersector?: string;
  /** Kraj siedziby spółki (kanoniczna angielska nazwa z Yahoo assetProfile.country,
   *  np. "United States"; GPW/NC/Catalyst → "Poland"). Źródło wykresu „Regiony". */
  country?: string;
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

// ============ Spin-off Types ============

/**
 * Spin-off zastosowany (lub świadomie pominięty) w danym portfelu — wiersz tabeli
 * `spin_offs`. Zamrożony jest WYŁĄCZNIE `allocationPct` (+ ceny audytowe) — jedyna
 * wielkość zależna od cen rynkowych, więc późniejsze zmiany cache'u cen nie mogą
 * wstecznie zmienić wyniku. Ilości silnik wylicza na bieżąco z transakcji
 * (edycje historii rodzica propagują się poprawnie); `childQty` to audyt/UI.
 */
export interface AppliedSpinOff {
  id?: number;
  parentIsin: string;
  parentTicker: string;
  childIsin: string;
  childTicker: string;
  childName?: string;
  /** ISO YYYY-MM-DD — ex/distribution date. */
  exDate: string;
  /** Liczba akcji dziecka za 1 akcję rodzica. */
  ratio: number;
  /** ZAMROŻONY udział kosztu rodzica przeniesiony na dziecko (0..1). */
  allocationPct: number;
  /** Ilość dziecka w chwili zastosowania (audyt/dedup/UI; silnik liczy na żywo). */
  childQty: number;
  /** Waluta lotów rodzica (dla opisu; przy mieszanych walutach — dominująca). */
  currency: string;
  /** Audyt: cena rodzica użyta do alokacji (post-ex close lub pre-ex fallback). */
  parentPriceUsed?: number;
  /** Audyt: pierwsza cena notowań dziecka użyta do alokacji. */
  childPriceUsed?: number;
  /**
   * applied — syntetyczna pozycja dziecka aktywna;
   * skipped_broker — broker sam zaksięgował akcje dziecka (realne wiersze wygrywają);
   * reverted — cofnięty przez użytkownika (tombstone blokujący ponowną auto-aplikację).
   */
  status: 'applied' | 'skipped_broker' | 'reverted';
  source: 'map' | 'table' | 'manual';
  appliedAt?: string;
}

// ============ Price Types ============

/**
 * Pojedynczy wpis z GET /api/prices/live. `price` jest null gdy fetch z
 * Yahoo/Stooq się nie powiódł — UI pokazuje wtedy "—" zamiast udawanej ceny.
 * `previousClose` jest obecne tylko dla źródła Yahoo (Stooq go nie zwraca).
 */
export interface LivePrice {
  price: number | null;
  currency: string;
  previousClose?: number | null;
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
  /**
   * Parametry kontraktu — wymagane gdy `category === 'option'`. Backend generuje z nich
   * ticker OCC + pseudo-ISIN `OPT:{OCC}` i zapisuje kontrakt w `option_contracts`
   * (identycznie jak import IBKR). `ticker` w body jest wtedy ignorowany.
   * Cena transakcji = premia per akcja; wartość = qty × premia × multiplier.
   */
  option?: {
    underlying: string;
    strike: number;
    /** YYYY-MM-DD */
    expiry: string;
    optionType: 'C' | 'P';
    /** Domyślnie 100. */
    multiplier?: number;
  };
  /**
   * Potwierdzenie użytkownika, że świadomie dodaje transakcję na walor będący
   * dzieckiem zastosowanego spin-offu (pozycja mogła już powstać automatycznie).
   * Bez tego pola serwer odpowiada `{ requiresConfirmation: true, warning }`.
   */
  confirmSpinOff?: boolean;
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
  | 'unknown_type' // XTB — typ operacji spoza znanych typów parsera, wiersz pominięty (paperName zawiera nazwę typu)
  | 'unparseable_fx_comment' // XTB Transfer — brak pary walutowej + kursu w Comment
  | 'invalid_fx_rate' // XTB Transfer — Exchange rate ≤ 0 w Comment
  | 'fx_currency_mismatch' // XTB Transfer — ani fromCur ani toCur nie zgadza się z walutą konta
  | 'value_mismatch' // import generyczny — wartość z CSV odbiega od qty×cena (podejrzane mapowanie kolumn)
  | 'column_shift' // wartości wiersza nie pasują do kolumn formatu (np. dodatkowy separator w polu) — szczegóły z surową treścią wiersza w warnings
  | 'cancelled_trade' // IBKR — transakcja anulowana przez brokera (kod Ca), celowo pominięta
  | 'aliased_ignore'; // wiersz zignorowany zatwierdzonym aliasem typu (admin uznał typ za nieistotny)

/**
 * Powody kwalifikujące wiersz do skrzynki "Do wyjaśnienia" (kwarantanny).
 * Kwalifikacja jest podwójna: reason ∈ QUARANTINE_REASONS ORAZ parser dołączył
 * `SkippedRow.raw` — dzięki temu celowe skipy z tym samym reasonem (np. wiersze,
 * dla których parser świadomie nie zbiera surowej treści) nie trafiają do skrzynki.
 * Wykluczone celowo: wady danych (invalid_*, missing_*, short_row, zero_amount —
 * klasyfikacja użytkownika nic nie da), celowe pominięcia (duplicate, summary_row,
 * close_trade_entry, settlement_record, *_reconciled, corporate_action) oraz
 * problemy walidacyjne wymagające poprawy pliku (value_mismatch, column_shift,
 * fx_currency_mismatch, invalid_fx_rate, unmatched_fx_credit).
 */
export const QUARANTINE_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>([
  'unknown_type',
  'unknown_operation_type',
  'unparseable_comment',
  'unparseable_fx_comment',
]);

/** Best-effort podpowiedzi do prefillu dialogów ręcznego dodawania — parser
 * wyciąga co umie z surowego wiersza, UI kwarantanny nie parsuje komórek. */
export interface SkippedRowHint {
  /** ISO YYYY-MM-DD */
  date?: string;
  amount?: number;
  currency?: string;
  symbol?: string;
  description?: string;
}

/** Surowa treść pominiętego wiersza — trafia WYŁĄCZNIE do bazy portfela
 * użytkownika (skrzynka "Do wyjaśnienia"); do globalnej bazy zgłoszeń idzie
 * dopiero zredagowana próbka za jawnym kliknięciem użytkownika. */
export interface SkippedRowRaw {
  /** Znormalizowany surowy typ operacji: lower(trim(...)) — klucz mapy aliasów i zgłoszeń. */
  rawType?: string;
  /** Nagłówki tabeli źródłowej (równoległe do `cells`). */
  headers?: string[];
  /** Surowe komórki wiersza. */
  cells: string[];
  hint?: SkippedRowHint;
}

export interface SkippedRow {
  row: number;
  reason: SkipReason;
  paperName?: string;
  /** Obecność (wraz z reason ∈ QUARANTINE_REASONS) kwalifikuje wiersz do kwarantanny. */
  raw?: SkippedRowRaw;
}

export interface ParseResult<T> {
  data: T[];
  skipped: SkippedRow[];
  /** Ostrzeżenia parsera (po polsku) — import-service dokleja je do crossFileWarnings. */
  warnings?: string[];
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
   * - 'bond'        — wykup obligacji w terminie/częściowy (qty = round(amount / nominal),
   *                   cena syntetycznej S w % nominału — spójnie z kwotowaniem Catalyst)
   */
  kind: 'certificate' | 'tender' | 'bond';
  /** Cena per akcja (PLN) — wymagana dla `kind === 'tender'`, niewykorzystywana dla 'certificate'. */
  tenderPrice?: number;
  /** Wartość nominalna 1 obligacji (dla `kind === 'bond'`) — z bond-map, gdy znana parserowi. */
  nominal?: number;
  /** URL źródłowy komunikatu ESPI (dla 'tender' z mapy) — pokazywany w tooltipie. */
  sourceUrl?: string;
}

// ============ Bond Subscription (Zapisy na obligacje) ============

/**
 * Para "Zapisy na obligacje X" + "Zwrot nadpłaty X" z Bossa CSV.
 * Reconciliation tworzy z niej syntetyczną K transakcję obligacji.
 * Parser emituje marker WYŁĄCZNIE gdy rozliczenie jest wykonalne end-to-end
 * (emitent rozpoznany w bond-map, netto > 0, qty ≥ 1) — niewykonalna para
 * NIE jest konsumowana i oba wiersze zostają w cash flow jak dotychczas.
 */
export interface BondAllocationMarker {
  /** Data wiersza "Zapisy na obligacje" (ISO YYYY-MM-DD). */
  subscriptionDate: string;
  /** Data wiersza "Zwrot nadpłaty" — używana jako data syntetycznej K transakcji. */
  allocationDate: string;
  /** Ticker z bond-map (np. PRF0628). */
  ticker: string;
  /** ISIN z bond-map. */
  isin: string;
  /** Wartość nominalna 1 obligacji (z bond-map). */
  nominal: number;
  /** Liczba szt wyliczona przez parser: round(netto / nominal), zawsze ≥ 1. */
  quantity: number;
  /** Nazwa emitenta z tytułu CSV (np. "PRAGMAGO D4"). Zawsze obecna. */
  csvIssuerName: string;
  /** |zapisy.amount| = kwota zablokowana przy subskrypcji. */
  subscriptionAmount: number;
  /** zwrot.amount = nadpłata oddana przez brokera. */
  refundAmount: number;
  currency: string;
  source: 'bossa';
  rawSubscriptionTitle: string;
  rawRefundTitle: string;
}

// ============ API Response Types ============

export interface CashPosition {
  currency: string;
  balance: number;
  valuePln: number;
  weight: number;
}

/** Split z ostatnich 7 dni — GET /portfolio/positions zwraca je do notyfikacji UI. */
export interface RecentSplit {
  isin: string;
  ticker: string;
  date: string;
  ratio: number;
}

/** Ostrzeżenie POST /transactions: walor jest dzieckiem zastosowanego spin-offu. */
export interface SpinOffChildWarning {
  kind: 'spinoff_child';
  message: string;
  spinOff: {
    id?: number;
    parentTicker: string;
    childTicker: string;
    exDate: string;
    childQty: number;
  };
}

/**
 * Odpowiedź POST /portfolio/transactions: `{ id }` przy zapisie albo
 * `{ requiresConfirmation, warning }` (HTTP 200) gdy walor jest dzieckiem
 * spin-offu a request nie miał `confirmSpinOff` — retry z flagą przechodzi.
 */
export type CreateTransactionResult =
  | { id: number; requiresConfirmation?: undefined }
  | { requiresConfirmation: true; warning: SpinOffChildWarning };

/**
 * Spin-off wykryty przez scraper, ale czekający na ratio dystrybucji z SEC —
 * sygnalizowany przy rodzicu w portfelu ("czekam na ratio"), bez akcji usera.
 */
export interface PendingRatioSpinOff {
  parentTicker: string;
  childTicker: string;
  exDate: string;
}

/** Spin-off z ostatnich 30 dni — GET /portfolio/positions zwraca do notyfikacji UI. */
export interface RecentSpinOff {
  parentIsin: string;
  parentTicker: string;
  childIsin: string;
  childTicker: string;
  exDate: string;
  ratio: number;
  /** Udział kosztu rodzica przeniesiony na dziecko (0..1) — do tekstu tooltipa. */
  allocationPct: number;
}

export interface PortfolioPositionsResponse {
  positions: Position[];
  cashPositions: CashPosition[];
  totalValuePln: number;
  stocksValuePln: number;
  cashValuePln: number;
  recentSplits: RecentSplit[];
  recentSpinOffs: RecentSpinOff[];
  /** Wykryte spin-offy rodziców z portfela czekające na ratio z SEC. */
  pendingRatioSpinOffs: PendingRatioSpinOff[];
  /**
   * Nadchodzące publikacje wyników dla pozycji (okno D+0..D+45; UI zapala ikonę od D−7).
   * Puste przy awarii źródeł — kalendarz NIGDY nie wywraca widoku portfela.
   * Celowo NIE trafia do widoku publicznego (whitelist w `share-redaction.ts`).
   */
  upcomingEarnings: UpcomingEarnings[];
  /** Waluta bazowa portfela (np. 'PLN' dla Bossa, 'USD' dla XTB USD sub-account). */
  baseCurrency: string;
  /**
   * Świeżość notowań, na których policzono ten widok. Klient używa
   * `nextRefreshAt` jako tempa odpytywania (zamiast sztywnego interwału, który
   * nie miał związku z TTL serwera), a `asOf`/`marketOpen` do nagłówka
   * „Kursy z 17:32 · rynek zamknięty".
   */
  quotes?: {
    /** ISO najświeższego notowania w zestawie; null gdy źródła nie podały czasu. */
    asOf: string | null;
    /** ISO — najwcześniejszy moment, w którym cokolwiek może się zmienić. */
    nextRefreshAt: string;
    /** Czy którykolwiek rynek portfela jest w trakcie sesji. */
    marketOpen: boolean;
  };
}

// ============ Option Greeks ============

/**
 * Greeki opcji SKALOWANE DO POZYCJI (× mnożnik × liczba kontraktów, ze znakiem shares):
 * delta/gamma = ekwiwalent akcji bazowych; theta/vega/rho = w WALUCIE OPCJI (upływ dnia /
 * +1pp IV / +1pp stopy). `iv` to zmienność implikowana KONTRAKTU (ułamek), nie skalowana.
 */
export interface OptionGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  iv: number;
}

export interface PositionGreeks {
  isin: string;
  underlying: string;
  /** waluta kwotowania greeków money (theta/vega/rho) */
  currency: string;
  /** dni do wygaśnięcia */
  dte: number;
  moneyness: 'ITM' | 'ATM' | 'OTM';
  /** wg żywej ceny opcji + kursu bazowego; null gdy nie da się wyznaczyć IV */
  current: OptionGreeks | null;
  /** wg premii transakcji + kursu bazowego z dnia zakupu; null gdy brak danych */
  atPurchase: (OptionGreeks & { date: string }) | null;
}

/** Agregat netto portfela opcji (delta/gamma = ekwiwalent akcji, theta/vega/rho = money). */
export interface GreeksNet {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

export interface PortfolioGreeksResponse {
  positions: PositionGreeks[];
  /** Waluta agregatu netto: wspólna waluta opcji, albo 'PLN' gdy portfel miesza waluty. */
  net: { current: GreeksNet; atPurchase: GreeksNet; currency: string };
  asOf: string;
}

export interface PortfolioHistoryResponse {
  history: PortfolioHistoryPoint[];
  metrics: PortfolioMetrics;
  /** Waluta bazowa portfela — history/metrics są liczone w tej walucie. */
  baseCurrency: string;
  /**
   * Roczna stopa wolna od ryzyka w PROCENTACH (rentowność UST ~1Y z risk-free-rate;
   * przybliżenie dla portfeli PLN) — do Sharpe/Sortino/alfa po stronie klienta.
   */
  riskFreeRatePct: number;
}

/**
 * Metryki ryzyko–zwrot jednego instrumentu z ~rocznej historii cen
 * (cache price_history.db, bez sieci). Zwrot w walucie NOTOWANIA instrumentu
 * (czysty risk instrumentu, bez wpływu FX). Klient łączy z pozycjami
 * (waga/nazwa) z GET /positions — endpoint nie przelicza silnika pozycji.
 */
export interface RiskReturnMetric {
  ticker: string;
  /** Zwrot ceny za dostępny okres (%, do ~1Y). */
  returnPct: number;
  /** Annualizowana zmienność dziennych zwrotów (%, √252). */
  volatilityPct: number;
  /** Liczba punktów historii użytych do obliczeń. */
  dataPoints: number;
}

/**
 * Punkt odniesienia na mapie ryzyko–zwrot: cały portfel (z indeksu TWR,
 * PLN-znormalizowany) albo benchmark (WIG = indeks dochodowy w PLN,
 * S&P 500 = cenowy w USD — ta sama konwencja walutowa co punkty pozycji).
 */
export interface RiskReturnRefPoint {
  key: 'portfolio' | 'wig' | 'sp500';
  label: string;
  returnPct: number;
  volatilityPct: number;
  dataPoints: number;
  currency: string;
}

/** POST /portfolio/risk-return — body: { tickers: string[] }. */
export interface RiskReturnResponse {
  metrics: RiskReturnMetric[];
  /** Tickery pominięte z powodu zbyt krótkiej historii w cache (dla przejrzystości UI). */
  skipped: string[];
  /** Początek okna analizy (ISO) — ~12 miesięcy wstecz. */
  since: string;
  /** Punkty odniesienia: portfel + WIG + S&P 500 (pomijane gdy brak danych). */
  references: RiskReturnRefPoint[];
}

/**
 * GET /portfolio/metrics — celowo NIE jest PortfolioMetrics: endpoint pomija
 * `totalCapitalReturn` (UI topbara go nie pokazuje) i dokłada `baseCurrency`
 * oraz `fxImpact`. `currentValue`/`totalReturn` mogą być nadpisane wyceną LIVE
 * (spójność z panelem Portfel), XIRR zostaje z historii close-of-day.
 */
/**
 * Zalewarowanie portfela (konto margin / krótkie pozycje). Wskaźnik księgowy
 * liczony z transakcji — NIE odzwierciedla wymogów depozytowych brokera
 * (buying power / excess liquidity), których nie znamy.
 */
export interface LeverageInfo {
  /** Pozycje brutto: Σ|wartość rynkowa pozycji| (long + |short|), w PLN. */
  grossExposurePln: number;
  /** Ekspozycja krótka: |Σ wartości pozycji short|, w PLN (0 gdy brak shortów). */
  shortExposurePln: number;
  /** Kapitał własny: pozycje netto + gotówka netto (= wartość portfela), w PLN. */
  equityPln: number;
  /** Kredyt margin: suma ujemnych sald gotówkowych, w PLN (dodatnia liczba). */
  marginDebtPln: number;
  /** Dźwignia = grossExposurePln / equityPln (1.0 = brak dźwigni). */
  ratio: number;
}

export interface PortfolioMetricsResponse {
  currentValue: number;
  totalInvested: number;
  xirr: number;
  totalReturn: number;
  totalReturnPct: number;
  totalDividends: number;
  /** Waluta bazowa portfela (np. 'PLN' dla Bossa, 'USD' dla XTB USD sub-account). */
  baseCurrency: string;
  /** null gdy portfel czysto PLN-owy lub brak danych o kursach wejścia. */
  fxImpact: FxImpact | null;
  /** null gdy kapitał własny ≤ 0 (dane niepełne) — UI pokazuje badge tylko przy realnej dźwigni. */
  leverage: LeverageInfo | null;
}

export interface ClosedTradesResponse {
  trades: ClosedTrade[];
}

/** Suma dywidend w jednej walucie + jej równowartość w PLN. */
export interface DividendCurrencyTotal {
  /** Kod waluty (PLN, USD, EUR, ...). */
  currency: string;
  /** Suma dywidend w tej walucie (kwota oryginalna). */
  amount: number;
  /** Równowartość w PLN po kursie z dnia każdej wypłaty; null gdy brak kursu FX. */
  pln: number | null;
}

export interface DividendsResponse {
  dividends: DividendRecord[];
  /** Łączna suma wszystkich dywidend przeliczona na PLN (kurs z dnia wypłaty per rekord). */
  totalPln: number;
  /** True gdy `totalPln` pomija rekordy bez dostępnego kursu FX (suma jest zaniżona). */
  totalPlnApprox: boolean;
  /** Rozbicie sum per waluta (oryginał + równowartość PLN), malejąco po wartości PLN. */
  byCurrency: DividendCurrencyTotal[];
}

/**
 * Transakcja wzbogacona przez GET /portfolio/transactions o dane z ticker_map:
 * ticker/name/exchange + znormalizowane currency (quote) i paymentCurrency
 * (zawsze ustawione — fallback do quote gdy brak przewalutowania).
 */
export interface TransactionWithMeta extends Transaction {
  ticker: string;
  name: string;
  exchange: string;
  paymentCurrency: string;
}

export interface TransactionsResponse {
  transactions: TransactionWithMeta[];
}

/** Pojedynczy wiersz z GET /portfolio/deposits (deposit + withdrawal w jednej liście). */
export interface DepositRecord {
  id: number;
  date: string;
  amount: number;
  currency: string;
  description: string;
  source: CashOperation['source'];
  type: 'deposit' | 'withdrawal';
}

export interface DepositsResponse {
  deposits: DepositRecord[];
  /** Suma surowych amount (withdrawals są ujemne) — bez konwersji walut. */
  total: number;
}

/** Pojedynczy wiersz z GET /portfolio/fees (legacy endpoint, UI używa additional-costs). */
export interface FeeRecord {
  id: number;
  date: string;
  amount: number;
  currency: string;
  description: string;
  source: CashOperation['source'];
}

export interface FeesResponse {
  fees: FeeRecord[];
  total: number;
}

export interface FxHistoryResponse {
  exchanges: FxExchangeRecord[];
}

/** Punkt wykresu z GET /portfolio/cash-flow — wartości w walucie bazowej portfela. */
export interface CashFlowChartPoint {
  date: string;
  portfolioValue: number;
  netCashFlow: number;
}

export interface CashFlowResponse {
  cashFlow: CashFlowRecord[];
  chartData: CashFlowChartPoint[];
  /** Waluta bazowa portfela — cashFlow/chartData są w tej walucie. */
  baseCurrency: string;
}

export interface SplitsResponse {
  splits: StockSplit[];
}

export interface ImportStatusResponse {
  transactions: number;
  operations: number;
  /** SQLite UTC timestamp 'YYYY-MM-DD HH:MM:SS' albo null gdy brak importów. */
  lastImportDate: string | null;
  /** Liczba wierszy oczekujących w skrzynce "Do wyjaśnienia". */
  quarantinePending: number;
  /** Liczba wykrytych sprzedaży bez kupna czekających na decyzję użytkownika. */
  orphanedSellsPending: number;
}

/** GET /api/import/orphaned-sells */
/**
 * Prośba o ponowne wgranie wyciągu — zakładana, gdy poprawka parsera nie może
 * odtworzyć danych z bazy, bo wiersze przy imporcie w ogóle nie powstały.
 */
export interface ReimportNotice {
  id: number;
  /** Broker, którego dotyczy (etykieta z BROKER_LABELS albo surowy identyfikator). */
  source: string;
  /** Krótkie „co się stało" — wyświetlane jako tytuł. */
  reason: string;
  /** Opcjonalne rozwinięcie: co dokładnie przepadło i co zrobić. */
  detail: string | null;
  createdAt: string;
}

export interface OrphanedSellsResponse {
  /** Oczekujące na decyzję (spin-off / Ignoruj). */
  pending: OrphanedSell[];
  /** Trwale zignorowane, ale wciąż wykrywane — hub pokazuje z opcją "Przywróć". */
  dismissed: OrphanedSell[];
}

/** GET /api/import/quarantine */
export interface QuarantineListResponse {
  rows: QuarantineRow[];
  counts: QuarantineCounts;
}

/** Kursy FX z GET /prices/live — dokładnie te pary, które serwer faktycznie wysyła. */
export interface LiveFxRates {
  USDPLN: number;
  CADPLN: number;
  EURPLN: number;
  GBPPLN: number;
}

export interface LivePricesResponse {
  prices: Record<string, LivePrice>;
  fx: LiveFxRates;
  timestamp: string;
}

/** GET /prices/instrument-history — historia kursu jednego instrumentu
 *  (wykres pozycji z markerami K/S). Zakres od pierwszej transakcji −30 dni. */
export interface InstrumentHistoryResponse {
  isin: string;
  ticker: string;
  name: string;
  currency: string;
  /** Faktycznie użyte źródło: 'yahoo' | 'biznesradar' | 'stooq'. */
  source: string;
  points: Array<{ date: string; close: number }>;
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
  /** Liczba wierszy NOWO dodanych do skrzynki "Do wyjaśnienia" w tym imporcie. */
  quarantined?: number;
}

// ============ Import Quarantine ("Do wyjaśnienia") ============

export type QuarantineStatus = 'pending' | 'resolved' | 'ignored' | 'reported';

/** Wiersz skrzynki "Do wyjaśnienia" — API GET /api/import/quarantine. */
export interface QuarantineRow {
  id: number;
  importBatch: string;
  /** BrokerType lub 'generic'. */
  source: string;
  fileName?: string;
  rowNum: number;
  reason: SkipReason;
  rawType?: string;
  headers?: string[];
  cells: string[];
  hint?: SkippedRowHint;
  status: QuarantineStatus;
  /** Dla status='resolved': gdzie wylądował wpis użytkownika. */
  resolutionKind?: 'transaction' | 'cash_operation';
  resolvedRefId?: number;
  userNote?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface QuarantineCounts {
  pending: number;
  resolved: number;
  ignored: number;
  reported: number;
}

// ============ Operation Type Aliases (mapa aliasów typów per broker) ============

/** Cel aliasu:
 *  - parser_type: podmiana na kanoniczny typ parsera (wiersz wchodzi w normalny
 *    dispatch z pełnym parsowaniem — np. 'dividend equivalent' → 'dividend');
 *  - cash_operation: bezpośrednia budowa CashOperation z surowego wiersza
 *    (typ bez logiki w parserze — np. bonus → other);
 *  - ignore: wiersz celowo pomijany (nieistotny — nie wraca do skrzynki). */
export type TypeAliasTargetKind = 'parser_type' | 'cash_operation' | 'ignore';

/** target_value dla kind='cash_operation' (JSON w DB). */
export interface CashOperationAliasTarget {
  operationType: OperationType;
  subkind?: string;
  /** Znak kwoty: 'file' = jak w pliku (domyślnie), '+'/'-' = wymuszony. */
  sign?: 'file' | '+' | '-';
}

export interface TypeAliasTarget {
  kind: TypeAliasTargetKind;
  /** parser_type: kanoniczny typ; cash_operation: JSON CashOperationAliasTarget; ignore: brak. */
  value?: string;
}

export type TypeAliasStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

/** Alias typu operacji (globalny, per broker) — zatwierdzany przez admina;
 * parser konsultuje mapę APPROVED przed oznaczeniem wiersza jako unknown. */
export interface OperationTypeAlias {
  id: number;
  broker: string;
  /** lower(trim(surowy typ z pliku)) — klucz mapy. */
  rawType: string;
  targetKind: TypeAliasTargetKind;
  targetValue?: string;
  status: TypeAliasStatus;
  createdAt: string;
  reviewedAt?: string;
  reviewNote?: string;
}

// ============ Unknown Type Reports (globalne zgłoszenia do admina) ============

/** classified = user sklasyfikował wiersz (sygnał: luka parsera);
 *  unsupported = "nie wiem / aplikacja tego nie obsługuje" (sygnał: feature-gap). */
export type UnknownTypeReportKind = 'classified' | 'unsupported';

export type UnknownTypeReportStatus = 'open' | 'approved' | 'rejected' | 'wont_fix';

export interface UnknownTypeReportSuggestion {
  /** Jak użytkownik sklasyfikował wiersz (np. 'dividend', 'cost') — dla kind='classified'. */
  classifiedAs?: string;
  note?: string;
  /** ISO timestamp zgłoszenia. */
  at: string;
}

/** Zagregowane zgłoszenie nieznanego typu operacji — jeden wiersz per
 * (broker, raw_type, kind); próbka ZREDAGOWANA przez sample-redactor. */
export interface UnknownTypeReport {
  id: number;
  broker: string;
  rawType: string;
  kind: UnknownTypeReportKind;
  headers?: string[];
  sampleCells?: string[];
  suggestions: UnknownTypeReportSuggestion[];
  reporterCount: number;
  occurrenceCount: number;
  status: UnknownTypeReportStatus;
  firstReportedAt: string;
  lastReportedAt: string;
  reviewNote?: string;
}

/** Result of POST /api/import/detect — used by UI to decide if second dropzone is needed */
export interface DetectResult {
  broker: BrokerType | null;
  fileRole: 'transactions' | 'operations' | 'unknown';
  /** Whether this broker requires an operations file for full import */
  requiresOperationsFile: boolean;
}

// ============ Portfolio Management ============

/**
 * Oprocentowanie wolnych środków — jedna stawka per waluta (stała w czasie,
 * edytowalna w ustawieniach portfela). Konsumowane przez `interest-scanner.ts`,
 * który miesięcznie dopisuje operacje `other`+`subkind:'interest'` do bazy.
 */
export interface FreeCashInterestRate {
  currency: string; // ISO 4217 uppercase (PLN, USD, EUR…)
  annualRatePct: number; // roczna stawka w % (np. 4 = 4% p.a.)
  /**
   * Maksymalne saldo (w tej walucie) objęte oprocentowaniem:
   * odsetki = min(max(saldo, 0), cap) × stawka. 0 / undefined = bez limitu.
   */
  cap?: number;
}

export interface PortfolioSettings {
  isIKE: boolean;
  isIKZE: boolean;
  ikzeIsDG: boolean; // działalność gospodarcza
  commissionPl: number; // prowizja GPW w % (np. 0.39)
  commissionForeign: number; // prowizja zagraniczne w % (np. 0.29)
  minCommissionPl: number; // minimalna prowizja GPW w PLN
  minCommissionForeign: number; // minimalna prowizja zagraniczne
  /**
   * Oprocentowanie wolnych środków per waluta. Pusta lista / undefined =
   * funkcja wyłączona (skaner usuwa wtedy wcześniej naliczone auto-odsetki).
   */
  freeCashInterest?: FreeCashInterestRate[];
}

export const DEFAULT_PORTFOLIO_SETTINGS: PortfolioSettings = {
  isIKE: false,
  isIKZE: false,
  ikzeIsDG: false,
  commissionPl: 0,
  commissionForeign: 0,
  minCommissionPl: 0,
  minCommissionForeign: 0,
  freeCashInterest: [],
};

export interface Portfolio {
  id: string;
  name: string;
  createdAt: string;
  settings: PortfolioSettings;
  userId?: string; // owner (multi-tenancy)
}

// ============ Public Portfolio Share ============

/** Zakres publicznego widoku: sam wykres zwrotu vs wykres + otwarte pozycje. */
export type ShareScope = 'chart' | 'chart_positions';

/** Preset ważności linku — expiresAt liczone serwerowo, nigdy z daty od klienta. */
export type ShareValidity = 'indefinite' | '7d' | '30d' | '90d';

/** Ustawienia przekazywane przy tworzeniu/edycji linku (POST/PUT /api/share). */
export interface ShareSettingsInput {
  scope: ShareScope;
  showAmounts: boolean;
  /** BenchmarkKey — walidowany serwerowo przeciw BENCHMARKS. */
  benchmark: string;
  validity: ShareValidity;
}

/** Wiersz share widziany przez właściciela (GET /api/share). */
export interface PortfolioShare {
  token: string;
  portfolioId: string;
  scope: ShareScope;
  showAmounts: boolean;
  benchmark: string;
  createdAt: string;
  updatedAt: string;
  /** null = bezterminowy. */
  expiresAt: string | null;
}

/** GET /api/public/share/:token/meta — dane do nagłówka publicznej strony. */
export interface PublicShareMeta {
  portfolioName: string;
  scope: ShareScope;
  showAmounts: boolean;
  benchmark: string;
  createdAt: string;
  expiresAt: string | null;
}

/** Metryki publiczne — pola kwotowe null gdy showAmounts=false. */
export interface PublicShareMetrics {
  xirr: number;
  totalReturnPct: number;
  currentValue: number | null;
  totalInvested: number | null;
  totalReturn: number | null;
  totalDividends: number | null;
}

/**
 * GET /api/public/share/:token/history — kształt jak PortfolioHistoryResponse,
 * ale przy showAmounts=false pola absolutne w history są znormalizowane
 * (przemnożone przez stałą k), więc realne kwoty są nieodtwarzalne, a pola %
 * pozostają nietknięte.
 */
export interface PublicHistoryResponse {
  history: PortfolioHistoryPoint[];
  metrics: PublicShareMetrics;
  baseCurrency: string;
  /** Rynkowa stopa wolna od ryzyka (%) — nie jest daną prywatną, patrz PortfolioHistoryResponse. */
  riskFreeRatePct: number;
}

/** Pozycja w widoku publicznym — pola kwotowe obecne tylko gdy showAmounts=true. */
export interface PublicPosition {
  isin: string;
  ticker: string;
  paperName: string;
  currency: string;
  currentPrice: number | null;
  dailyChangePct: number | null;
  profitLossPct: number;
  weight: number;
  exchange?: string;
  sector?: string;
  supersector?: string;
  category?: InstrumentCategory;
  priceManual?: boolean;
  // tylko gdy showAmounts === true:
  shares?: number;
  avgBuyPrice?: number;
  currentValue?: number;
  currentValuePln?: number;
  profitLoss?: number;
  profitLossPln?: number;
}

/** Cash w widoku publicznym — salda tylko gdy showAmounts=true. */
export interface PublicCashPosition {
  currency: string;
  weight: number;
  balance?: number;
  valuePln?: number;
}

/** GET /api/public/share/:token/positions. */
export interface PublicPositionsResponse {
  positions: PublicPosition[];
  cashPositions: PublicCashPosition[];
  baseCurrency: string;
  // tylko gdy showAmounts === true:
  totalValuePln?: number;
  stocksValuePln?: number;
  cashValuePln?: number;
}
