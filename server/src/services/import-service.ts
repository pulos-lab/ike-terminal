/**
 * Import service — orchestrates atomic "bulk import" of transactions + cash operations
 * in a single request. Replaces the old split-endpoint flow (`/transactions` + `/operations`).
 *
 * Responsibilities:
 * 1. Classify files (broker + role).
 * 2. Parse all files.
 * 3. Run everything in a single SQLite transaction for atomicity.
 * 4. Apply broker-specific cross-file reconciliation:
 *    - Bossa: reconcileRedemptions (Wykup certyfikatów + Rozliczenie oferty).
 *    - DEGIRO: applyTransactionTaxes + validateFxOrderIds.
 * 5. Return consolidated ImportResult with crossFileWarnings.
 *
 * Single-file brokers (mBank, XTB) fall through the same service — the operations file slot
 * is simply empty and no reconciliation runs.
 */

import { randomUUID } from 'crypto';
import type {
  Transaction,
  CashOperation,
  BrokerType,
  SkippedRow,
  ImportResult,
  RedemptionMarker,
  ParseResult,
} from 'shared';
import { decodeCSVBuffer } from '../parsers/encoding.js';
import {
  detectBroker,
  detectBinaryBroker,
  PARSER_REGISTRY,
} from '../parsers/registry.js';
import {
  parseBossaOperations,
  type BossaOperationsParseResult,
} from '../parsers/bossa-operations.js';
import {
  insertTransactionsWithDedup,
  getAllTransactions,
  getTransactionsByIsin,
  updateTransaction,
  detectOrphanedSells,
} from '../db/transactions-repo.js';
import { insertOperationsWithDedup } from '../db/operations-repo.js';
import { seedTickerMap, findIsinByName, upsertTickerMapEntry } from '../db/ticker-map-repo.js';
import { resolveUnknownIsins } from './isin-resolver.js';
import { getDb } from '../db/connection.js';

// ─── File classification ─────────────────────────────────────────────────────

export interface ClassifiedFile {
  role: 'transactions' | 'operations' | 'unknown';
  broker: BrokerType | null;
  isBinary: boolean;
  buffer: Buffer;
  originalName: string;
}

export async function classifyFile(file: { buffer: Buffer; originalname: string }): Promise<ClassifiedFile> {
  const isBinary = file.originalname.toLowerCase().endsWith('.xlsx');

  if (isBinary) {
    const binary = await detectBinaryBroker(file.buffer);
    return {
      role: binary ? 'transactions' : 'unknown', // XTB XLSX zawiera oba typy w jednym pliku — traktujemy jako "transactions" z bonusem operacji
      broker: binary?.id ?? null,
      isBinary: true,
      buffer: file.buffer,
      originalName: file.originalname,
    };
  }

  const content = decodeCSVBuffer(file.buffer);

  // Najpierw sprawdź czy to plik operacji — operations detection ma pierwszeństwo
  // (DEGIRO Account, Bossa operacje_bez_transakcji).
  const opsParser = PARSER_REGISTRY.find(p => p.detectOperations?.(content));
  if (opsParser) {
    return { role: 'operations', broker: opsParser.id, isBinary: false, buffer: file.buffer, originalName: file.originalname };
  }

  // Bossa operacje wykrywamy osobno (header check bez dedykowanego detectOperations w registry).
  if (isBossaOperationsFile(content)) {
    return { role: 'operations', broker: 'bossa', isBinary: false, buffer: file.buffer, originalName: file.originalname };
  }

  // Jeśli to nie operacje, próbujemy transakcji.
  const txParser = detectBroker(content);
  if (txParser) {
    return { role: 'transactions', broker: txParser.id, isBinary: false, buffer: file.buffer, originalName: file.originalname };
  }

  return { role: 'unknown', broker: null, isBinary: false, buffer: file.buffer, originalName: file.originalname };
}

function isBossaOperationsFile(content: string): boolean {
  const firstLine = (content.split('\n')[0] || '').toLowerCase();
  return firstLine.includes('data')
    && firstLine.includes('kwota')
    && (firstLine.includes('tytuł operacji') || firstLine.includes('tytu\u0142 operacji'));
}

/**
 * Brokerzy, dla których zalecamy dostarczenie osobnego pliku operacji gotówkowych.
 * UI używa tego do decyzji, czy wymagać drugiego dropzone'u.
 */
export function requiresOperationsFile(broker: BrokerType | null): boolean {
  return broker === 'bossa' || broker === 'degiro';
}

// ─── Main bulk entry point ───────────────────────────────────────────────────

export interface BulkInput {
  transactionsFile?: { buffer: Buffer; originalname: string };
  operationsFile?: { buffer: Buffer; originalname: string };
  requestedBroker?: BrokerType;
  portfolioId: string;
}

