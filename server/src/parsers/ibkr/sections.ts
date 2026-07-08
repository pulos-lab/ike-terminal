/**
 * Parsery sekcji wyciągu IBKR: HTML → model pośredni (section-types.ts).
 *
 * Sekcje świadomie IGNOROWANE (nie-cashowe, accruale albo duplikaty danych transakcyjnych):
 * NAV, CashReport, OpenPositions, MtmPerfSumByUnderlying, FIFOPerfSumByUnderlying,
 * InterestAccruals, BrokerFeeAccruals, ChangeInDividend, Codes, Footnotes, FxPositions,
 * NetStockPositionSummary, CollSecCustBorr, NonDirectHardToBorrow,
 * StockYieldEnhancementProgramSecuritiesLent* (cash z SYEP jest w BrokerFees),
 * ManagedLoanFees* (accruale; zrealizowane opłaty są w BrokerFees).
 */
import {
  extractSectionTables,
  cellsToRecord,
  parseIbkrNumber,
  parseIbkrDate,
} from './html-tables.js';
import { parseOptionSymbol, normalizeBondSymbol, normalizeOccSymbol } from './symbols.js';
import type {
  IbkrTrade,
  IbkrStockInstrument,
  IbkrOptionInstrument,
  IbkrBondInstrument,
  IbkrCashRow,
  IbkrCorporateActionRow,
  IbkrTransferRow,
  IbkrTransactionTaxRow,
} from './section-types.js';

/** Sekcja Account Information — tabela klucz/wartość bez nagłówków th. */
export function parseAccountInformation(html: string): {
  account?: string;
  baseCurrency?: string;
} {
  const result: { account?: string; baseCurrency?: string } = {};
  for (const table of extractSectionTables(html, 'AccountInformation')) {
    for (const row of table.rows) {
      if (row.cells.length < 2) continue;
      const [key, value] = row.cells;
      if (key === 'Account') result.account = value;
      if (key === 'Base Currency') result.baseCurrency = value;
    }
  }
  return result;
}

export function parseTrades(html: string, warnings: string[]): IbkrTrade[] {
  const trades: IbkrTrade[] = [];
  for (const table of extractSectionTables(html, 'Transactions')) {
    for (const row of table.rows) {
      const rec = cellsToRecord(table.headers, row.cells);
      const symbol = rec['Symbol'];
      const dateTime = parseIbkrDate(rec['Date/Time'] ?? '');
      const quantity = parseIbkrNumber(rec['Quantity'] ?? '');
      const tPrice = parseIbkrNumber(rec['T. Price'] ?? '');
      const proceeds = parseIbkrNumber(rec['Proceeds'] ?? '');
      const commFee = parseIbkrNumber(rec['Comm/Fee'] ?? '') ?? 0;
      if (!symbol || !dateTime || quantity === null || tPrice === null || proceeds === null) {
        warnings.push(`IBKR Trades: pominięto niekompletny wiersz "${row.cells.join('|')}"`);
        continue;
      }
      if (!row.assetClass || !row.currency) {
        warnings.push(`IBKR Trades: wiersz "${symbol}" bez kontekstu kategorii/waluty — pominięto`);
        continue;
      }
      trades.push({
        assetClass: row.assetClass,
        currency: row.currency,
        symbol,
        dateTime,
        quantity,
        tPrice,
        proceeds,
        commFee,
        codes: (rec['Code'] ?? '')
          .split(';')
          .map((c) => c.trim())
          .filter(Boolean),
      });
    }
  }
  return trades;
}

/**
 * Financial Instrument Information — do trzech tabel (Stocks / Options / Bonds) w jednym body.
 * Rozpoznajemy tabelę po zestawie nagłówków, nie po kolejności (zestawy różnią się między latami).
 */
