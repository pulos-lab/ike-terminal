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
import { findBondByTicker, inferBondNominal } from 'shared';
import { decodeCSVBuffer } from '../parsers/encoding.js';
import {
  detectBroker,
  detectCombinedBroker,
  isCombinedExtension,
  PARSER_REGISTRY,
  type CombinedParseOutput,
  type OperationsParseResult,
} from '../parsers/registry.js';
import type { TransactionTax } from '../parsers/degiro-operations.js';
import { upsertSplits } from '../db/splits-repo.js';
import { upsertOptionContracts } from '../db/option-contracts-repo.js';
import { computeTotal } from '../parsers/utils.js';
import {
  insertTransactionsWithDedup,
  getAllTransactions,
  getTransactionsByIsin,
  updateTransaction,
  recordAppliedTransactionTax,
  detectOrphanedSells,
} from '../db/transactions-repo.js';
import {
  insertOperationsWithDedup,
  insertOperation,
  getAllOperations,
} from '../db/operations-repo.js';
import {
  seedTickerMap,
  findIsinByName,
  upsertTickerMapEntry,
  getTickerByIsin,
  deleteTickerMapEntry,
} from '../db/ticker-map-repo.js';
import { resolveUnknownIsins } from './isin-resolver.js';
import { reconcilePaymentCurrencies } from './payment-currency-reconciler.js';
import { reconcileQuoteCurrencies } from './quote-currency-reconciler.js';
import { getDb } from '../db/connection.js';

// ─── File classification ─────────────────────────────────────────────────────

export interface ClassifiedFile {
  role: 'transactions' | 'operations' | 'unknown';
  broker: BrokerType | null;
  isBinary: boolean;
  buffer: Buffer;
  originalName: string;
}