export async function bulkImport(input: BulkInput): Promise<ImportResult> {
  const { portfolioId: pid, transactionsFile, operationsFile } = input;
  const importBatch = randomUUID();

  if (!transactionsFile && !operationsFile) {
    return emptyResult(importBatch, ['Nie przesłano żadnego pliku']);
  }

  // Klasyfikacja
  const txFile = transactionsFile ? await classifyFile(transactionsFile) : null;
  const opsFile = operationsFile ? await classifyFile(operationsFile) : null;

  // Walidacja ról
  if (txFile && txFile.role !== 'transactions') {
    return emptyResult(importBatch, [`Plik "${txFile.originalName}" nie wygląda na eksport transakcji (wykryto: ${txFile.role}).`]);
  }
  if (opsFile && opsFile.role !== 'operations') {
    return emptyResult(importBatch, [`Plik "${opsFile.originalName}" nie wygląda na eksport operacji gotówkowych (wykryto: ${opsFile.role}).`]);
  }

  // XTB XLSX: jeden plik, multi-sheet, atomowy z natury
  if (txFile?.isBinary) {
    return await importBinary(txFile, importBatch, pid);
  }

  // CSV flow: parsujemy oba pliki, potem wsadzamy w jednej db.transaction()
  seedTickerMap(pid);

  let parsedTx: ParseResult<Transaction> | null = null;
  let parsedOps: BossaOperationsParseResult | ParseResult<CashOperation> | null = null;
  let txParserId: BrokerType | null = null;
  let opsParserId: BrokerType | null = null;
  let opsContentRaw: string | null = null;

  if (txFile) {
    const content = decodeCSVBuffer(txFile.buffer);
    const parser = detectBroker(content);
    if (!parser) {
      return emptyResult(importBatch, [`Nie rozpoznano formatu pliku transakcji: ${txFile.originalName}`]);
    }
    parsedTx = parser.parse(content, importBatch);
    txParserId = parser.id;

    // Name resolution (mBank: paperName → ISIN z ticker_map)
    if (parser.needsNameResolution) {
      for (const tx of parsedTx.data) {
        const existing = findIsinByName(tx.paperName, pid);
        if (existing) tx.isin = existing.isin;
      }
    }
  }

  if (opsFile) {
    const content = decodeCSVBuffer(opsFile.buffer);
    opsContentRaw = content;

    // Bossa operations parser ma rozszerzony return (z redemptions)
    if (opsFile.broker === 'bossa') {
      parsedOps = parseBossaOperations(content, importBatch);
      opsParserId = 'bossa';
    } else {
      const opsParser = PARSER_REGISTRY.find(p => p.id === opsFile.broker && p.parseOperations);
      if (opsParser?.parseOperations) {
        parsedOps = opsParser.parseOperations(content, importBatch);
        opsParserId = opsParser.id;
      }
    }
  }

  // Atomowe inserty + reconciliation w jednej transakcji SQLite
  const db = getDb(pid);
  const result: ImportResult = emptyResult(importBatch);
  result.detectedSource = txParserId ?? undefined;
  result.detectedOperationsSource = opsParserId ?? undefined;

  const insertedTxDuplicates: SkippedRow[] = [];
  const insertedOpsDuplicates: SkippedRow[] = [];
  let syntheticSells = 0;
  const crossFileWarnings: string[] = [];

  const runAll = db.transaction(() => {
    // 1. Transakcje
    if (parsedTx && parsedTx.data.length > 0) {
      const r = insertTransactionsWithDedup(parsedTx.data, pid);
      result.transactionsImported = r.inserted;
      insertedTxDuplicates.push(...r.duplicates);
    }

    // 2. Operacje
    if (parsedOps && parsedOps.data.length > 0) {
      const r = insertOperationsWithDedup(parsedOps.data, pid);
      result.operationsImported = r.inserted;
      insertedOpsDuplicates.push(...r.duplicates);
    }

    // 3. Reconciliation per broker

    // 3a. Bossa — redemption markers (Wykup certyfikatów + Rozliczenie oferty)
    if (parsedOps && 'redemptions' in parsedOps && parsedOps.redemptions.length > 0) {
      const r = reconcileBossaRedemptions(parsedOps.redemptions, pid, importBatch, crossFileWarnings);
      syntheticSells += r;
    }

    // 3b. DEGIRO — transaction taxes applied cross-batch (nawet jeśli user wgrał osobno wcześniej)
    if (opsFile?.broker === 'degiro' && opsContentRaw) {
      const degiroParser = PARSER_REGISTRY.find(p => p.id === 'degiro');
      if (degiroParser?.parseTransactionTaxes) {
        const taxes = degiroParser.parseTransactionTaxes(opsContentRaw);
        let applied = 0;
        for (const tax of taxes) {
          const txs = getTransactionsByIsin(tax.isin, pid);
          const taxDate = tax.date.split('T')[0];
          const match = txs.find(t => t.date.startsWith(taxDate));
          if (match?.id) {
            const newCommission = Math.round((match.commission + tax.amount) * 100) / 100;
            const newTotal = match.side === 'K'
              ? Math.round((match.value + newCommission) * 100) / 100
              : Math.round((match.value - newCommission) * 100) / 100;
            updateTransaction(match.id, { commission: newCommission, total: newTotal }, pid);
            applied++;
          } else {
            crossFileWarnings.push(`DEGIRO: ${tax.description} dla ISIN ${tax.isin} z ${taxDate} nie znalazł pasującej transakcji`);
          }
        }
        if (applied > 0) result.taxesApplied = applied;
      }
    }

    // Po reconciliation: tworzymy fallback ticker_map dla nierozwiązanych ISIN-ów z otwartymi pozycjami
    if (parsedTx) {
      for (const tx of parsedTx.data) {
        // (resolver zawoła się poza transakcją — tu tylko upewniamy się że transakcje są w DB)
      }
    }
  });
  runAll();

  // Po db.transaction: ISIN resolution (sieciowe — poza transakcją SQLite)
  let resolved: any[] = [];
  let unresolved: any[] = [];
  if (parsedTx && parsedTx.data.length > 0) {
    const resolution = await resolveUnknownIsins(parsedTx.data, pid);
    resolved = resolution.resolved;
    unresolved = resolution.unresolved;

    // Fallback ticker_map entries dla nierozwiązanych z otwartymi pozycjami
    for (const u of unresolved) {
      const isinTxs = parsedTx.data.filter(t => t.isin === u.isin);
      const net = isinTxs.reduce((sum, t) => sum + (t.side === 'K' ? t.quantity : -t.quantity), 0);
      if (Math.abs(net) > 0.001) {
        upsertTickerMapEntry({
          isin: u.isin,
          ticker: u.paperName,
          name: u.paperName,
          exchange: 'GPW',
          currency: 'PLN',
          priceSource: 'stooq',
        }, pid);
      }
    }
  }

  // Filtr unresolved: pokazuj tylko te z otwartymi pozycjami
  const unresolvedVisible = parsedTx
    ? unresolved.filter(u => {
        const isinTxs = parsedTx!.data.filter(t => t.isin === u.isin);
        const net = isinTxs.reduce((sum, t) => sum + (t.side === 'K' ? t.quantity : -t.quantity), 0);
        return Math.abs(net) > 0.001;
      })
    : [];

  // Agregacja skipped
  const allSkipped: SkippedRow[] = [
    ...(parsedTx?.skipped ?? []),
    ...(parsedOps?.skipped ?? []),
    ...insertedTxDuplicates,
    ...insertedOpsDuplicates,
  ];
  const duplicatesSkipped = insertedTxDuplicates.length + insertedOpsDuplicates.length;

  const orphanedSells = detectOrphanedSells(pid);

  return {
    ...result,
    success: true,
    tickersResolved: resolved.length,
    tickersUnresolved: unresolvedVisible.map(u => u.paperName),
    skipped: allSkipped.length > 0 ? allSkipped : undefined,
    duplicatesSkipped: duplicatesSkipped > 0 ? duplicatesSkipped : undefined,
    orphanedSells: orphanedSells.length > 0 ? orphanedSells : undefined,
    syntheticSells: syntheticSells > 0 ? syntheticSells : undefined,
    crossFileWarnings: crossFileWarnings.length > 0 ? crossFileWarnings : undefined,
  };
}