export function parseContractInfo(html: string): {
  stocks: IbkrStockInstrument[];
  options: IbkrOptionInstrument[];
  bonds: IbkrBondInstrument[];
} {
  const stocks: IbkrStockInstrument[] = [];
  const options: IbkrOptionInstrument[] = [];
  const bonds: IbkrBondInstrument[] = [];

  for (const table of extractSectionTables(html, 'ContractInfo')) {
    const hasStrike = table.headers.includes('Strike');
    const hasMaturity = table.headers.includes('Maturity');
    for (const row of table.rows) {
      const rec = cellsToRecord(table.headers, row.cells);
      if (hasStrike) {
        // Tabela opcji. Strike/Expiry z kolumn; underlying z kolumny (2024+) albo z symbolu.
        const tradeSymbol = rec['Description'] ?? '';
        const parsed = parseOptionSymbol(tradeSymbol);
        const strike = parseIbkrNumber(rec['Strike'] ?? '');
        const expiry = rec['Expiry'] ?? parsed?.expiry;
        const optionType = (rec['Type'] ?? parsed?.optionType) as 'C' | 'P' | undefined;
        if (!tradeSymbol || strike === null || !expiry || !optionType) continue;
        options.push({
          occSymbol: normalizeOccSymbol(rec['Symbol'] ?? ''),
          tradeSymbol,
          listingExch: rec['Listing Exch'] || undefined,
          multiplier: parseIbkrNumber(rec['Multiplier'] ?? '') ?? 100,
          expiry,
          optionType,
          strike,
          underlying: rec['Underlying'] || parsed?.underlying,
        });
      } else if (hasMaturity || row.assetClass === 'Bonds') {
        const symbol = normalizeBondSymbol(rec['Symbol'] ?? '');
        const isin = rec['Security ID'] ?? '';
        if (!symbol || !isin) continue;
        bonds.push({
          symbol,
          description: rec['Description'] ?? symbol,
          isin,
          maturity: rec['Maturity'] || undefined,
        });
      } else {
        // Symbol bywa listą aliasów po przecinku, gdy ticker zmienił się w ciągu roku
        // ("META, FB") — rejestrujemy każdy alias, żeby wszystkie transakcje trafiły
        // w ten sam ISIN.
        const symbols = (rec['Symbol'] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const isin = rec['Security ID'] ?? '';
        if (symbols.length === 0 || !isin) continue;
        for (const symbol of symbols) {
          stocks.push({
            symbol,
            description: rec['Description'] ?? symbol,
            isin,
            listingExch: rec['Listing Exch'] || undefined,
            type: rec['Type'] ?? '',
          });
        }
      }
    }
  }
  return { stocks, options, bonds };
}

/** Wspólny parser sekcji cash: Date | Description | Amount (+ opcjonalny Code). */
function parseCashSection(html: string, sectionName: string): IbkrCashRow[] {
  const rows: IbkrCashRow[] = [];
  for (const table of extractSectionTables(html, sectionName)) {
    for (const row of table.rows) {
      const rec = cellsToRecord(table.headers, row.cells);
      const date = parseIbkrDate(rec['Date'] ?? '');
      const amount = parseIbkrNumber(rec['Amount'] ?? '');
      const description = rec['Description'] ?? '';
      if (!date || amount === null || !description) continue;
      if (!row.currency) continue; // wiersze podsumowań "Total in PLN" nie mają kontekstu waluty
      rows.push({ date, description, amount, currency: row.currency });
    }
  }
  return rows;
}

export const parseDividends = (html: string) => parseCashSection(html, 'CombDiv');
export const parseWithholdingTax = (html: string) => parseCashSection(html, 'WithholdingTax');
export const parseInterest = (html: string) => parseCashSection(html, 'CombInt');
export const parseFees = (html: string) => parseCashSection(html, 'CombFees');
export const parseBrokerFees = (html: string) => parseCashSection(html, 'BrokerFees');
export const parseDepositsWithdrawals = (html: string) => parseCashSection(html, 'CombDepWith');

export function parseCorporateActions(html: string): IbkrCorporateActionRow[] {
  const rows: IbkrCorporateActionRow[] = [];
  for (const table of extractSectionTables(html, 'CorporateActions')) {
    for (const row of table.rows) {
      const rec = cellsToRecord(table.headers, row.cells);
      const reportDate = parseIbkrDate(rec['Report Date'] ?? '');
      const date = parseIbkrDate((rec['Date/Time'] ?? '').split(',')[0] ?? '');
      const quantity = parseIbkrNumber(rec['Quantity'] ?? '');
      const description = rec['Description'] ?? '';
      if (!reportDate || !date || quantity === null || !description) continue;
      rows.push({
        reportDate,
        date,
        description,
        quantity,
        assetClass: row.assetClass ?? '',
        currency: row.currency ?? '',
      });
    }
  }
  return rows;
}

export function parseTransfers(html: string): IbkrTransferRow[] {
  const rows: IbkrTransferRow[] = [];
  for (const table of extractSectionTables(html, 'AccountTransfers')) {
    for (const row of table.rows) {
      const rec = cellsToRecord(table.headers, row.cells);
      const date = parseIbkrDate(rec['Date'] ?? '');
      const quantity = parseIbkrNumber(rec['Qty'] ?? '');
      const direction = rec['Direction'];
      if (!date || quantity === null || (direction !== 'In' && direction !== 'Out')) continue;
      rows.push({
        symbol: rec['Symbol'] ?? '',
        date,
        type: rec['Type'] ?? '',
        direction,
        counterAccount: rec['Xfer Account'] ?? '',
        quantity,
        assetClass: row.assetClass ?? '',
        currency: row.currency ?? '',
      });
    }
  }
  return rows;
}

export function parseTransactionsTax(html: string): IbkrTransactionTaxRow[] {
  const rows: IbkrTransactionTaxRow[] = [];
  for (const table of extractSectionTables(html, 'TransactionsTax')) {
    for (const row of table.rows) {
      const rec = cellsToRecord(table.headers, row.cells);
      const date = parseIbkrDate((rec['Date/Time'] ?? '').split(',')[0] ?? '');
      const amount = parseIbkrNumber(rec['Amount'] ?? '');
      if (!date || amount === null) continue;
      rows.push({
        date,
        symbol: rec['Symbol'] ?? '',
        description: rec['Description'] ?? '',
        amount,
        currency: row.currency ?? '',
      });
    }
  }
  return rows;
}
