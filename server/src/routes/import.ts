import { Router } from 'express';
import multer from 'multer';
import type { DetectResult } from 'shared';
import { decodeCSVBuffer } from '../parsers/encoding.js';
import { classifyFile, bulkImport, requiresOperationsFile } from '../services/import-service.js';
import { getTransactionsCount, clearTransactions, getLastImportDate } from '../db/transactions-repo.js';
import { getOperationsCount, clearOperations } from '../db/operations-repo.js';
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

/**
 * POST /api/import/detect
 * Klasyfikacja pojedynczego pliku (broker + rola) — używane przez UI, żeby zdecydować
 * czy pokazać drugie pole (operacje) wymagane dla Bossy/DEGIRO.
 */
router.post('/detect', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Brak pliku' });
  const classified = await classifyFile(req.file);
  const result: DetectResult = {
    broker: classified.broker,
    fileRole: classified.role,
    requiresOperationsFile: requiresOperationsFile(classified.broker),
  };
  res.json(result);
}));

/**
 * POST /api/import/bulk
 * Atomowy import — przyjmuje jeden lub wiele plików transakcji (`transactions`)
 * oraz opcjonalnie plik operacji (`operations`). Wiele plików transakcji jest
 * potrzebne np. dla Bossa, która eksportuje historię osobno per waluta
 * (hisPW-PLN.csv, hisPW-USD.csv, hisPW-EUR.csv). Wszystko leci w jednej
 * transakcji SQLite; per-broker cross-file reconciliation biegnie raz, po
 * insertach.
 */
router.post('/bulk', upload.fields([
  { name: 'transactions', maxCount: 10 },
  { name: 'operations', maxCount: 1 },
]), asyncHandler(async (req, res) => {
  const files = req.files as Record<string, Express.Multer.File[]>;
  const txFiles = files?.transactions ?? [];
  const opsFile = files?.operations?.[0];

  if (txFiles.length === 0 && !opsFile) {
    return res.status(400).json({ error: 'Nie przesłano żadnego pliku' });
  }

  const result = await bulkImport({
    transactionsFiles: txFiles.map(f => ({ buffer: f.buffer, originalname: f.originalname })),
    operationsFile: opsFile ? { buffer: opsFile.buffer, originalname: opsFile.originalname } : undefined,
    portfolioId: req.portfolioId,
  });

  if (!result.success) {
    return res.status(400).json({ ...result, error: result.errors.join('; ') });
  }

  res.json({
    ...result,
    total: getTransactionsCount(req.portfolioId),
  });
}));

/**
 * DELETE /api/import/clear — czyści wszystkie zaimportowane dane (używane do reset testów).
 * Nie dotyka ręcznych wpisów z innych endpointów (dividends, transactions POST).
 */
router.delete('/clear', asyncHandler((req, res) => {
  const pid = req.portfolioId;
  clearTransactions(pid);
  clearOperations(pid);
  res.json({ success: true });
}));

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

export default router;