// ─── XTB XLSX (single-file) path ─────────────────────────────────────────────

async function importBinary(file: ClassifiedFile, importBatch: string, pid: string): Promise<ImportResult> {
  const binary = await detectBinaryBroker(file.buffer);
  if (!binary) {
    return emptyResult(importBatch, ['Nie rozpoznano formatu XLSX']);
  }
  const parseResult = await binary.parse(file.buffer, importBatch);
  const { transactions: txResult, operations: opsResult } = parseResult;
  const parserWarnings: string[] = (parseResult as any).warnings ?? [];

  if (txResult.data.length === 0 && opsResult.data.length === 0) {
    return emptyResult(importBatch, [`Plik ${binary.label} nie zawiera rozpoznawalnych danych`]);
  }

  seedTickerMap(pid);

  if (binary.needsNameResolution) {
    for (const tx of txResult.data) {
      const existing = findIsinByName(tx.paperName, pid);
      if (existing) tx.isin = existing.isin;
    }
  }

  const db = getDb(pid);
  let txInserted = 0;
  let opsInserted = 0;
  const insertedTxDuplicates: SkippedRow[] = [];
  const insertedOpsDuplicates: SkippedRow[] = [];

  const run = db.transaction(() => {
    if (txResult.data.length > 0) {
      const r = insertTransactionsWithDedup(txResult.data, pid);
      txInserted = r.inserted;
      insertedTxDuplicates.push(...r.duplicates);
    }
    if (opsResult.data.length > 0) {
      const r = insertOperationsWithDedup(opsResult.data, pid);
      opsInserted = r.inserted;
      insertedOpsDuplicates.push(...r.duplicates);
    }
  });
  run();

  const { resolved, unresolved } = txResult.data.length > 0
    ? await resolveUnknownIsins(txResult.data, pid)
    : { resolved: [], unresolved: [] };

  const unresolvedVisible = unresolved.filter(u => {
    const isinTxs = txResult.data.filter(t => t.isin === u.isin);
    const net = isinTxs.reduce((sum, t) => sum + (t.side === 'K' ? t.quantity : -t.quantity), 0);
    return Math.abs(net) > 0.001;
  });

  const allSkipped = [...txResult.skipped, ...insertedTxDuplicates, ...insertedOpsDuplicates];
  const orphanedSells = detectOrphanedSells(pid);

  return {
    success: true,
    transactionsImported: txInserted,
    operationsImported: opsInserted,
    errors: [],
    importBatch,
    detectedSource: binary.id,
    tickersResolved: resolved.length,
    tickersUnresolved: unresolvedVisible.map(u => u.paperName),
    skipped: allSkipped.length > 0 ? allSkipped : undefined,
    duplicatesSkipped: (insertedTxDuplicates.length + insertedOpsDuplicates.length) || undefined,
    orphanedSells: orphanedSells.length > 0 ? orphanedSells : undefined,
    warnings: parserWarnings.length > 0 ? parserWarnings : undefined,
  };
}

