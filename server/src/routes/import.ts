import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import type { DetectResult } from 'shared';
import { classifyFile, bulkImport, requiresOperationsFile } from '../services/import-service.js';
import {
  getTransactionsCount,
  clearImportedTransactions,
  getLastImportDate,
  deleteTransactionsByBatch,
} from '../db/transactions-repo.js';
import {
  getOperationsCount,
  clearImportedOperations,
  deleteOperationsByBatch,
} from '../db/operations-repo.js';
import {
  getQuarantineByBatch,
  deleteQuarantineByBatch,
  getAllQuarantine,
} from '../db/import-quarantine-repo.js';
import { getAllImportBatches } from '../db/import-batches-repo.js';
import { deleteImportBatchMeta, getImportBatchMeta } from '../db/import-batch-meta-repo.js';
import { asyncHandler } from '../middleware/async-handler.js';
import importGenericRouter from './import-generic.js';

const router = Router();

// Import uniwersalny (profile-driven) — /api/import/generic/*.
// Montowany PRZED error-middleware multera na końcu tego routera,
// więc błędy uploadu z sub-routera dostają te same czytelne 400/413.
router.use('/generic', importGenericRouter);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
// IBKR eksportuje wyciągi per rok × konto — kilkanaście plików w jednej paczce to norma.
const MAX_TX_FILES = 25;

/** Błąd z fileFilter — rozpoznawany w error-middleware na końcu routera, mapowany na 400. */
class UnsupportedFileTypeError extends Error {
  constructor() {
    super('Dozwolone są tylko pliki CSV, XLSX i HTML (IBKR)');
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const isCSV = file.mimetype === 'text/csv' || name.endsWith('.csv');
    const isXLSX =
      file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      name.endsWith('.xlsx');
    // IBKR Activity Statement — HTML; treść weryfikuje detectCombinedBroker w classifyFile
    const isHTML = file.mimetype === 'text/html' || name.endsWith('.htm') || name.endsWith('.html');
    if (isCSV || isXLSX || isHTML) {
      cb(null, true);
    } else {
      cb(new UnsupportedFileTypeError());
    }
  },
});

/**
 * POST /api/import/detect
 * Klasyfikacja pojedynczego pliku (broker + rola) — używane przez UI, żeby zdecydować
 * czy pokazać drugie pole (operacje) wymagane dla Bossy/DEGIRO.
 */
router.post(
  '/detect',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Brak pliku' });
    const classified = await classifyFile(req.file);
    const result: DetectResult = {
      broker: classified.broker,
      fileRole: classified.role,
      requiresOperationsFile: requiresOperationsFile(classified.broker),
    };
    res.json(result);
  }),
);

/**
 * POST /api/import/bulk
 * Atomowy import — przyjmuje jeden lub wiele plików transakcji (`transactions`)
 * oraz opcjonalnie plik operacji (`operations`). Wiele plików transakcji jest
 * potrzebne np. dla Bossa, która eksportuje historię osobno per waluta
 * (hisPW-PLN.csv, hisPW-USD.csv, hisPW-EUR.csv). Wszystko leci w jednej
 * transakcji SQLite; per-broker cross-file reconciliation biegnie raz, po
 * insertach.
 */
router.post(
  '/bulk',
  upload.fields([
    { name: 'transactions', maxCount: MAX_TX_FILES },
    { name: 'operations', maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]>;
    const txFiles = files?.transactions ?? [];
    const opsFile = files?.operations?.[0];

    if (txFiles.length === 0 && !opsFile) {
      return res.status(400).json({ error: 'Nie przesłano żadnego pliku' });
    }

    const result = await bulkImport({
      transactionsFiles: txFiles.map((f) => ({ buffer: f.buffer, originalname: f.originalname })),
      operationsFile: opsFile
        ? { buffer: opsFile.buffer, originalname: opsFile.originalname }
        : undefined,
      portfolioId: req.portfolioId,
    });

    if (!result.success) {
      return res.status(400).json({ ...result, error: result.errors.join('; ') });
    }

    res.json({
      ...result,
      total: getTransactionsCount(req.portfolioId),
    });
  }),
);

/**
 * DELETE /api/import/clear — czyści wszystkie zaimportowane dane (używane do reset testów).
 * Nie dotyka ręcznych wpisów z innych endpointów (dividends, transactions POST) —
 * usuwa tylko wiersze z ustawionym import_batch.
 */
router.delete(
  '/clear',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    clearImportedTransactions(pid);
    clearImportedOperations(pid);
    res.json({ success: true });
  }),
);

/**
 * GET /api/import/status — liczniki + data ostatniego importu.
 */
router.get('/status', (req, res) => {
  const pid = req.portfolioId;
  res.json({
    transactions: getTransactionsCount(pid),
    operations: getOperationsCount(pid),
    lastImportDate: getLastImportDate(pid),
  });
});

/**
 * GET /api/import/batches — lista wszystkich batchy importów z licznikami.
 */
router.get(
  '/batches',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const batches = getAllImportBatches(pid);
    res.json({ batches });
  }),
);

/**
 * DELETE /api/import/batch/:importBatch — usuwa wszystkie transakcje i operacje
 * z danego batcha importu (cofnięcie importu). Czyści też kwarantannę batcha.
 */
router.delete(
  '/batch/:importBatch',
  asyncHandler((req, res) => {
    const { importBatch } = req.params;
    const pid = req.portfolioId;
    const txRemoved = deleteTransactionsByBatch(importBatch, pid);
    const opsRemoved = deleteOperationsByBatch(importBatch, pid);
    const qRemoved = deleteQuarantineByBatch(importBatch, pid);
    deleteImportBatchMeta(pid, importBatch);
    res.json({
      success: true,
      transactionsRemoved: txRemoved,
      operationsRemoved: opsRemoved,
      quarantineRemoved: qRemoved,
    });
  }),
);

/**
 * GET /api/import/quarantine — lista wszystkich rekordów kwarantanny.
 */
router.get(
  '/quarantine',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const records = getAllQuarantine(pid);
    res.json({ records });
  }),
);

/**
 * GET /api/import/quarantine/:importBatch — kwarantanna dla konkretnego batcha.
 */
router.get(
  '/quarantine/:importBatch',
  asyncHandler((req, res) => {
    const { importBatch } = req.params;
    const pid = req.portfolioId;
    const records = getQuarantineByBatch(importBatch, pid);
    res.json({ records });
  }),
);

/**
 * GET /api/import/batches/:importBatch/result — zapisany wynik importu (warnings, skipped, etc).
 */
router.get(
  '/batches/:importBatch/result',
  asyncHandler((req, res) => {
    const { importBatch } = req.params;
    const pid = req.portfolioId;
    const result = getImportBatchMeta(pid, importBatch);
    if (!result) {
      res.status(404).json({ error: 'Brak zapisanego wyniku dla tego importu.' });
      return;
    }
    res.json({ result });
  }),
);

/**
 * Error-middleware dla uploadu: błędy multera (limit rozmiaru) i fileFiltera
 * dostają czytelne 413/400 zamiast generycznego 500 z globalnego handlera.
 */
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `Plik jest za duży — maksymalny rozmiar to ${MAX_FILE_SIZE / (1024 * 1024)} MB`,
      });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        error: `Za dużo plików w jednej paczce — maksymalnie ${MAX_TX_FILES} plików transakcji. Podziel import na mniejsze paczki.`,
      });
    }
    return res.status(400).json({ error: `Błąd uploadu pliku: ${err.message}` });
  }
  if (err instanceof UnsupportedFileTypeError) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

export default router;
