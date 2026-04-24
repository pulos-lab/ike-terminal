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
  IpoSubscriptionMarker,
  CapitalReturnMarker,
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
import { insertOperationsWithDedup, insertOperation, getAllOperations } from '../db/operations-repo.js';
import { seedTickerMap, findIsinByName, upsertTickerMapEntry, getTickerByIsin, deleteTickerMapEntry } from '../db/ticker-map-repo.js';
import { resolveUnknownIsins } from './isin-resolver.js';
import { reconcilePaymentCurrencies } from './payment-currency-reconciler.js';
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
  /**
   * Pliki transakcji — co najmniej 0, praktycznie 1-3. Wiele plików jest
   * potrzebne np. dla Bossa, która eksportuje historię osobno per waluta
   * (hisPW-PLN.csv, hisPW-USD.csv, hisPW-EUR.csv). Wszystkie pliki muszą
   * pochodzić z tego samego brokera i być rolą `transactions`.
   */
  transactionsFiles?: Array<{ buffer: Buffer; originalname: string }>;
  operationsFile?: { buffer: Buffer; originalname: string };
  requestedBroker?: BrokerType;
  portfolioId: string;
}

export async function bulkImport(input: BulkInput): Promise<ImportResult> {
  const { portfolioId: pid, transactionsFiles = [], operationsFile } = input;
  const importBatch = randomUUID();

  if (transactionsFiles.length === 0 && !operationsFile) {
    return emptyResult(importBatch, ['Nie przesłano żadnego pliku']);
  }

  // Klasyfikacja każdego pliku transakcji osobno
  const txFiles = await Promise.all(transactionsFiles.map(f => classifyFile(f)));
  const opsFile = operationsFile ? await classifyFile(operationsFile) : null;

  // Walidacja ról
  for (const tx of txFiles) {
    if (tx.role !== 'transactions') {
      return emptyResult(importBatch, [`Plik "${tx.originalName}" nie wygląda na eksport transakcji (wykryto: ${tx.role}).`]);
    }
  }
  if (opsFile && opsFile.role !== 'operations') {
    return emptyResult(importBatch, [`Plik "${opsFile.originalName}" nie wygląda na eksport operacji gotówkowych (wykryto: ${opsFile.role}).`]);
  }

  // Wszystkie pliki transakcji muszą być z tego samego brokera (mixowanie
  // Bossa+DEGIRO w jednej paczce byłoby niejednoznaczne dla reconciliation).
  if (txFiles.length > 1) {
    const brokers = new Set(txFiles.map(t => t.broker));
    if (brokers.size > 1) {
      return emptyResult(importBatch, [
        `Pliki transakcji pochodzą z różnych brokerów (${[...brokers].join(', ')}). ` +
        `Wgraj pliki z jednego brokera na raz.`,
      ]);
    }
    // Multi-file wspierane tylko dla CSV brokerów. XTB XLSX to pojedynczy plik.
    if (txFiles.some(t => t.isBinary)) {
      return emptyResult(importBatch, [
        'Wgrywanie wielu plików nie jest wspierane dla XTB XLSX — wgraj jeden plik XTB naraz.',
      ]);
    }
  }

  // XTB XLSX: jeden plik, multi-sheet, atomowy z natury
  if (txFiles.length === 1 && txFiles[0].isBinary) {
    return await importBinary(txFiles[0], importBatch, pid);
  }

  // CSV flow: parsujemy oba pliki, potem wsadzamy w jednej db.transaction()
  seedTickerMap(pid);

  let parsedTx: ParseResult<Transaction> | null = null;
  let parsedOps: BossaOperationsParseResult | ParseResult<CashOperation> | null = null;
  let txParserId: BrokerType | null = null;
  let opsParserId: BrokerType | null = null;
  let opsContentRaw: string | null = null;

  if (txFiles.length > 0) {
    // Parsuj każdy plik osobno, łącz wyniki. Pierwszy wykryty broker dyktuje
    // parser dla całej paczki (już zwalidowaliśmy że wszystkie są tego samego).
    const mergedData: Transaction[] = [];
    const mergedSkipped: SkippedRow[] = [];
    for (const file of txFiles) {
      const content = decodeCSVBuffer(file.buffer);
      const parser = detectBroker(content);
      if (!parser) {
        return emptyResult(importBatch, [`Nie rozpoznano formatu pliku transakcji: ${file.originalName}`]);
      }
      if (txParserId && parser.id !== txParserId) {
        return emptyResult(importBatch, [
          `Pliki transakcji mają różne formaty (pierwszy: ${txParserId}, ${file.originalName}: ${parser.id}).`,
        ]);
      }
      const parsed = parser.parse(content, importBatch);
      txParserId = parser.id;

      // Name resolution (mBank: paperName → ISIN z ticker_map)
      if (parser.needsNameResolution) {
        for (const tx of parsed.data) {
          const existing = findIsinByName(tx.paperName, pid);
          if (existing) tx.isin = existing.isin;
        }
      }

      mergedData.push(...parsed.data);
      mergedSkipped.push(...parsed.skipped);
    }
    parsedTx = { data: mergedData, skipped: mergedSkipped };
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

    // 3a. Bossa — redemption markers (tylko wykupy certyfikatów; tendery idą jako deposit + warning)
    if (parsedOps && 'redemptions' in parsedOps && parsedOps.redemptions.length > 0) {
      const r = reconcileBossaRedemptions(parsedOps.redemptions, pid, importBatch, crossFileWarnings);
      syntheticSells += r;
    }

    // 3a''. Bossa — IPO subscriptions → synthetic K (znana cena emisyjna z mapy)
    if (parsedOps && 'ipoSubscriptions' in parsedOps && parsedOps.ipoSubscriptions.length > 0) {
      const r = reconcileBossaIpos(parsedOps.ipoSubscriptions, pid, importBatch, crossFileWarnings);
      syntheticSells += r;
    }

    // 3a'''. Bossa — capital return markers (obniżenie nominału, wyrównanie wykupu).
    // Wstawiamy jako CashOperation(operation_type='capital_return'); qty pozycji bez zmian.
    // Engine traktuje capital_return jak "dywidendę z kapitału" — wchodzi do totalValue,
    // nie do totalDeposited → MWR/TWR poprawnie.
    if (parsedOps && 'capitalReturns' in parsedOps && parsedOps.capitalReturns.length > 0) {
      reconcileBossaCapitalReturns(parsedOps.capitalReturns, pid, importBatch, crossFileWarnings);
    }

    // 3a'. Bossa — nieznane wezwania skupu (corporate_action_pending/unknown_tender);
    // emit warning zachęcający do domknięcia sprzedaży (nie znamy liczby akcji i ceny tendera).
    if (opsFile?.broker === 'bossa') {
      warnAboutTenderOffers(pid, crossFileWarnings);
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

  // Self-healing: usuń legacy stuby z ticker_map dla ISIN-ów, które trafiły do reconciliation
  // jako tender/IPO. Stare wersje kodu wpisywały tam ticker brokerowy (np. "MOSTALZAB"),
  // co blokowało resolverowi znalezienie prawdziwego Yahoo tickera (np. "MSZ.WA").
  // Kryterium "stuba": ticker === name i brak kropki (Yahoo/Stooq zawsze mają `.WA` lub podobne
  // dla polskich spółek; gdyby to był prawdziwy ticker jak "AAPL" — name byłoby "Apple Inc.").
  const reconciledIsinsNeedingRealTicker = new Set<string>();
  if (parsedOps && 'redemptions' in parsedOps) {
    for (const red of parsedOps.redemptions) {
      if (red.kind !== 'certificate') {
        // Znajdź ISIN z transakcji dla tego tickera
        const tx = parsedTx?.data.find(t => t.paperName === red.ticker);
        if (tx) reconciledIsinsNeedingRealTicker.add(tx.isin);
      }
    }
  }
  if (parsedOps && 'ipoSubscriptions' in parsedOps) {
    for (const ipo of parsedOps.ipoSubscriptions) {
      reconciledIsinsNeedingRealTicker.add(ipo.isin);
    }
  }
  for (const isin of reconciledIsinsNeedingRealTicker) {
    const entry = getTickerByIsin(isin, pid);
    if (entry && entry.ticker === entry.name && !entry.ticker.includes('.')) {
      deleteTickerMapEntry(isin, pid);
    }
  }

  // Po db.transaction: reconcile paymentCurrency na podstawie pełnego ledgera
  // walut (Bossa / DEGIRO). Bossa IKE/IKZE pozwala trzymać subkonta walutowe,
  // więc paymentCurrency zależy od stanu salda w momencie transakcji, nie od
  // stałej waluty konta. Idempotent — UPDATE tylko gdy obliczone różni się od
  // zapisanego. Musi być poza db.transaction bo czyta aktualny stan DB po
  // insercie i robi osobne UPDATE-y.
  const paymentRecon = reconcilePaymentCurrencies(pid, ['bossa', 'degiro']);
  if (paymentRecon.updatedCount > 0) {
    crossFileWarnings.push(
      `Zrekonsyliowano walutę rozliczenia dla ${paymentRecon.updatedCount} ` +
      `transakcji na podstawie salda walut (Bossa/DEGIRO).`,
    );
  }
  if (paymentRecon.warnings.length > 0) {
    crossFileWarnings.push(...paymentRecon.warnings);
  }

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
  const parseResult = await binary.parse(file.buffer, importBatch, file.originalName);
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

// ─── Bossa reconciliation: wykupy certyfikatów + wezwania skupu ze znaną ceną ─

/**
 * Obsługuje dwa rodzaje redemption markers:
 *
 * 1. `kind: 'certificate'` (Wykup certyfikatów INTL*): emitent wykupuje wszystkie wyemitowane
 *    certyfikaty po jednolitej cenie (NAV na datę wygaśnięcia). All-or-nothing, więc synthetic
 *    sell zamyka pełen openQty bezpiecznie. Cena = amount / openQty.
 *
 * 2. `kind: 'tender'` (Rozliczenie oferty — wezwanie skupu ze znaną ceną): parser znalazł
 *    wpis w `tender-offers-map.ts`, ma `tenderPrice`. Liczba akcji = `round(amount / tenderPrice)`.
 *    Prowizja z siostrzanego `Rozliczenie oferty - prowizja` jest przepisana na `Transaction.commission`.
 *
 * Wezwania spoza mapy NIE przechodzą tu — parser zostawia je jako deposit + fee, a service
 * wywołuje `warnAboutTenderOffers` (niżej) żeby user zobaczył prośbę o ręczne dodanie sprzedaży
 * lub o dopisanie wezwania do `tender-offers-map.ts`.
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
  let added = 0;

  for (const red of redemptions) {
    const allTxForTicker = getAllTransactions(pid).filter(t => t.paperName === red.ticker);
    if (allTxForTicker.length === 0) {
      warnings.push(`Bossa: ${red.description} bez pasujących zakupów w historii (ticker: ${red.ticker}) — pomijam syntetyczną sprzedaż`);
      continue;
    }

    const isin = allTxForTicker[0].isin;
    const bought = allTxForTicker.filter(t => t.side === 'K').reduce((s, t) => s + t.quantity, 0);
    const sold = allTxForTicker.filter(t => t.side === 'S').reduce((s, t) => s + t.quantity, 0);
    const openQty = bought - sold;
    if (openQty <= 0) {
      warnings.push(`Bossa: ${red.description} — pozycja ${red.ticker} już zamknięta (open=${openQty}), pomijam`);
      continue;
    }

    let qty: number;
    let price: number;
    let commission: number;
    let originTag: string;

    if (red.kind === 'tender' && red.tenderPrice) {
      // Wezwanie skupu ze znaną ceną — qty liczone po cenie z mapy.
      qty = Math.round(red.amount / red.tenderPrice);
      if (qty <= 0) {
        warnings.push(`Bossa: ${red.description} — wyliczona ilość akcji <= 0 (amount=${red.amount}, tenderPrice=${red.tenderPrice}); pomijam`);
        continue;
      }
      if (qty > openQty) {
        warnings.push(`Bossa: ${red.description} — wyliczono ${qty} szt, ale otwarta pozycja to tylko ${openQty}. Sprawdź czy pliki są kompletne.`);
      }
      price = red.tenderPrice;
      commission = red.commission;
      originTag = `${red.description} — ${qty} szt @ ${price.toFixed(2)} ${red.currency} (cena z tender-offers-map${red.sourceUrl ? `, źródło: ${red.sourceUrl}` : ''})`;
    } else {
      // Wykup certyfikatów — zamknij pełen openQty.
      qty = openQty;
      price = Math.round((red.amount / openQty) * 100) / 100;
      commission = 0;
      originTag = `${red.description} — ${qty} szt @ ${price.toFixed(2)} ${red.currency} (pełne zamknięcie pozycji przez emitenta)`;
    }

    const netTotal = red.amount - commission;
    const syntheticSell: Transaction = {
      date: red.date,
      paperName: red.ticker,
      isin,
      quantity: qty,
      side: 'S',
      price,
      value: red.amount,
      commission,
      total: netTotal,
      currency: red.currency,
      paymentCurrency: 'PLN',
      source: 'bossa',
      importBatch,
      syntheticOrigin: originTag,
    };
    const r = insertTransactionsWithDedup([syntheticSell], pid);
    added += r.inserted;

    // Tylko dla certyfikatów strukturyzowanych (INTL*) dopisujemy stub do ticker_map —
    // te papiery zwykle nie istnieją w Yahoo/Stooq, więc bez tego resolver by się poddał.
    // Dla wezwań skupu (tender) to normalne listed stocks (GAMIVO=GMV.WA, TSGAMES=TEN.WA,
    // MOSTALZAB=MSZ.WA itd.) — zostawiamy pustą mapę, żeby `resolveUnknownIsins` poszedł
    // swoją ścieżką i znalazł prawdziwy Yahoo ticker + źródło cen live.
    if (red.kind === 'certificate') {
      upsertTickerMapEntry({
        isin,
        ticker: red.ticker,
        name: red.ticker,
        exchange: 'GPW',
        currency: 'PLN',
        priceSource: 'stooq',
      }, pid);
    }
  }

  return added;
}

/**
 * Reconciliation subskrypcji IPO — dla każdego IpoSubscriptionMarker tworzy syntetyczną
 * K transakcję na dacie alokacji (Zwrot nadpłaty).
 *
 * Netto koszt = subscriptionAmount − refundAmount; qty = round(netto / ipoPrice). Cena
 * syntetycznej K = ipoPrice (nie uśredniamy, bo mamy deterministyczną wartość z mapy).
 *
 * Commission: w Bossie subskrypcja/zwrot nie ma oddzielnej prowizji, więc 0.
 *
 * Zwraca liczbę dodanych syntetycznych K.
 */
function reconcileBossaIpos(
  ipos: IpoSubscriptionMarker[],
  pid: string,
  importBatch: string,
  warnings: string[]
): number {
  if (ipos.length === 0) return 0;
  let added = 0;

  for (const ipo of ipos) {
    const nettoCost = ipo.subscriptionAmount - ipo.refundAmount;
    if (nettoCost <= 0) {
      warnings.push(`Bossa: subskrypcja IPO ${ipo.ticker} — koszt netto ${nettoCost.toFixed(2)} ${ipo.currency} jest ≤ 0 (pełny zwrot?); pomijam syntetyczną K.`);
      continue;
    }

    const qty = Math.round(nettoCost / ipo.ipoPrice);
    if (qty <= 0) {
      warnings.push(`Bossa: subskrypcja IPO ${ipo.ticker} — wyliczona liczba akcji ≤ 0 (netto ${nettoCost}, cena ${ipo.ipoPrice}); pomijam.`);
      continue;
    }

    const originTag = `Subskrypcja IPO ${ipo.ticker}${ipo.series ? ` Seria ${ipo.series}` : ''} — ${qty} szt @ ${ipo.ipoPrice.toFixed(2)} ${ipo.currency} (cena emisyjna z mapy${ipo.sourceUrl ? `, źródło: ${ipo.sourceUrl}` : ''})`;

    const syntheticBuy: Transaction = {
      date: `${ipo.allocationDate}T00:00:00`,
      paperName: ipo.ticker,
      isin: ipo.isin,
      quantity: qty,
      side: 'K',
      price: ipo.ipoPrice,
      value: nettoCost,
      commission: 0,
      total: nettoCost,
      currency: ipo.currency,
      paymentCurrency: 'PLN',
      source: 'bossa',
      importBatch,
      syntheticOrigin: originTag,
    };

    const r = insertTransactionsWithDedup([syntheticBuy], pid);
    added += r.inserted;

    // Celowo NIE wpisujemy stuba do ticker_map — papier subskrybowany z IPO to normalna spółka
    // notowana na GPW/NewConnect, więc resolver znajdzie ją pod prawdziwym Yahoo tickerem
    // (np. BIOCELTIX → BCL.WA). Inaczej stub "BIOCELTIX" zablokowałby live price lookup.
  }

  return added;
}

/**
 * Warnings dla nieznanych wezwań skupu (operation_type='corporate_action_pending',
 * subkind='unknown_tender'). Parser zapisał je jako pending, bo ticker nie ma wpisu w
 * tender-offers-map.ts. User może:
 *   a) domknąć ręcznie przez endpoint POST /api/portfolio/corporate-actions/:id/resolve
 *      (synthetic SELL z własnym qty+price), albo
 *   b) dopisać ticker do tender-offers-map.ts i zaimportować ponownie (wtedy reconciliation
 *      zamyka pozycję automatycznie).
 * Wywoływane PO insertach operacji.
 */
function warnAboutTenderOffers(pid: string, warnings: string[]): void {
  const allOps = getAllOperations(pid);
  const tenders = allOps.filter(op =>
    op.operationType === 'corporate_action_pending' && op.subkind === 'unknown_tender'
  );
  for (const op of tenders) {
    warnings.push(
      `Bossa: ${op.description} (${op.date.slice(0, 10)}, ${op.amount.toFixed(2)} ${op.currency}) — ` +
      `broker zapisał tylko kwotę netto, bez liczby akcji. Domknij w panelu Zdarzenia korporacyjne ` +
      `(CTA "Domknij sprzedaż") albo dopisz ticker do tender-offers-map.ts i zaimportuj ponownie.`
    );
  }
}

/**
 * Bossa reconciliation dla zwrotów kapitałowych (CapitalReturnMarker).
 *
 * Parser emituje markery dla:
 *   - 'nominal_reduction' — obniżenie wartości nominalnej (np. GETIN 8250 PLN 2022-12-30).
 *     Kapitał wraca do akcjonariusza, qty akcji bez zmian. MWR: liczy się jak zrealizowany
 *     zwrot (totalValue rośnie, totalDeposited bez zmian → return % rośnie poprawnie).
 *     TWR: portfolio value rośnie o amount w tym dniu bez netCashFlow → daily return pozytywny.
 *   - 'redemption_adjustment' — "Wykup PW - wyrównanie" (korekta po wcześniejszym wykupie).
 *     Najczęściej mała kwota (±kilka jednostek), czasem ujemna.
 *
 * Reconciliation wstawia do `cash_operations` jako operation_type='capital_return',
 * subkind=marker.kind, z dedup na (date, capital_return, amount, currency, ticker) — idempotent.
 * Nie tworzy transakcji — pozycja posiadana pozostaje nietknięta (źródłowa prawdą z CSV jest,
 * że akcje dalej są w portfelu, tylko nominał został obniżony).
 */
function reconcileBossaCapitalReturns(
  markers: CapitalReturnMarker[],
  pid: string,
  importBatch: string,
  warnings: string[]
): void {
  if (markers.length === 0) return;
  const allOps = getAllOperations(pid);

  for (const m of markers) {
    // Dedup: nie wstawiamy jeśli już istnieje identyczny capital_return dla tego ticker+date+amount.
    const exists = allOps.some(op =>
      op.operationType === 'capital_return'
      && op.date === m.date
      && op.ticker === m.ticker
      && Math.abs(op.amount - m.amount) < 0.001
      && op.currency === m.currency
    );
    if (exists) {
      warnings.push(`Bossa: Zwrot kapitału ${m.ticker} (${m.date.slice(0, 10)}, ${m.amount.toFixed(2)} ${m.currency}) już zaimportowany — pomijam duplikat.`);
      continue;
    }

    const op: CashOperation = {
      date: m.date,
      operationType: 'capital_return',
      description: m.description,
      details: m.originalTitle,
      amount: m.amount,
      currency: m.currency,
      ticker: m.ticker,
      source: 'bossa',
      importBatch,
      subkind: m.kind,
    };
    insertOperation(op, pid);
  }
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