export async function classifyFile(file: {
  buffer: Buffer;
  originalname: string;
}): Promise<ClassifiedFile> {
  // Pliki "combined" (XTB XLSX, IBKR HTML) zawierają transakcje + operacje w jednym pliku
  const isBinary = isCombinedExtension(file.originalname);

  if (isBinary) {
    const combined = await detectCombinedBroker(file.buffer, file.originalname);
    return {
      role: combined ? 'transactions' : 'unknown', // combined zawiera oba typy — traktujemy jako "transactions" z bonusem operacji
      broker: combined?.id ?? null,
      isBinary: true,
      buffer: file.buffer,
      originalName: file.originalname,
    };
  }

  const content = decodeCSVBuffer(file.buffer);

  // Najpierw sprawdź czy to plik operacji — operations detection ma pierwszeństwo
  // (DEGIRO Account, mBank historia finansowa, Bossa operacje_bez_transakcji).
  // Kolejność = kolejność w PARSER_REGISTRY (degiro → mbank → bossa).
  const opsParser = PARSER_REGISTRY.find((p) => p.detectOperations?.(content));
  if (opsParser) {
    return {
      role: 'operations',
      broker: opsParser.id,
      isBinary: false,
      buffer: file.buffer,
      originalName: file.originalname,
    };
  }

  // Jeśli to nie operacje, próbujemy transakcji.
  const txParser = detectBroker(content);
  if (txParser) {
    return {
      role: 'transactions',
      broker: txParser.id,
      isBinary: false,
      buffer: file.buffer,
      originalName: file.originalname,
    };
  }

  return {
    role: 'unknown',
    broker: null,
    isBinary: false,
    buffer: file.buffer,
    originalName: file.originalname,
  };
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
  const txFiles = await Promise.all(transactionsFiles.map((f) => classifyFile(f)));
  const opsFile = operationsFile ? await classifyFile(operationsFile) : null;

  // Walidacja ról
  for (const tx of txFiles) {
    if (tx.role !== 'transactions') {
      return emptyResult(importBatch, [
        `Plik "${tx.originalName}" nie wygląda na eksport transakcji (wykryto: ${tx.role}).`,
      ]);
    }
  }
  if (opsFile && opsFile.role !== 'operations') {
    return emptyResult(importBatch, [
      `Plik "${opsFile.originalName}" nie wygląda na eksport operacji gotówkowych (wykryto: ${opsFile.role}).`,
    ]);
  }

  // Wszystkie pliki transakcji muszą być z tego samego brokera (mixowanie
  // Bossa+DEGIRO w jednej paczce byłoby niejednoznaczne dla reconciliation).
  if (txFiles.length > 1) {
    const brokers = new Set(txFiles.map((t) => t.broker));
    if (brokers.size > 1) {
      return emptyResult(importBatch, [
        `Pliki transakcji pochodzą z różnych brokerów (${[...brokers].join(', ')}). ` +
          `Wgraj pliki z jednego brokera na raz.`,
      ]);
    }
    // Multi-file dla plików combined tylko gdy parser to deklaruje
    // (IBKR: wyciągi roczne per rok/konto; XTB XLSX pozostaje single-file).
    if (txFiles.some((t) => t.isBinary)) {
      const parser = await detectCombinedBroker(txFiles[0].buffer, txFiles[0].originalName);
      if (!parser?.supportsMultipleFiles) {
        return emptyResult(importBatch, [
          'Wgrywanie wielu plików nie jest wspierane dla XTB XLSX — wgraj jeden plik XTB naraz.',
        ]);
      }
    }
  }

  // Pliki combined (XTB XLSX single-file, IBKR HTML multi-file): transakcje +
  // operacje + markery reconciliation z jednego parsera, atomowo.
  if (txFiles.length > 0 && txFiles[0].isBinary) {
    return await importCombinedFiles(txFiles, importBatch, pid);
  }

  // CSV flow: parsujemy oba pliki, potem wsadzamy w jednej db.transaction()
  seedTickerMap(pid);

  let parsedTx: ParseResult<Transaction> | null = null;
  let parsedOps: OperationsParseResult | null = null;
  let txParserId: BrokerType | null = null;
  let opsParserId: BrokerType | null = null;
  let opsContentRaw: string | null = null;

  // Wyniki per plik — inserty idą osobno per plik, żeby dedup zliczeniowy
  // (porównanie z licznikiem w DB) wyłapywał nakładające się zakresy dat
  // MIĘDZY plikami w jednej paczce, zachowując legalne duplikaty wewnątrz
  // pojedynczego pliku.
  const parsedTxFiles: ParseResult<Transaction>[] = [];
  // Ostrzeżenia z parserów (PL) — doklejane do crossFileWarnings po jego deklaracji.
  const parserWarnings: string[] = [];

  if (txFiles.length > 0) {
    // Parsuj każdy plik osobno. Pierwszy wykryty broker dyktuje
    // parser dla całej paczki (już zwalidowaliśmy że wszystkie są tego samego).
    for (const file of txFiles) {
      const content = decodeCSVBuffer(file.buffer);
      const parser = detectBroker(content);
      if (!parser) {
        return emptyResult(importBatch, [
          `Nie rozpoznano formatu pliku transakcji: ${file.originalName}`,
        ]);
      }
      if (txParserId && parser.id !== txParserId) {
        return emptyResult(importBatch, [
          `Pliki transakcji mają różne formaty (pierwszy: ${txParserId}, ${file.originalName}: ${parser.id}).`,
        ]);
      }
      const parsed = parser.parse(content, importBatch);
      txParserId = parser.id;
      if (parsed.warnings?.length) parserWarnings.push(...parsed.warnings);

      // Name resolution (mBank: paperName → ISIN z ticker_map)
      if (parser.needsNameResolution) {
        for (const tx of parsed.data) {
          const existing = findIsinByName(tx.paperName, pid);
          if (existing) tx.isin = existing.isin;
        }
      }

      parsedTxFiles.push(parsed);
    }
    // Scalony widok dla reconciliation / ISIN-resolvera poniżej
    parsedTx = {
      data: parsedTxFiles.flatMap((p) => p.data),
      skipped: parsedTxFiles.flatMap((p) => p.skipped),
    };
  }

  // Parser operacji rozwiązywany czysto z registry — markery reconciliation
  // (redemptions / ipoSubscriptions / capitalReturns) siedzą w OperationsParseResult.
  const opsParser = opsFile ? PARSER_REGISTRY.find((p) => p.id === opsFile.broker) : undefined;
  if (opsFile && opsParser?.parseOperations) {
    const content = decodeCSVBuffer(opsFile.buffer);
    opsContentRaw = content;
    parsedOps = opsParser.parseOperations(content, importBatch);
    opsParserId = opsParser.id;
    if (parsedOps.warnings?.length) parserWarnings.push(...parsedOps.warnings);
  }

  // Atomowe inserty + reconciliation w jednej transakcji SQLite
  const db = getDb(pid);
  const result: ImportResult = emptyResult(importBatch);
  result.detectedSource = txParserId ?? undefined;
  result.detectedOperationsSource = opsParserId ?? undefined;

  const insertedTxDuplicates: SkippedRow[] = [];
  const insertedOpsDuplicates: SkippedRow[] = [];
  let syntheticSells = 0;
  const crossFileWarnings: string[] = [...parserWarnings];

  const runAll = db.transaction(() => {
    // 1. Transakcje — insert PER PLIK: licznik w DB rośnie po każdym pliku,
    // więc kopia tej samej transakcji w drugim pliku (nakładające się eksporty,
    // np. hisPW 2022-24 + hisPW 2023-25) zostaje wykryta jako duplikat.
    for (const pf of parsedTxFiles) {
      if (pf.data.length === 0) continue;
      const r = insertTransactionsWithDedup(pf.data, pid);
      result.transactionsImported += r.inserted;
      insertedTxDuplicates.push(...r.duplicates);
    }

    // 2. Operacje
    if (parsedOps && parsedOps.data.length > 0) {
      const r = insertOperationsWithDedup(parsedOps.data, pid);
      result.operationsImported = r.inserted;
      insertedOpsDuplicates.push(...r.duplicates);
    }

    // 3. Reconciliation — dispatch po OBECNOŚCI markerów z parsera operacji
    // (nie po id brokera; markery emituje obecnie tylko parser Bossy).

    // 3a. Redemption markers (tylko wykupy certyfikatów; tendery idą jako deposit + warning)
    if (parsedOps?.redemptions?.length) {
      const r = reconcileBossaRedemptions(
        parsedOps.redemptions,
        pid,
        importBatch,
        crossFileWarnings,
      );
      syntheticSells += r;
    }

    // 3a''. IPO subscriptions → synthetic K (znana cena emisyjna z mapy)
    if (parsedOps?.ipoSubscriptions?.length) {
      const r = reconcileBossaIpos(parsedOps.ipoSubscriptions, pid, importBatch, crossFileWarnings);
      syntheticSells += r;
    }

    // 3a'''. Capital return markers (obniżenie nominału, wyrównanie wykupu).
    // Wstawiamy jako CashOperation(operation_type='capital_return'); qty pozycji bez zmian.
    // Engine traktuje capital_return jak "dywidendę z kapitału" — wchodzi do totalValue,
    // nie do totalDeposited → MWR/TWR poprawnie.
    if (parsedOps?.capitalReturns?.length) {
      reconcileBossaCapitalReturns(parsedOps.capitalReturns, pid, importBatch, crossFileWarnings);
    }

    // 3a'. Bossa — nieznane wezwania skupu (corporate_action_pending/unknown_tender);
    // emit warning zachęcający do domknięcia sprzedaży (nie znamy liczby akcji i ceny tendera).
    // Celowo keyowane na brokerze: skan DB objąłby pending tendery Bossy także przy
    // imporcie innego brokera, dublując warningi.
    if (opsFile?.broker === 'bossa') {
      warnAboutTenderOffers(pid, crossFileWarnings);
    }

    // 3b. Transaction taxes z pliku operacji (hook registry — obecnie tylko DEGIRO).
    // Applied cross-batch (nawet jeśli user wgrał transakcje osobno wcześniej).
    if (opsParser?.parseTransactionTaxes && opsContentRaw) {
      const taxes = opsParser.parseTransactionTaxes(opsContentRaw);
      const applied = applyTransactionTaxes(taxes, opsParser.label, pid, crossFileWarnings);
      if (applied > 0) result.taxesApplied = applied;
    }
  });
  runAll();

  // Self-healing: usuń legacy stuby z ticker_map dla ISIN-ów, które trafiły do reconciliation
  // jako tender/IPO. Stare wersje kodu wpisywały tam ticker brokerowy (np. "MOSTALZAB"),
  // co blokowało resolverowi znalezienie prawdziwego Yahoo tickera (np. "MSZ.WA").
  // Kryterium "stuba": ticker === name i brak kropki (Yahoo/Stooq zawsze mają `.WA` lub podobne
  // dla polskich spółek; gdyby to był prawdziwy ticker jak "AAPL" — name byłoby "Apple Inc.").
  const reconciledIsinsNeedingRealTicker = new Set<string>();
  for (const red of parsedOps?.redemptions ?? []) {
    if (red.kind !== 'certificate') {
      // Znajdź ISIN z transakcji dla tego tickera
      const tx = parsedTx?.data.find((t) => t.paperName === red.ticker);
      if (tx) reconciledIsinsNeedingRealTicker.add(tx.isin);
    }
  }
  for (const ipo of parsedOps?.ipoSubscriptions ?? []) {
    reconciledIsinsNeedingRealTicker.add(ipo.isin);
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
      const isinTxs = parsedTx.data.filter((t) => t.isin === u.isin);
      const net = isinTxs.reduce((sum, t) => sum + (t.side === 'K' ? t.quantity : -t.quantity), 0);
      if (Math.abs(net) > 0.001) {
        upsertTickerMapEntry(
          {
            isin: u.isin,
            ticker: u.paperName,
            name: u.paperName,
            exchange: 'GPW',
            currency: 'PLN',
            priceSource: 'stooq',
          },
          pid,
        );
      }
    }
  }

  // Filtr unresolved: pokazuj tylko te z otwartymi pozycjami
  const unresolvedVisible = parsedTx
    ? unresolved.filter((u) => {
        const isinTxs = parsedTx!.data.filter((t) => t.isin === u.isin);
        const net = isinTxs.reduce(
          (sum, t) => sum + (t.side === 'K' ? t.quantity : -t.quantity),
          0,
        );
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
    tickersUnresolved: unresolvedVisible.map((u) => u.paperName),
    skipped: allSkipped.length > 0 ? allSkipped : undefined,
    duplicatesSkipped: duplicatesSkipped > 0 ? duplicatesSkipped : undefined,
    orphanedSells: orphanedSells.length > 0 ? orphanedSells : undefined,
    syntheticSells: syntheticSells > 0 ? syntheticSells : undefined,
    crossFileWarnings: crossFileWarnings.length > 0 ? crossFileWarnings : undefined,
  };
}

