/**
 * Publiczne API parsera IBKR: plik HTML (Activity Statement) → typy domenowe.
 * Integracja z registry/import-service następuje przez CombinedBrokerParser (PR4).
 */
import { isIbkrStatementHtml, parseIbkrStatementHtml } from './ibkr-statement.js';
import { mapIbkrStatement, type IbkrMappedStatement } from './ibkr-mapper.js';

export type { IbkrMappedStatement, IbkrSplitMarker, IbkrIsinChangeMarker } from './ibkr-mapper.js';
export type { IbkrStatement } from './section-types.js';
export { parseIbkrStatementHtml, isIbkrStatementHtml } from './ibkr-statement.js';
export { parseOptionSymbol, toOccTicker, toOptionPseudoIsin } from './symbols.js';

export interface IbkrParseOutput extends IbkrMappedStatement {
  /** Numer konta z sekcji Account Information (do komunikatów UI). */
  account?: string;
  baseCurrency?: string;
}

export function isIbkrFormat(buffer: Buffer): boolean {
  return isIbkrStatementHtml(buffer.toString('utf-8'));
}

export function parseIbkrFile(buffer: Buffer, importBatch: string): IbkrParseOutput {
  const warnings: string[] = [];
  const statement = parseIbkrStatementHtml(buffer.toString('utf-8'), warnings);
  const mapped = mapIbkrStatement(statement, importBatch);
  mapped.warnings.unshift(...warnings);
  return { ...mapped, account: statement.account, baseCurrency: statement.baseCurrency };
}
