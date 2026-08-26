import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import type { DetectResult } from 'shared';
import { classifyFile, bulkImport, requiresOperationsFile } from '../services/import-service.js';
import {
  getTransactionsCount,
  clearImportedTransactions,
  getLastImportDate,
} from '../db/transactions-repo.js';
import { getOperationsCount, clearImportedOperations } from '../db/operations-repo.js';
import { asyncHandler } from '../middleware/async-handler.js';
import importGenericRouter from './import-generic.js';
import importQuarantineRouter from './import-quarantine.js';
import { clearQuarantine, countQuarantineByStatus } from '../db/quarantine-repo.js';
import { getActiveReimportNotices, dismissReimportNotice } from '../db/reimport-notices-repo.js';
import {
  dismissOrphanedSell,
  restoreOrphanedSell,
  clearOrphanDismissals,
} from '../db/orphaned-sells-repo.js';
import { getOrphanedSellsView } from '../services/orphaned-sells.js';
import { isFiniteNumber } from './validation.js';

const router = Router();

// Import uniwersalny (profile-driven) — /api/import/generic/*.
// Montowany PRZED error-middleware multera na końcu tego routera,
// więc błędy uploadu z sub-routera dostają te same czytelne 400/413.
router.use('/generic', importGenericRouter);

// Skrzynka "Do wyjaśnienia" — /api/import/quarantine/*.
router.use('/quarantine', importQuarantineRouter);

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
// IBKR eksportuje wyciągi per rok × konto — kilkanaście plików w jednej paczce to norma.
const MAX_TX_FILES = 25;
/** ING eksportuje historię finansową per waluta — kilka plików operacji w paczce. */
const MAX_OPS_FILES = 5;

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
    // Wiele plików operacji: ING eksportuje historię finansową osobno per waluta
    // rachunku (PLN, GBP, …); pozostali brokerzy wgrywają jeden.
    { name: 'operations', maxCount: MAX_OPS_FILES },
  ]),
  asyncHandler(async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]>;
    const txFiles = files?.transactions ?? [];
    const opsFiles = files?.operations ?? [];

    if (txFiles.length === 0 && opsFiles.length === 0) {
      return res.status(400).json({ error: 'Nie przesłano żadnego pliku' });
    }

    const result = await bulkImport({
      transactionsFiles: txFiles.map((f) => ({ buffer: f.buffer, originalname: f.originalname })),
      operationsFiles: opsFiles.map((f) => ({ buffer: f.buffer, originalname: f.originalname })),
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
    // Kaskada: skrzynka "Do wyjaśnienia" w całości (wpisy resolved wskazywałyby
    // na usunięte rekordy transactions/cash_operations) + decyzje "Ignoruj"
    // dla sprzedaży bez kupna (dotyczyły usuniętych transakcji).
    clearQuarantine(pid);
    clearOrphanDismissals(pid);
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
    quarantinePending: countQuarantineByStatus(pid).pending,
    orphanedSellsPending: getOrphanedSellsView(pid).pending.length,
  });
});

// ── Prośby o ponowne wgranie wyciągu ─────────────────────────────────────────
// Zakładane przez migracje/skrypty, gdy poprawka parsera NIE MOŻE odtworzyć
// danych z bazy (wiersze przepadły przy imporcie). Dotychczasowy `needs_reimport`
// obsługuje tylko import uniwersalny — patrz db/reimport-notices-repo.ts.

/** GET /api/import/reimport-notices → lista aktywnych próśb */
router.get('/reimport-notices', (req, res) => {
  res.json({ notices: getActiveReimportNotices(req.portfolioId) });
});

/** POST /api/import/reimport-notices/:id/dismiss — odłożenie na bok. */
router.post('/reimport-notices/:id/dismiss', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Nieprawidłowy identyfikator' });
  }
  const ok = dismissReimportNotice(req.portfolioId, id);
  if (!ok) return res.status(404).json({ error: 'Nie znaleziono aktywnej prośby' });
  return res.json({ dismissed: true });
});

// ── Sprzedaże bez kupna ──────────────────────────────────────────────────────
// Detekcja liczona na żywo z transakcji (znika sama po dodaniu kupna spin-off);
// trwała jest tylko decyzja "Ignoruj" — patrz services/orphaned-sells.ts.

/** GET /api/import/orphaned-sells → { pending, dismissed } */
router.get('/orphaned-sells', (req, res) => {
  res.json(getOrphanedSellsView(req.portfolioId));
});

/** POST /api/import/orphaned-sells/dismiss — trwałe "Ignoruj" pozycji. */
router.post('/orphaned-sells/dismiss', (req, res) => {
  const { isin, missingQuantity } = req.body as { isin?: string; missingQuantity?: number };
  if (!isin || typeof isin !== 'string') {
    return res.status(400).json({ error: 'Wymagane pole: isin' });
  }
  if (!isFiniteNumber(missingQuantity)) {
    return res.status(400).json({ error: 'Pole missingQuantity musi być skończoną liczbą' });
  }
  dismissOrphanedSell(isin, missingQuantity, req.portfolioId);
  res.json({ success: true });
});

/** POST /api/import/orphaned-sells/restore — cofnięcie "Ignoruj" (ISIN w body:
 * pseudo-ISINy OPT: zawierają znaki niewygodne w ścieżce URL). */
router.post('/orphaned-sells/restore', (req, res) => {
  const { isin } = req.body as { isin?: string };
  if (!isin || typeof isin !== 'string') {
    return res.status(400).json({ error: 'Wymagane pole: isin' });
  }
  res.json({ success: restoreOrphanedSell(isin, req.portfolioId) });
});

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
