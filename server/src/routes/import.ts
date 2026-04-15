import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import type { BrokerType, CashOperation, SkippedRow } from 'shared';
import { decodeCSVBuffer } from '../parsers/encoding.js';
import { parseBossaOperations } from '../parsers/bossa-operations.js';
import { detectBroker, getParserById, detectBinaryBroker, getBinaryParserById, PARSER_REGISTRY } from '../parsers/registry.js';
import { insertTransactionsWithDedup, getTransactionsCount, clearTransactions, getLastImportDate, getTransactionsByIsin, updateTransaction, detectOrphanedSells } from '../db/transactions-repo.js';
import { insertOperationsWithDedup, getOperationsCount, clearOperations } from '../db/operations-repo.js';
import { seedTickerMap, findIsinByName } from '../db/ticker-map-repo.js';
import { resolveUnknownIsins } from '../services/isin-resolver.js';
import { asyncHandler } from '../middleware/async-handler.js';

const router = Router();

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const isCSV = file.mimetype === 'text/csv' || name.endsWith('.csv');
    const isXLSX = file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      || name.endsWith('.xlsx');
    if (isCSV || isXLSX) {
      cb(null, true);
    } else {
      cb(new Error('Dozwolone są tylko pliki CSV i XLSX'));
    }
  },
});

