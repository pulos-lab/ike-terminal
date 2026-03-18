import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import type { BrokerType } from 'shared';
import { decodeCSVBuffer } from '../parsers/encoding.js';
import { parseBossaOperations } from '../parsers/bossa-operations.js';
import { detectBroker, getParserById, detectBinaryBroker, getBinaryParserById } from '../parsers/registry.js';
import { insertTransactions, getTransactionsCount, clearTransactions, getLastImportDate } from '../db/transactions-repo.js';
import { insertOperations, getOperationsCount, clearOperations } from '../db/operations-repo.js';
import { seedTickerMap, findIsinByName } from '../db/ticker-map-repo.js';
import { resolveUnknownIsins } from '../services/isin-resolver.js';

const router = Router();

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

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
router.post('/transactions', upload.single('file'), async (req, res) => {
  try {
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
        ? detectBinaryBroker(req.file.buffer)
        : getBinaryParserById(requestedBroker);

      if (!binaryParser) {
        return res.status(400).json({
          error: 'Nie rozpoznano formatu pliku XLSX. Wybierz dom maklerski z listy lub sprawdź czy plik jest poprawny.',
        });
      }

      const { transactions: txResult, operations: opsResult } = binaryParser.parse(req.file.buffer, importBatch);

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

      const txCount = txResult.data.length > 0 ? insertTransactions(txResult.data, pid) : 0;
      const opsCount = opsResult.data.length > 0 ? insertOperations(opsResult.data, pid) : 0;

      // Auto-resolve ISINs via Yahoo/Stooq lookups
      const { resolved, unresolved } = txResult.data.length > 0
        ? await resolveUnknownIsins(txResult.data, pid)
        : { resolved: [], unresolved: [] };

      return res.json({
        success: true,
        transactionsImported: txCount,
        operationsImported: opsCount,
        importBatch,
        total: getTransactionsCount(pid),
        detectedSource: binaryParser.id,
        tickersResolved: resolved.length,
        tickersUnresolved: unresolved.map(u => u.paperName),
        skipped: txResult.skipped.length > 0 ? txResult.skipped : undefined,
      });
    }

    // ── CSV path (Bossa, mBank, DEGIRO) ──
    const content = decodeCSVBuffer(req.file.buffer);

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

    const count = insertTransactions(transactions, pid);
    const { resolved, unresolved } = await resolveUnknownIsins(transactions, pid);

    res.json({
      success: true,
      transactionsImported: count,
      importBatch,
      total: getTransactionsCount(pid),
      detectedSource: parser.id,
      tickersResolved: resolved.length,
      tickersUnresolved: unresolved.map(u => u.paperName),
      skipped: skipped.length > 0 ? skipped : undefined,
    });
  } catch (error) {
    console.error('Import transactions error:', error);
    res.status(500).json({ error: 'Failed to import transactions' });
  }
});

// POST /api/import/operations - upload cash operations CSV
router.post('/operations', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const content = decodeCSVBuffer(req.file.buffer);
    const importBatch = randomUUID();

    // Parse operations (Bossa format)
    const { data: operations, skipped } = parseBossaOperations(content, importBatch);

    if (operations.length === 0) {
      const skippedInfo = skipped.length > 0
        ? ` Pominięto ${skipped.length} wierszy.`
        : '';
      return res.status(400).json({
        error: `Plik nie zawiera rozpoznawalnych operacji.${skippedInfo} Sprawdź czy to plik CSV z operacjami gotówkowymi z Bossy.`,
        skipped: skipped.length > 0 ? skipped : undefined,
      });
    }

    const pid = req.portfolioId;
    const count = insertOperations(operations, pid);

    res.json({
      success: true,
      operationsImported: count,
      importBatch,
      total: getOperationsCount(pid),
      skipped: skipped.length > 0 ? skipped : undefined,
    });
  } catch (error) {
    console.error('Import operations error:', error);
    res.status(500).json({ error: 'Failed to import operations' });
  }
});

// DELETE /api/import/clear - clear all imported data
router.delete('/clear', (req, res) => {
  try {
    const pid = req.portfolioId;
    clearTransactions(pid);
    clearOperations(pid);
    res.json({ success: true });
  } catch (error) {
    console.error('Clear data error:', error);
    res.status(500).json({ error: 'Failed to clear data' });
  }
});

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
