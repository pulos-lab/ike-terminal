import type { Transaction, CashOperation, BrokerType, ParseResult } from 'shared';
import type { TransactionTax } from './degiro-operations.js';
import { parseBossaTransactions, isBossaFormat } from './bossa-transactions.js';
import { parseMbankTransactions, isMbankFormat } from './mbank-transactions.js';
import { parseDegiroTransactions, isDegiroFormat } from './degiro-transactions.js';
import {
  parseDegiroOperations,
  isDegiroAccountFormat,
  parseDegiroTransactionTaxes,
} from './degiro-operations.js';
import { parseXtbFile, isXtbFormat } from './xtb-transactions.js';

/**
 * Parser registry — defines all supported brokers, their detection logic,
 * and parsing functions. Used by the import route for both auto-detection
 * and explicit broker selection.
 *
 * Detection order matters for auto-detect: more specific formats first,
 * generic formats last. Bossa is no longer a fallback — it has its own
 * detection function.
 */

export interface BrokerParser {
  id: BrokerType;
  label: string;
  detect: (content: string) => boolean;
  parse: (content: string, importBatch: string) => ParseResult<Transaction>;
  /** Whether this broker supports cash operations import */
  supportsOperations: boolean;
  /** Detect if CSV is an operations file (not transactions) for this broker */
  detectOperations?: (content: string) => boolean;
  /** Parse cash operations CSV */
  parseOperations?: (content: string, importBatch: string) => ParseResult<CashOperation>;
  /** Extract transaction-specific taxes to add to transaction commissions */
  parseTransactionTaxes?: (content: string) => TransactionTax[];
  /** Whether the parser needs post-import ISIN resolution by name (mBank) */
  needsNameResolution: boolean;
}

export const PARSER_REGISTRY: BrokerParser[] = [
  {
    id: 'degiro',
    label: 'DEGIRO',
    detect: isDegiroFormat,
    parse: parseDegiroTransactions,
    supportsOperations: true,
    detectOperations: isDegiroAccountFormat,
    parseOperations: parseDegiroOperations,
    parseTransactionTaxes: parseDegiroTransactionTaxes,
    needsNameResolution: false,
  },
  {
    id: 'mbank',
    label: 'mBank eMakler',
    detect: isMbankFormat,
    parse: parseMbankTransactions,
    supportsOperations: false,
    needsNameResolution: true,
  },
  {
    id: 'bossa',
    label: 'Bossa',
    detect: isBossaFormat,
    parse: parseBossaTransactions,
    supportsOperations: true,
    needsNameResolution: false,
  },
];

/**
 * Auto-detect broker format from CSV content.
 * Returns the matching parser or null if no format matched.
 */
export function detectBroker(content: string): BrokerParser | null {
  for (const parser of PARSER_REGISTRY) {
    if (parser.detect(content)) {
      return parser;
    }
  }
  return null;
}

/**
 * Get parser by broker ID. Returns undefined for 'auto'.
 */
export function getParserById(id: BrokerType): BrokerParser | undefined {
  return PARSER_REGISTRY.find((p) => p.id === id);
}

// ── Binary (XLSX) parser registry ──────────────────────────────────────────

export interface BinaryBrokerParser {
  id: BrokerType;
  label: string;
  detect: (buffer: Buffer) => boolean | Promise<boolean>;
  parse: (
    buffer: Buffer,
    importBatch: string,
    fileName?: string,
  ) => Promise<{
    transactions: ParseResult<Transaction>;
    operations: ParseResult<CashOperation>;
    warnings?: string[];
  }>;
  needsNameResolution: boolean;
}

export const BINARY_PARSER_REGISTRY: BinaryBrokerParser[] = [
  {
    id: 'xtb',
    label: 'XTB',
    detect: isXtbFormat,
    parse: parseXtbFile,
    needsNameResolution: true,
  },
];

export async function detectBinaryBroker(buffer: Buffer): Promise<BinaryBrokerParser | null> {
  for (const parser of BINARY_PARSER_REGISTRY) {
    if (await parser.detect(buffer)) return parser;
  }
  return null;
}

export function getBinaryParserById(id: BrokerType): BinaryBrokerParser | undefined {
  return BINARY_PARSER_REGISTRY.find((p) => p.id === id);
}
