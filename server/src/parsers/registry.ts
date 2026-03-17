import type { Transaction, BrokerType, ParseResult } from 'shared';
import { parseBossaTransactions, isBossaFormat } from './bossa-transactions.js';
import { parseMbankTransactions, isMbankFormat } from './mbank-transactions.js';
import { parseDegiroTransactions, isDegiroFormat } from './degiro-transactions.js';

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
  /** Whether the parser needs post-import ISIN resolution by name (mBank) */
  needsNameResolution: boolean;
}

export const PARSER_REGISTRY: BrokerParser[] = [
  {
    id: 'degiro',
    label: 'DEGIRO',
    detect: isDegiroFormat,
    parse: parseDegiroTransactions,
    supportsOperations: false,
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
  return PARSER_REGISTRY.find(p => p.id === id);
}
