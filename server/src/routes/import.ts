import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import type { BrokerType } from 'shared';
import { decodeCSVBuffer } from '../parsers/encoding.js';
import { parseBossaOperations } from '../parsers/bossa-operations.js';
import { detectBroker, getParserById } from '../parsers/registry.js';
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
    if (file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Dozwolone są tylko pliki CSV'));
    }
  },
});

// POST /api/import/transactions - upload transaction CSV
// Supports auto-detection or explicit broker selection via 'broker' form field
router.post('/transactions', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const content = decodeCSVBuffer(req.file.buffer);
    const importBatch = randomUUID();
    const pid = req.portfolioId;
    const requestedBroker = (req.body?.broker || 'auto') as BrokerType;

    // Resolve parser: explicit selection or auto-detect
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

    // Seed ticker map for ISIN lookups
    seedTickerMap(pid);

    // mBank doesn't provide ISINs — resolve ticker names to ISINs from existing ticker_map
    if (parser.needsNameResolution) {
      for (const tx of transactions) {
        const existing = findIsinByName(tx.paperName, pid);
        if (existing) {
          tx.isin = existing.isin;
        }
      }
    }

    const count = insertTransactions(transactions, pid);

    // Auto-resolve any ISINs not in the ticker_map via Yahoo/Stooq lookups
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
