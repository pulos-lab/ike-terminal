/**
 * Model pośredni wyciągu IBKR Activity Statement — wynik parsowania sekcji HTML,
 * jeszcze przed mapowaniem na domenowe Transaction/CashOperation (ibkr-mapper.ts).
 * Pola liczbowe są już sparsowane, daty w ISO.
 */

/** Wiersz sekcji Trades (tblTransactions). */
export interface IbkrTrade {
  /** Kategoria aktywów z nagłówka grupującego: Stocks / Equity and Index Options / Bonds / Forex. */
  assetClass: string;
  /** Waluta notowania z nagłówka grupującego. */
  currency: string;
  symbol: string;
  /** ISO z czasem: 2021-12-09T14:12:23. */
  dateTime: string;
  quantity: number;
  /** T. Price — cena transakcyjna (dla obligacji: % nominału; dla opcji: premia per akcja). */
  tPrice: number;
  /** Proceeds — wartość gotówkowa BEZ prowizji (ujemna dla kupna). Dla opcji zawiera mnożnik. */
  proceeds: number;
  /** Comm/Fee — prowizja (ujemna). */
  commFee: number;
  /**
   * Waluta prowizji, gdy nagłówek kolumny mówi wprost "Comm in XXX" (blok Forex:
   * prowizje przewalutowań są zawsze w walucie bazowej konta, niezależnie od waluty
   * bloku — np. EUR.USD pod blokiem USD ma prowizję w PLN). Brak = waluta bloku.
   */
  commCurrency?: string;
  /** Kody transakcji po splicie ";": O, C, P, Ep, A, Ex, FPA, Ca, ... */
  codes: string[];
}

/** Wiersz tabeli Stocks w Financial Instrument Information. */
export interface IbkrStockInstrument {
  symbol: string;
  description: string;
  /** Security ID — prawdziwy ISIN. */
  isin: string;
  listingExch?: string;
  /** Type: COMMON / ETF / ADR / REIT ... */
  type: string;
}

/** Wiersz tabeli Equity and Index Options w Financial Instrument Information. */
export interface IbkrOptionInstrument {
  /** Pełny symbol OCC z paddingiem znormalizowanym ("INTC240906P00018000"). */
  occSymbol: string;
  /** Symbol używany w Trades ("INTC 06SEP24 18 P"). */
  tradeSymbol: string;
  listingExch?: string;
  multiplier: number;
  /** YYYY-MM-DD. */
  expiry: string;
  optionType: 'C' | 'P';
  strike: number;
  /** Underlying — kolumna dostępna od 2024; dla starszych plików derywowana z symbolu. */
  underlying?: string;
}

/** Wiersz tabeli Bonds w Financial Instrument Information. */
export interface IbkrBondInstrument {
  /** Symbol bez yieldu ("T 2 7/8 05/15/32"). */
  symbol: string;
  description: string;
  isin: string;
  /** YYYY-MM-DD (kolumna Maturity). */
  maturity?: string;
}

/** Wiersz sekcji cash (Dividends / Withholding Tax / Interest / Fees / Deposits...). */
export interface IbkrCashRow {
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  amount: number;
  currency: string;
}

/** Wiersz sekcji Corporate Actions. */
export interface IbkrCorporateActionRow {
  /** Data księgowania (Report Date). */
  reportDate: string;
  /** Data zdarzenia (Date/Time) — YYYY-MM-DD. */
  date: string;
  description: string;
  quantity: number;
  assetClass: string;
  currency: string;
}

/** Wiersz sekcji Transfers (transfer Inter-Company między kontami IBKR). */
export interface IbkrTransferRow {
  symbol: string;
  date: string;
  /** "Inter-Company" / "ACATS" ... */
  type: string;
  direction: 'In' | 'Out';
  /** Numer konta po drugiej stronie transferu. */
  counterAccount: string;
  quantity: number;
  assetClass: string;
  currency: string;
}

/** Wiersz sekcji Transactions Tax (np. francuski FTT powiązany z transakcją). */
export interface IbkrTransactionTaxRow {
  /** YYYY-MM-DD. */
  date: string;
  symbol: string;
  description: string;
  amount: number;
  currency: string;
}

/** Sparsowany wyciąg — jedna struktura na jeden plik HTML. */
export interface IbkrStatement {
  /** Numer konta (U6474045 / U16474045). */
  account?: string;
  /** Waluta bazowa konta (PLN). */
  baseCurrency?: string;
  trades: IbkrTrade[];
  stockInstruments: IbkrStockInstrument[];
  optionInstruments: IbkrOptionInstrument[];
  bondInstruments: IbkrBondInstrument[];
  dividends: IbkrCashRow[];
  withholdingTaxes: IbkrCashRow[];
  /** Combined Interest — odsetki margin/credit, kupony obligacji, accrued interest. */
  interest: IbkrCashRow[];
  /** Fees (market data itd.). */
  fees: IbkrCashRow[];
  /** Broker Fees — w starszych plikach zawiera Investment Loan Interest / SYEP / Stock Borrow Fees. */
  brokerFees: IbkrCashRow[];
  depositsWithdrawals: IbkrCashRow[];
  corporateActions: IbkrCorporateActionRow[];
  transfers: IbkrTransferRow[];
  transactionTaxes: IbkrTransactionTaxRow[];
  /** Agregat "Sales Tax" (VAT od opłat) z Cash Report — per waluta, tylko suma roczna. */
  salesTax: Array<{ currency: string; amount: number }>;
}
