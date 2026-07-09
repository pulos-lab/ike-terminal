/**
 * Orkiestrator: pełny HTML wyciągu → IbkrStatement (model pośredni).
 */
import type { IbkrStatement } from './section-types.js';
import {
  parseAccountInformation,
  parseTrades,
  parseContractInfo,
  parseDividends,
  parseWithholdingTax,
  parseInterest,
  parseFees,
  parseBrokerFees,
  parseDepositsWithdrawals,
  parseCorporateActions,
  parseTransfers,
  parseTransactionsTax,
  parseCashReportSalesTax,
} from './sections.js';

/** Detekcja formatu — stringi obecne w każdym Activity Statement (zweryfikowane 2021-2025). */
export function isIbkrStatementHtml(content: string): boolean {
  return (
    content.includes('Activity Statement') &&
    content.includes('Interactive Brokers') &&
    /id="tbl(Transactions|CombDepWith)_?U\d+Body"/.test(content)
  );
}

export function parseIbkrStatementHtml(html: string, warnings: string[]): IbkrStatement {
  const { account, baseCurrency } = parseAccountInformation(html);
  const { stocks, options, bonds } = parseContractInfo(html);
  return {
    account,
    baseCurrency,
    trades: parseTrades(html, warnings),
    stockInstruments: stocks,
    optionInstruments: options,
    bondInstruments: bonds,
    dividends: parseDividends(html),
    withholdingTaxes: parseWithholdingTax(html),
    interest: parseInterest(html),
    fees: parseFees(html),
    brokerFees: parseBrokerFees(html),
    depositsWithdrawals: parseDepositsWithdrawals(html),
    corporateActions: parseCorporateActions(html),
    transfers: parseTransfers(html),
    transactionTaxes: parseTransactionsTax(html),
    salesTax: parseCashReportSalesTax(html),
  };
}