// ─── Combined path (XTB XLSX single-file, IBKR HTML multi-file) ──────────────

async function importCombinedFiles(
  files: ClassifiedFile[],
  importBatch: string,
  pid: string,
): Promise<ImportResult> {
  const parser = await detectCombinedBroker(files[0].buffer, files[0].originalName);
  if (!parser) {
    return emptyResult(importBatch, ['Nie rozpoznano formatu pliku']);
  }

  // Parsowanie wszystkich plików (poza transakcją SQLite — czysty CPU/IO)
  const parsedFiles: Array<{ name: string; output: CombinedParseOutput }> = [];
  const parserWarnings: string[] = [];
  for (const file of files) {
    const fileParser = await detectCombinedBroker(file.buffer, file.originalName);
    if (fileParser?.id !== parser.id) {
      return emptyResult(importBatch, [
        `Plik "${file.originalName}" nie wygląda na eksport ${parser.label}.`,
      ]);
    }
    const output = await parser.parse(file.buffer, importBatch, file.originalName);
    if (output.warnings?.length) parserWarnings.push(...output.warnings);
    parsedFiles.push({ name: file.originalName, output });
  }

  const allTxData = parsedFiles.flatMap((p) => p.output.transactions.data);
  const allOpsData = parsedFiles.flatMap((p) => p.output.operations.data);
  if (allTxData.length === 0 && allOpsData.length === 0) {
    return emptyResult(importBatch, [`Pliki ${parser.label} nie zawierają rozpoznawalnych danych`]);
  }

  seedTickerMap(pid);

  if (parser.needsNameResolution) {
    for (const tx of allTxData) {
      const existing = findIsinByName(tx.paperName, pid);
      if (existing) tx.isin = existing.isin;
    }
  }

  // Markery reconciliation zebrane ze wszystkich plików (dedup po naturalnych kluczach —
  // ten sam kontrakt/split pojawia się w wielu rocznikach; upserty są idempotentne).
  const allOptionContracts = dedupeBy(
    parsedFiles.flatMap((p) => p.output.optionContracts ?? []),
    (c) => c.isin,
  );
  const allSplits = dedupeBy(
    parsedFiles.flatMap((p) => p.output.splits ?? []),
    (s) => `${s.isin}|${s.exDate}`,
  );
  const allIsinChanges = dedupeBy(
    parsedFiles.flatMap((p) => p.output.isinChanges ?? []),
    (c) => `${c.oldIsin}|${c.newIsin}`,
  );
  const allTaxes: TransactionTax[] = parsedFiles.flatMap((p) => p.output.transactionTaxes ?? []);

  // Zmiany ISIN aplikujemy do sparsowanych danych PRZED insertem — inaczej re-import
  // pliku wstawiłby transakcję ze STARYM ISIN-em obok wiersza już przepisanego na nowy
  // (dedup liczy po ISIN-ie). UPDATE w DB (niżej) zostaje dla wierszy z wcześniejszych
  // batchy. Mapowanie z domknięciem łańcucha (A→B, B→C ⇒ A→C).
  const isinTarget = new Map(allIsinChanges.map((c) => [c.oldIsin, c.newIsin]));
  const resolveIsin = (isin: string): string => {
    let current = isin;
    for (let hops = 0; hops < 5; hops++) {
      const next = isinTarget.get(current);
      if (!next) return current;
      current = next;
    }
    return current;
  };
  if (isinTarget.size > 0) {
    for (const tx of allTxData) tx.isin = resolveIsin(tx.isin);
  }

  const db = getDb(pid);
  let txInserted = 0;
  let opsInserted = 0;
  let taxesApplied = 0;
  const insertedTxDuplicates: SkippedRow[] = [];
  const insertedOpsDuplicates: SkippedRow[] = [];

  const run = db.transaction(() => {
    // 1. Inserty PER PLIK — dedup zliczeniowy łapie nakładające się zakresy między plikami
    for (const pf of parsedFiles) {
      if (pf.output.transactions.data.length > 0) {
        const r = insertTransactionsWithDedup(pf.output.transactions.data, pid);
        txInserted += r.inserted;
        insertedTxDuplicates.push(...r.duplicates);
      }
      if (pf.output.operations.data.length > 0) {
        const r = insertOperationsWithDedup(pf.output.operations.data, pid);
        opsInserted += r.inserted;
        insertedOpsDuplicates.push(...r.duplicates);
      }
    }

    // 2. Seeding ticker_map dla opcji PRZED resolveUnknownIsins — pseudo-ISIN OPT:
    // nie istnieje w Yahoo/Stooq, a ticker OCC działa w Yahoo v8 chart wprost.
    for (const c of allOptionContracts) {
      if (!getTickerByIsin(c.isin, pid)) {
        upsertTickerMapEntry(
          {
            isin: c.isin,
            ticker: c.occTicker,
            name: `${c.underlying} ${c.strike} ${c.optionType === 'C' ? 'CALL' : 'PUT'} ${c.expiry}`,
            exchange: 'OTHER',
            currency: c.currency,
            priceSource: 'yahoo',
          },
          pid,
        );
      }
    }
    if (allOptionContracts.length > 0) {
      upsertOptionContracts(pid, allOptionContracts);
    }

    // 3. Zmiany ISIN (CUSIP change, reverse split z nowym ISIN) — PRZED zapisem splitów,
    // żeby split SPCE aplikował się już na nowym ISIN-ie spójnie z transakcjami.
    for (const change of allIsinChanges) {
      const updated = db
        .prepare('UPDATE transactions SET isin = ? WHERE isin = ?')
        .run(change.newIsin, change.oldIsin);
      deleteTickerMapEntry(change.oldIsin, pid);
      if (updated.changes > 0) {
        parserWarnings.push(
          `${parser.label}: zmiana ISIN ${change.oldIsin} → ${change.newIsin}` +
            `${change.symbol ? ` (${change.symbol})` : ''} — zaktualizowano ${updated.changes} transakcji.`,
        );
      }
    }

    // 4. Splity z Corporate Actions — realne ex-daty, source 'manual' (wygrywa z heurystyką)
    if (allSplits.length > 0) {
      upsertSplits(
        pid,
        allSplits.map((s) => ({
          isin: s.isin,
          ticker: s.ticker,
          splitDate: s.exDate,
          ratio: s.ratio,
          source: 'manual' as const,
        })),
      );
      parserWarnings.push(
        `${parser.label}: zapisano ${allSplits.length} split(y) z sekcji Corporate Actions ` +
          `(${allSplits.map((s) => `${s.ticker} ${s.ratio}:1`).join(', ')}).`,
      );
    }

    // 5. Podatki transakcyjne (FTT) — współdzielony helper z DEGIRO, idempotentny
    if (allTaxes.length > 0) {
      taxesApplied = applyTransactionTaxes(allTaxes, parser.label, pid, parserWarnings);
    }
  });
  run();

  const { resolved, unresolved } =
    allTxData.length > 0
      ? await resolveUnknownIsins(allTxData, pid)
      : { resolved: [], unresolved: [] };

  // Po resolwerze ticker_map ma walutę notowania z Yahoo — uzgadniamy etykietę
  // `currency` transakcji z wykrytym przewalutowaniem (parser nadał ją z suffixu
  // symbolu, który bywa mylący: ISAC.UK/EIMI.UK to klasy USD). Samoograniczające
  // (tylko fxRate>0 + mismatch), więc wołane bezwarunkowo.
  const quoteRecon = reconcileQuoteCurrencies(pid);
  parserWarnings.push(...quoteRecon.warnings);

  const unresolvedVisible = unresolved.filter((u) => {
    const isinTxs = allTxData.filter((t) => t.isin === u.isin);
    const net = isinTxs.reduce((sum, t) => sum + (t.side === 'K' ? t.quantity : -t.quantity), 0);
    return Math.abs(net) > 0.001;
  });

  const allSkipped = [
    ...parsedFiles.flatMap((p) => [
      ...p.output.transactions.skipped,
      ...p.output.operations.skipped,
    ]),
    ...insertedTxDuplicates,
    ...insertedOpsDuplicates,
  ];
  // detectOrphanedSells liczy surowe sumy K/S — sprzedaż po splicie "przekracza" kupno
  // sprzed splitu. Dla ISIN-ów ze splitem zapisanym w tym imporcie (realne ex-daty z
  // wyciągu) korektę robi silnik, więc warning byłby fałszywym alarmem.
  const splitIsins = new Set(allSplits.map((s) => s.isin));
  const orphanedSells = detectOrphanedSells(pid).filter((o) => !splitIsins.has(o.isin));

  return {
    success: true,
    transactionsImported: txInserted,
    operationsImported: opsInserted,
    errors: [],
    importBatch,
    detectedSource: parser.id,
    tickersResolved: resolved.length,
    tickersUnresolved: unresolvedVisible.map((u) => u.paperName),
    skipped: allSkipped.length > 0 ? allSkipped : undefined,
    duplicatesSkipped: insertedTxDuplicates.length + insertedOpsDuplicates.length || undefined,
    orphanedSells: orphanedSells.length > 0 ? orphanedSells : undefined,
    taxesApplied: taxesApplied > 0 ? taxesApplied : undefined,
    warnings: parserWarnings.length > 0 ? parserWarnings : undefined,
  };
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    if (!seen.has(key(item))) seen.set(key(item), item);
  }
  return [...seen.values()];
}