// ─── Bossa reconciliation: Wykup certyfikatów + Rozliczenie oferty ──────────

/**
 * Tworzy syntetyczną sprzedaż zamykającą otwartą pozycję dla każdego RedemptionMarker.
 *
 * W przeciwieństwie do poprzedniej implementacji (która pulltowała już wstawione CashOperation
 * z DB i równolegle trzymała je jako `deposit`), to podejście:
 * - Opiera się na markerach wyłuskanych wprost z CSV (parser decyduje).
 * - Nie zapisuje CashOperation dla wykupu/wezwania — syntetyczna sprzedaż jest jedynym cashflow.
 * - Uwzględnia prowizję z siostrzanego `Rozliczenie oferty - prowizja`.
 *
 * Zwraca liczbę dodanych syntetycznych sprzedaży.
 */
function reconcileBossaRedemptions(
  redemptions: RedemptionMarker[],
  pid: string,
  importBatch: string,
  warnings: string[]
): number {
  if (redemptions.length === 0) return 0;

  const allTx = getAllTransactions(pid);
  let added = 0;

  for (const red of redemptions) {
    const matchingTx = allTx.filter(t => t.paperName === red.ticker);
    if (matchingTx.length === 0) {
      warnings.push(`Bossa: ${red.description} bez pasujących zakupów w historii (ticker: ${red.ticker})`);
      continue;
    }

    const isin = matchingTx[0].isin;
    const bought = matchingTx.filter(t => t.side === 'K').reduce((s, t) => s + t.quantity, 0);
    const sold = matchingTx.filter(t => t.side === 'S').reduce((s, t) => s + t.quantity, 0);
    const openQty = bought - sold;
    if (openQty <= 0) {
      warnings.push(`Bossa: ${red.description} — pozycja ${red.ticker} już zamknięta, pomijam`);
      continue;
    }

    const grossValue = red.amount + red.commission; // brutto = wpływ + prowizja (prowizja jest osobnym ujemnym cashflow w CSV)
    const price = Math.round((grossValue / openQty) * 100) / 100;
    const syntheticSell: Transaction = {
      date: red.date,
      paperName: red.ticker,
      isin,
      quantity: openQty,
      side: 'S',
      price,
      value: grossValue,
      commission: red.commission,
      total: red.amount, // netto po prowizji — zgodne z Bossa CSV
      currency: red.currency,
      paymentCurrency: 'PLN',
      source: 'bossa',
      importBatch,
    };
    const r = insertTransactionsWithDedup([syntheticSell], pid);
    added += r.inserted;

    // Ticker map entry dla certyfikatu (żeby dashboard miał source cen).
    upsertTickerMapEntry({
      isin,
      ticker: red.ticker,
      name: red.ticker,
      exchange: 'GPW',
      currency: 'PLN',
      priceSource: 'stooq',
    }, pid);
  }

  return added;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function emptyResult(importBatch: string, errors: string[] = []): ImportResult {
  return {
    success: errors.length === 0,
    transactionsImported: 0,
    operationsImported: 0,
    errors,
    importBatch,
  };
}