// POST /api/import/transactions - upload transaction CSV or XLSX
// Supports auto-detection or explicit broker selection via 'broker' form field
router.post('/transactions', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const importBatch = randomUUID();
  const pid = req.portfolioId;
  const requestedBroker = (req.body?.broker || 'auto') as BrokerType;
  const isXlsx = req.file.originalname.toLowerCase().endsWith('.xlsx');

  // ── XLSX path (XTB) ──
  if (isXlsx) {
    const binaryParser = requestedBroker === 'auto'
      ? await detectBinaryBroker(req.file.buffer)
      : getBinaryParserById(requestedBroker);

    if (!binaryParser) {
      return res.status(400).json({
        error: 'Nie rozpoznano formatu pliku XLSX. Wybierz dom maklerski z listy lub sprawdź czy plik jest poprawny.',
      });
    }

    const { transactions: txResult, operations: opsResult } = await binaryParser.parse(req.file.buffer, importBatch);

    if (txResult.data.length === 0 && opsResult.data.length === 0) {
      const skippedInfo = txResult.skipped.length > 0
        ? ` Pominięto ${txResult.skipped.length} wierszy.`
        : '';
      return res.status(400).json({
        error: `Plik nie zawiera rozpoznawalnych danych ${binaryParser.label}.${skippedInfo}`,
        skipped: txResult.skipped.length > 0 ? txResult.skipped : undefined,
      });
    }

    seedTickerMap(pid);

    // Resolve ticker names to ISINs from existing ticker_map
    if (binaryParser.needsNameResolution) {
      for (const tx of txResult.data) {
        const existing = findIsinByName(tx.paperName, pid);
        if (existing) {
          tx.isin = existing.isin;
        }
      }
    }

    const txDedup = txResult.data.length > 0
      ? insertTransactionsWithDedup(txResult.data, pid)
      : { inserted: 0, duplicates: [] };
    const opsDedup = opsResult.data.length > 0
      ? insertOperationsWithDedup(opsResult.data, pid)
      : { inserted: 0, duplicates: [] };

    const allSkipped = [...txResult.skipped, ...txDedup.duplicates, ...opsDedup.duplicates];
    const duplicatesSkipped = txDedup.duplicates.length + opsDedup.duplicates.length;

    // Auto-resolve ISINs via Yahoo/Stooq lookups
    const { resolved, unresolved } = txResult.data.length > 0
      ? await resolveUnknownIsins(txResult.data, pid)
      : { resolved: [], unresolved: [] };

    // Filter unresolved: skip ISINs with net 0 shares (fully closed positions)
    const unresolvedWithOpenPositions = unresolved.filter(u => {
      const isinTxs = txResult.data.filter(t => t.isin === u.isin);
      const net = isinTxs.reduce((sum, t) => sum + (t.side === 'K' ? t.quantity : -t.quantity), 0);
      return Math.abs(net) > 0.001;
    });

    const orphanedSells = detectOrphanedSells(pid);

    return res.json({
      success: true,
      transactionsImported: txDedup.inserted,
      operationsImported: opsDedup.inserted,
      importBatch,
      total: getTransactionsCount(pid),
      detectedSource: binaryParser.id,
      tickersResolved: resolved.length,
      tickersUnresolved: unresolvedWithOpenPositions.map(u => u.paperName),
      skipped: allSkipped.length > 0 ? allSkipped : undefined,
      duplicatesSkipped: duplicatesSkipped > 0 ? duplicatesSkipped : undefined,
      orphanedSells: orphanedSells.length > 0 ? orphanedSells : undefined,
    });
  }

  // ── CSV path (Bossa, mBank, DEGIRO) ──
  const content = decodeCSVBuffer(req.file.buffer);

  // Check if this CSV is an operations file (e.g. DEGIRO Account CSV) — redirect to operations flow
  if (requestedBroker === 'auto') {
    const opsParser = PARSER_REGISTRY.find(p => p.detectOperations?.(content));
    if (opsParser && opsParser.parseOperations) {
      const { data: operations, skipped: opsSkipped } = opsParser.parseOperations(content, importBatch);

      if (operations.length === 0) {
        const skippedInfo = opsSkipped.length > 0
          ? ` Pominięto ${opsSkipped.length} wierszy.`
          : '';
        return res.status(400).json({
          error: `Plik nie zawiera rozpoznawalnych operacji ${opsParser.label}.${skippedInfo}`,
          skipped: opsSkipped.length > 0 ? opsSkipped : undefined,
        });
      }

      const pid = req.portfolioId;
      const { inserted, duplicates } = insertOperationsWithDedup(operations, pid);

      // Apply transaction-specific taxes (Stamp Duty, French tax) to matching transactions
      let taxesApplied = 0;
      if (opsParser.parseTransactionTaxes) {
        const taxes = opsParser.parseTransactionTaxes(content);
        for (const tax of taxes) {
          const txs = getTransactionsByIsin(tax.isin, pid);
          // Find transaction on the same date
          const taxDate = tax.date.split('T')[0];
          const match = txs.find(t => t.date.startsWith(taxDate));
          if (match && match.id) {
            const newCommission = Math.round((match.commission + tax.amount) * 100) / 100;
            const newTotal = match.side === 'K'
              ? Math.round((match.value + newCommission) * 100) / 100
              : Math.round((match.value - newCommission) * 100) / 100;
            updateTransaction(match.id, { commission: newCommission, total: newTotal }, pid);
            taxesApplied++;
          }
        }
      }

      const allSkipped = [...opsSkipped, ...duplicates];

      return res.json({
        success: true,
        transactionsImported: 0,
        operationsImported: inserted,
        taxesApplied: taxesApplied > 0 ? taxesApplied : undefined,
        importBatch,
        total: getTransactionsCount(pid),
        detectedSource: opsParser.id,
        skipped: allSkipped.length > 0 ? allSkipped : undefined,
        duplicatesSkipped: duplicates.length > 0 ? duplicates.length : undefined,
      });
    }
  }

  const parser = requestedBroker === 'auto'
    ? detectBroker(content)
    : getParserById(requestedBroker);

  if (!parser) {
    return res.status(400).json({
      error: 'Nie rozpoznano formatu pliku. Wybierz dom maklerski z listy lub sprawdź czy plik CSV jest poprawny.',
    });
  }

  const { data: transactions, skipped } = parser.parse(content, importBatch);

  if (transactions.length === 0) {
    const skippedInfo = skipped.length > 0
      ? ` Pominięto ${skipped.length} wierszy.`
      : '';
    return res.status(400).json({
      error: `Plik nie zawiera rozpoznawalnych transakcji ${parser.label}.${skippedInfo} Sprawdź czy to prawidłowy eksport z ${parser.label}.`,
      skipped: skipped.length > 0 ? skipped : undefined,
    });
  }

  seedTickerMap(pid);

  if (parser.needsNameResolution) {
    for (const tx of transactions) {
      const existing = findIsinByName(tx.paperName, pid);
      if (existing) {
        tx.isin = existing.isin;
      }
    }
  }

  const { inserted, duplicates } = insertTransactionsWithDedup(transactions, pid);
  const { resolved, unresolved } = await resolveUnknownIsins(transactions, pid);

  // Filter unresolved: skip ISINs with net 0 shares (fully closed positions)
  const unresolvedWithOpenPositions = unresolved.filter(u => {
    const isinTxs = transactions.filter(t => t.isin === u.isin);
    const net = isinTxs.reduce((sum, t) => sum + (t.side === 'K' ? t.quantity : -t.quantity), 0);
    return Math.abs(net) > 0.001; // only show unresolved ISINs with open positions
  });

  const allSkipped = [...skipped, ...duplicates];
  const duplicatesSkipped = duplicates.length;

  const orphanedSells = detectOrphanedSells(pid);

  res.json({
    success: true,
    transactionsImported: inserted,
    importBatch,
    total: getTransactionsCount(pid),
    detectedSource: parser.id,
    tickersResolved: resolved.length,
    tickersUnresolved: unresolvedWithOpenPositions.map(u => u.paperName),
    skipped: allSkipped.length > 0 ? allSkipped : undefined,
    duplicatesSkipped: duplicatesSkipped > 0 ? duplicatesSkipped : undefined,
    orphanedSells: orphanedSells.length > 0 ? orphanedSells : undefined,
  });
}));