/**
 * Dolicza podatki transakcyjne (stamp duty / FTT) do prowizji pasujących transakcji.
 * Idempotentne przez `applied_transaction_taxes` (UNIQUE) — reimport tego samego pliku
 * nie zwiększy prowizji drugi raz. W obrębie batcha każdy (transakcja, opis podatku)
 * dostaje podatek najwyżej raz — dwa same-day trade'y tego samego ISIN-u dostają po
 * jednym stamp duty zamiast obu na pierwszym. Współdzielone przez ścieżkę CSV (DEGIRO)
 * i combined (IBKR). Zwraca liczbę doliczonych podatków.
 */
function applyTransactionTaxes(
  taxes: TransactionTax[],
  parserLabel: string,
  pid: string,
  warnings: string[],
): number {
  let applied = 0;
  const usedInBatch = new Set<string>();
  const usedKey = (txId: number, desc: string) => `${txId}|${desc}`;
  for (const tax of taxes) {
    const txs = getTransactionsByIsin(tax.isin, pid);
    const taxDate = tax.date.split('T')[0];
    const candidates = txs.filter((t) => t.date.startsWith(taxDate));
    const match =
      candidates.find((t) => t.id && !usedInBatch.has(usedKey(t.id, tax.description))) ??
      candidates[0];
    if (match?.id) {
      // recordAppliedTransactionTax zwraca false przy reimporcie tego
      // samego podatku — wtedy prowizja jest już powiększona, nie doliczamy.
      const isNew = recordAppliedTransactionTax(
        {
          transactionId: match.id,
          isin: tax.isin,
          taxDate: tax.date,
          description: tax.description,
          amount: tax.amount,
        },
        pid,
      );
      if (!isNew) continue;
      usedInBatch.add(usedKey(match.id, tax.description));
      const newCommission = Math.round((match.commission + tax.amount) * 100) / 100;
      const newTotal = computeTotal(match.side, match.value, newCommission);
      updateTransaction(match.id, { commission: newCommission, total: newTotal }, pid);
      applied++;
    } else {
      warnings.push(
        `${parserLabel}: ${tax.description} dla ISIN ${tax.isin} z ${taxDate} nie znalazł pasującej transakcji`,
      );
    }
  }
  return applied;
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
  warnings: string[],
): number {
  if (redemptions.length === 0) return 0;
  let added = 0;

  // Load all transactions once and group by ticker to avoid N+1 DB queries
  const allTx = getAllTransactions(pid);
  const txByTicker = new Map<string, typeof allTx>();
  for (const t of allTx) {
    let arr = txByTicker.get(t.paperName);
    if (!arr) {
      arr = [];
      txByTicker.set(t.paperName, arr);
    }
    arr.push(t);
  }

  for (const red of redemptions) {
    const allTxForTicker = txByTicker.get(red.ticker) || [];
    if (allTxForTicker.length === 0) {
      warnings.push(
        `Bossa: ${red.description} bez pasujących zakupów w historii (ticker: ${red.ticker}) — pomijam syntetyczną sprzedaż`,
      );
      continue;
    }

    const isin = allTxForTicker[0].isin;
    const bought = allTxForTicker.filter((t) => t.side === 'K').reduce((s, t) => s + t.quantity, 0);
    const sold = allTxForTicker.filter((t) => t.side === 'S').reduce((s, t) => s + t.quantity, 0);
    const openQty = bought - sold;
    if (openQty <= 0) {
      warnings.push(
        `Bossa: ${red.description} — pozycja ${red.ticker} już zamknięta (open=${openQty}), pomijam`,
      );
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
        warnings.push(
          `Bossa: ${red.description} — wyliczona ilość akcji <= 0 (amount=${red.amount}, tenderPrice=${red.tenderPrice}); pomijam`,
        );
        continue;
      }
      if (qty > openQty) {
        warnings.push(
          `Bossa: ${red.description} — wyliczono ${qty} szt, ale otwarta pozycja to tylko ${openQty}. Sprawdź czy pliki są kompletne.`,
        );
      }
      price = red.tenderPrice;
      commission = red.commission;
      originTag = `${red.description} — ${qty} szt @ ${price.toFixed(2)} ${red.currency} (cena z tender-offers-map${red.sourceUrl ? `, źródło: ${red.sourceUrl}` : ''})`;
    } else if (red.kind === 'bond') {
      // Wykup obligacji: qty = amount / nominał (wspiera częściowy wykup/amortyzację).
      // Cena syntetycznej S w % nominału — spójnie z kwotowaniem Catalyst i resztą
      // transakcji obligacyjnych (engine przelicza przez mnożnik nominal/100).
      const firstBuy = allTxForTicker.find((t) => t.side === 'K');
      const nominal =
        red.nominal ??
        findBondByTicker(red.ticker)?.nominal ??
        (firstBuy ? inferBondNominal(firstBuy.quantity, firstBuy.price, firstBuy.value) : null) ??
        1000;
      qty = Math.round(red.amount / nominal);
      if (qty <= 0) {
        warnings.push(
          `Bossa: ${red.description} — wyliczona ilość obligacji <= 0 (amount=${red.amount}, nominał=${nominal}); pomijam`,
        );
        continue;
      }
      if (qty > openQty) {
        warnings.push(
          `Bossa: ${red.description} — wyliczono ${qty} szt (nominał ${nominal}), ale otwarta pozycja to ${openQty}. ` +
            `Zamykam ${openQty} szt — sprawdź kompletność plików i nominał obligacji.`,
        );
        qty = openQty;
      } else if (qty < openQty) {
        warnings.push(
          `Bossa: ${red.description} — częściowy wykup ${qty}/${openQty} szt (nominał ${nominal}). ` +
            `Pozostała pozycja ${red.ticker}: ${openQty - qty} szt.`,
        );
      }
      price = Math.round((red.amount / qty / nominal) * 100 * 10000) / 10000;
      commission = 0;
      originTag = `${red.description} — ${qty} szt @ ${price.toFixed(2)}% nominału (${nominal} ${red.currency})`;
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
      category: red.kind === 'bond' ? 'bond' : undefined,
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
      upsertTickerMapEntry(
        {
          isin,
          ticker: red.ticker,
          name: red.ticker,
          exchange: 'GPW',
          currency: 'PLN',
          priceSource: 'stooq',
        },
        pid,
      );
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
  warnings: string[],
): number {
  if (ipos.length === 0) return 0;
  let added = 0;

  for (const ipo of ipos) {
    const nettoCost = ipo.subscriptionAmount - ipo.refundAmount;
    if (nettoCost <= 0) {
      warnings.push(
        `Bossa: subskrypcja IPO ${ipo.ticker} — koszt netto ${nettoCost.toFixed(2)} ${ipo.currency} jest ≤ 0 (pełny zwrot?); pomijam syntetyczną K.`,
      );
      continue;
    }

    const qty = Math.round(nettoCost / ipo.ipoPrice);
    if (qty <= 0) {
      warnings.push(
        `Bossa: subskrypcja IPO ${ipo.ticker} — wyliczona liczba akcji ≤ 0 (netto ${nettoCost}, cena ${ipo.ipoPrice}); pomijam.`,
      );
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
  const tenders = allOps.filter(
    (op) => op.operationType === 'corporate_action_pending' && op.subkind === 'unknown_tender',
  );
  for (const op of tenders) {
    warnings.push(
      `Bossa: ${op.description} (${op.date.slice(0, 10)}, ${op.amount.toFixed(2)} ${op.currency}) — ` +
        `broker zapisał tylko kwotę netto, bez liczby akcji. Domknij w panelu Zdarzenia korporacyjne ` +
        `(CTA "Domknij sprzedaż") albo dopisz ticker do tender-offers-map.ts i zaimportuj ponownie.`,
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
  warnings: string[],
): void {
  if (markers.length === 0) return;
  const allOps = getAllOperations(pid);

  for (const m of markers) {
    // Dedup: nie wstawiamy jeśli już istnieje identyczny capital_return dla tego ticker+date+amount.
    const exists = allOps.some(
      (op) =>
        op.operationType === 'capital_return' &&
        op.date === m.date &&
        op.ticker === m.ticker &&
        Math.abs(op.amount - m.amount) < 0.001 &&
        op.currency === m.currency,
    );
    if (exists) {
      warnings.push(
        `Bossa: Zwrot kapitału ${m.ticker} (${m.date.slice(0, 10)}, ${m.amount.toFixed(2)} ${m.currency}) już zaimportowany — pomijam duplikat.`,
      );
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
