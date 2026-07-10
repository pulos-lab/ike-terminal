import type {
  Transaction,
  CashOperation,
  BrokerType,
  ParseResult,
  RedemptionMarker,
  IpoSubscriptionMarker,
  BondAllocationMarker,
  CapitalReturnMarker,
} from 'shared';
import type { TransactionTax } from './degiro-operations.js';
import { parseBossaTransactions, isBossaFormat } from './bossa-transactions.js';
import { parseBossaOperations, isBossaOperationsFormat } from './bossa-operations.js';
import { parseMbankTransactions, isMbankFormat } from './mbank-transactions.js';
import { parseMbankOperations, isMbankOperationsFormat } from './mbank-operations.js';
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

/**
 * Wynik parsera operacji gotówkowych. Brokerzy z reconciliation międzyplikowym
 * (obecnie Bossa) zwracają dodatkowo markery — import-service dispatchuje po ich
 * OBECNOŚCI, nie po id brokera. Typy markerów mieszkają w shared/src/types.ts.
 */
export type OperationsParseResult = ParseResult<CashOperation> & {
  /** Wykupy certyfikatów / znane wezwania skupu → syntetyczna S w reconciliation */
  redemptions?: RedemptionMarker[];
  /** Pary "Zapisy na akcje" + "Zwrot nadpłaty" (IPO) → syntetyczna K w reconciliation */
  ipoSubscriptions?: IpoSubscriptionMarker[];
  /** Pary "Zapisy na obligacje" + "Zwrot nadpłaty" → syntetyczna K obligacji w reconciliation */
  bondAllocations?: BondAllocationMarker[];
  /** Zwroty kapitału (obniżenie nominału, wyrównanie wykupu) → CashOperation capital_return */
  capitalReturns?: CapitalReturnMarker[];
  /** Ostrzeżenia parsera (PL) — import-service dokleja do crossFileWarnings */
  warnings?: string[];
};

/** Wynik parsera transakcji CSV — opcjonalne ostrzeżenia (np. mBank: brak kolumny w nagłówku). */
export type TransactionsParseResult = ParseResult<Transaction> & {
  /** Ostrzeżenia parsera (PL) — import-service dokleja do crossFileWarnings */
  warnings?: string[];
};

export interface BrokerParser {
  id: BrokerType;
  label: string;
  detect: (content: string) => boolean;
  parse: (content: string, importBatch: string) => TransactionsParseResult;
  /** Whether this broker supports cash operations import */
  supportsOperations: boolean;
  /** Detect if CSV is an operations file (not transactions) for this broker */
  detectOperations?: (content: string) => boolean;
  /** Parse cash operations CSV (z opcjonalnymi markerami reconciliation) */
  parseOperations?: (content: string, importBatch: string) => OperationsParseResult;
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
    supportsOperations: true,
    detectOperations: isMbankOperationsFormat,
    parseOperations: parseMbankOperations,
    needsNameResolution: true,
  },
  {
    id: 'bossa',
    label: 'Bossa',
    detect: isBossaFormat,
    parse: parseBossaTransactions,
    supportsOperations: true,
    detectOperations: isBossaOperationsFormat,
    parseOperations: parseBossaOperations,
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
 * Wszystkie parsery (id), których detekcja trafia w treść CSV — osobno dla roli
 * transakcji i operacji. Guard niejednoznaczności: zdrowy plik powinien pasować
 * do DOKŁADNIE jednego brokera w danej roli. detectBroker/classifyFile wybierają
 * pierwszy wg kolejności rejestru (specyficzność malejąco); ta funkcja pozwala
 * wykryć i zgłosić sytuację, gdy trafia więcej niż jeden (test regresji + UI).
 */
export function detectAllMatches(content: string): {
  transactions: BrokerType[];
  operations: BrokerType[];
} {
  return {
    transactions: PARSER_REGISTRY.filter((p) => p.detect(content)).map((p) => p.id),
    operations: PARSER_REGISTRY.filter((p) => p.detectOperations?.(content)).map((p) => p.id),
  };
}

/**
 * Get parser by broker ID. Returns undefined for 'auto'.
 */
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

const BINARY_PARSER_REGISTRY: BinaryBrokerParser[] = [
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
