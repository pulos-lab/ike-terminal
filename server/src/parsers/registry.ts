import type {
  Transaction,
  CashOperation,
  BrokerType,
  ParseResult,
  RedemptionMarker,
  IpoSubscriptionMarker,
  BondAllocationMarker,
  CapitalReturnMarker,
  TypeAliasTarget,
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
import { parseIbkrFile, isIbkrFormat } from './ibkr/index.js';
import { parseT212File, isT212Format } from './trading212/index.js';
import type { IbkrSplitMarker, IbkrIsinChangeMarker } from './ibkr/index.js';
import type { OptionContract } from 'shared';

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
// ── Combined (single/multi-file, transakcje+operacje w jednym pliku) registry ──
// Brokerzy, których jeden plik zawiera oba typy danych: XTB (XLSX multi-sheet),
// IBKR (HTML Activity Statement). Wejściem jest surowy Buffer (XLSX jest binarny,
// HTML wymaga detekcji po treści przed ścieżką CSV).

/** Wynik parsera combined — poza transakcjami i operacjami może nieść markery
 *  reconciliation (IBKR: splity, zmiany ISIN, kontrakty opcyjne, podatki FTT). */
export interface CombinedParseOutput {
  transactions: ParseResult<Transaction>;
  operations: ParseResult<CashOperation>;
  warnings?: string[];
  /** Splity z sekcji Corporate Actions (realne ex-daty) → upsertSplits(source 'manual'). */
  splits?: IbkrSplitMarker[];
  /** Zmiany ISIN (CUSIP change, reverse split z nowym ISIN) → UPDATE transactions. */
  isinChanges?: IbkrIsinChangeMarker[];
  /** Kontrakty opcyjne → option_contracts + seeding ticker_map (ticker OCC dla Yahoo). */
  optionContracts?: OptionContract[];
  /** Podatki transakcyjne (FTT) → doliczenie do prowizji (wzorzec DEGIRO). */
  transactionTaxes?: TransactionTax[];
  /** Numer konta (IBKR) — do komunikatów w wynikach importu. */
  account?: string;
}

/**
 * Kontekst wstrzykiwany do parsera przez import-service — parsery pozostają
 * czyste/synchroniczne, lookupy DB (mapa aliasów) robi caller przed parsowaniem.
 */
export interface ParserContext {
  /** Zatwierdzone aliasy typów operacji brokera: lower(trim(raw_type)) → target.
   *  Konsultowane PRZED oznaczeniem wiersza jako unknown_type — wbudowane
   *  mapowania parsera zawsze mają pierwszeństwo. */
  typeAliases?: Map<string, TypeAliasTarget>;
}

export interface CombinedBrokerParser {
  id: BrokerType;
  label: string;
  /** Rozszerzenia plików tego brokera (lowercase, z kropką). */
  extensions: string[];
  detect: (buffer: Buffer) => boolean | Promise<boolean>;
  parse: (
    buffer: Buffer,
    importBatch: string,
    fileName?: string,
    ctx?: ParserContext,
  ) => Promise<CombinedParseOutput>;
  needsNameResolution: boolean;
  /** Czy można wgrać wiele plików naraz (IBKR: jeden Activity Statement per rok/konto). */
  supportsMultipleFiles: boolean;
}

const COMBINED_PARSER_REGISTRY: CombinedBrokerParser[] = [
  {
    id: 'xtb',
    label: 'XTB',
    extensions: ['.xlsx'],
    detect: isXtbFormat,
    parse: parseXtbFile,
    needsNameResolution: true,
    supportsMultipleFiles: false,
  },
  {
    id: 'ibkr',
    label: 'Interactive Brokers',
    extensions: ['.htm', '.html'],
    detect: isIbkrFormat,
    parse: (buffer, importBatch) => {
      const out = parseIbkrFile(buffer, importBatch);
      return Promise.resolve({
        transactions: { data: out.transactions, skipped: out.skipped },
        operations: { data: out.operations, skipped: [] },
        warnings: out.warnings,
        splits: out.splits,
        isinChanges: out.isinChanges,
        optionContracts: out.optionContracts,
        transactionTaxes: out.transactionTaxes,
        account: out.account,
      });
    },
    needsNameResolution: false,
    supportsMultipleFiles: true,
  },
  {
    // Trading 212: JEDEN plik CSV z transakcjami, operacjami gotówkowymi i splitami.
    // Rozszerzenie `.csv` dzieli z parserami z PARSER_REGISTRY, dlatego o wyborze
    // ścieżki decyduje `detect` po TREŚCI (classifyFile próbuje combined jako pierwsze
    // i przy braku dopasowania spada do ścieżki tekstowej) — patrz import-service.
    id: 'trading212',
    label: 'Trading 212',
    extensions: ['.csv'],
    detect: isT212Format,
    parse: (buffer, importBatch, fileName) => parseT212File(buffer, importBatch, fileName),
    needsNameResolution: false,
    supportsMultipleFiles: false,
  },
];

/** Czy rozszerzenie pliku należy do któregokolwiek parsera combined. */
export function isCombinedExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return COMBINED_PARSER_REGISTRY.some((p) => p.extensions.some((ext) => lower.endsWith(ext)));
}

export async function detectCombinedBroker(
  buffer: Buffer,
  fileName?: string,
): Promise<CombinedBrokerParser | null> {
  const lower = fileName?.toLowerCase();
  for (const parser of COMBINED_PARSER_REGISTRY) {
    // Rozszerzenie zawęża detekcję (XLSX nie jest parsowalne jako HTML i odwrotnie)
    if (lower && !parser.extensions.some((ext) => lower.endsWith(ext))) continue;
    if (await parser.detect(buffer)) return parser;
  }
  return null;
}