// POST /api/import/operations - upload cash operations CSV
router.post('/operations', upload.single('file'), asyncHandler((req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const content = decodeCSVBuffer(req.file.buffer);
  const importBatch = randomUUID();

  // Auto-detect operations format: try DEGIRO Account first, then Bossa
  let parseResult: { data: CashOperation[]; skipped: SkippedRow[] };
  let detectedSource: string = 'bossa';

  const opsParser = PARSER_REGISTRY.find(p => p.detectOperations?.(content));
  if (opsParser && opsParser.parseOperations) {
    parseResult = opsParser.parseOperations(content, importBatch);
    detectedSource = opsParser.id;
  } else {
    parseResult = parseBossaOperations(content, importBatch);
  }

  const { data: operations, skipped } = parseResult;

  if (operations.length === 0) {
    const skippedInfo = skipped.length > 0
      ? ` Pominięto ${skipped.length} wierszy.`
      : '';
    return res.status(400).json({
      error: `Plik nie zawiera rozpoznawalnych operacji.${skippedInfo} Sprawdź czy to plik CSV z operacjami gotówkowymi.`,
      skipped: skipped.length > 0 ? skipped : undefined,
    });
  }

  const pid = req.portfolioId;
  const { inserted, duplicates } = insertOperationsWithDedup(operations, pid);

  // Apply transaction-specific taxes to matching transactions (DEGIRO)
  let taxesApplied = 0;
  if (opsParser && opsParser.parseTransactionTaxes) {
    const taxes = opsParser.parseTransactionTaxes(content);
    for (const tax of taxes) {
      const txs = getTransactionsByIsin(tax.isin, pid);
      const taxDate = tax.date.split('T')[0];
      const match = txs.find(t => t.date.startsWith(taxDate));
      if (match && match.id) {
        const newCommission = Math.round((match.commission + tax.amount) * 100) / 100;
        const newTotal = match.side === 'K'
          ? Math.round((match.value + newCommission) * 100) / 100
          : Math.round((match.value - newCommission) * 100) / 100;
        updateTransaction(match.id, { commission: newCommission, total: newTotal }, pid);
        taxesApplied++;
      }
    }
  }

  const allSkipped = [...skipped, ...duplicates];
  const duplicatesSkipped = duplicates.length;

  res.json({
    success: true,
    operationsImported: inserted,
    importBatch,
    total: getOperationsCount(pid),
    skipped: allSkipped.length > 0 ? allSkipped : undefined,
    duplicatesSkipped: duplicatesSkipped > 0 ? duplicatesSkipped : undefined,
  });
}));

// DELETE /api/import/clear - clear all imported data
router.delete('/clear', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  clearTransactions(pid);
  clearOperations(pid);
  res.json({ success: true });
}));

// GET /api/import/status
router.get('/status', (req, res) => {
  const pid = req.portfolioId;
  res.json({
    transactions: getTransactionsCount(pid),
    operations: getOperationsCount(pid),
    lastImportDate: getLastImportDate(pid),
  });
});

export default router;
