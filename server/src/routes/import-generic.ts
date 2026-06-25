/**
 * Import uniwersalny (profile-driven) — /api/import/generic/*.
 * Montowany wewnątrz routera /api/import (auth + portfolio middleware
 * dziedziczone z index.ts). Parsery wbudowane mają zawsze pierwszeństwo —
 * analyze odsyła znane formaty do /api/import/bulk.
 */
import { Router } from 'express';
import multer from 'multer';
import {
  analyzeGenericFiles,
  commitGenericDocuments,
  generateProfileForFile,
  listGenericBatches,
  previewGenericDocuments,
  reimportGenericBatchFromUpload,
} from '../services/generic-import-service.js';
import type { GenericSheetProfileInput } from 'shared';
import { isLlmEnabled, LlmUnavailableError } from '../services/llm-client.js';
import {
  llmDailyLimit,
  llmQuotaExceeded,
  registerLlmGenerationAttempt,
} from '../services/llm-quota.js';
import { GenericParseError } from '../parsers/generic/value-parsers.js';
import { asyncHandler } from '../middleware/async-handler.js';

const router = Router();

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB — spójnie z /api/import/bulk

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    // CSV i XLSX (XLSX = każdy arkusz z danymi przez ten sam silnik; znani
    // brokerzy XLSX, np. XTB, dalej skracają do /api/import/bulk w analyze).
    cb(null, name.endsWith('.csv') || name.endsWith('.xlsx'));
  },
});

/**
 * POST /api/import/generic/analyze — klasyfikacja pliku pod import uniwersalny:
 * znany broker → known:true; inaczej fingerprint + profil z biblioteki +
 * sugestie podobnych formatów + zredagowana próbka do kreatora mapowania.
 */
router.post(
  '/analyze',
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) return res.status(400).json({ error: 'Brak pliku' });
    res.json(
      await analyzeGenericFiles(
        files.map((f) => ({ buffer: f.buffer, originalname: f.originalname })),
      ),
    );
  }),
);

/**
 * POST /api/import/generic/generate-profile — generacja mapowania przez LLM.
 * Do API AI trafiają WYŁĄCZNIE nagłówki + zredagowana próbka (sample-redactor);
 * profil zapisuje się w bibliotece jako 'pending' (generatedBy='llm').
 * 503 = LLM wyłączony/niedostępny (UI → ścieżka ręczna), 422 = niska pewność.
 */
router.post(
  '/generate-profile',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Brak pliku' });
    if (!isLlmEnabled()) {
      return res.status(503).json({
        error: 'Generator mapowań (AI) jest niedostępny — możesz zmapować kolumny ręcznie.',
      });
    }
    // Anty-spam: każdy NOWY fingerprint = płatne wywołanie LLM. Limit dzienny
    // per użytkownik (uczciwy import kilku formatów go nie dotknie); 429 → UI
    // proponuje mapowanie ręczne. req.userId gwarantowany przez requireAuth.
    if (req.userId && llmQuotaExceeded(req.userId)) {
      return res.status(429).json({
        error:
          `Wyczerpano dzienny limit generacji mapowań (AI): ${llmDailyLimit()}. ` +
          'Spróbuj ponownie jutro albo zmapuj kolumny ręcznie.',
      });
    }
    if (req.userId) registerLlmGenerationAttempt(req.userId);
    try {
      const result = await generateProfileForFile({
        buffer: req.file.buffer,
        originalname: req.file.originalname,
        userId: req.userId,
        // XLSX: konkretny arkusz (wieloarkuszowy import generuje profil per arkusz).
        sheet: typeof req.body?.sheet === 'string' && req.body.sheet ? req.body.sheet : undefined,
      });
      if (!result) {
        return res.status(422).json({
          error:
            'Nie udało się wygenerować wiarygodnego mapowania dla tego pliku — ' +
            'zmapuj kolumny ręcznie.',
        });
      }
      res.json(result);
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        return res.status(503).json({ error: err.message });
      }
      if (err instanceof GenericParseError) {
        return res.status(422).json({ error: err.message });
      }
      throw err;
    }
  }),
);

/**
 * POST /api/import/generic/preview — wykonanie profilu BEZ zapisu.
 * multipart: file + `profile` (JSON, CSV) ALBO `sheets` (JSON tablica
 * {sheet, profileId|profileJson}, XLSX → podgląd scalony).
 */
router.post(
  '/preview',
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) return res.status(400).json({ error: 'Brak pliku' });
    const inputs = resolveDocumentInputs(req.body);
    if (inputs === undefined) {
      return res
        .status(400)
        .json({ error: 'Brak albo niepoprawny JSON w polu `inputs`/`sheets`/`profile`' });
    }
    const result = await previewGenericDocuments(
      files.map((f) => ({ buffer: f.buffer, originalname: f.originalname })),
      inputs,
    );
    res.status(result.ok ? 200 : 422).json(result);
  }),
);

/**
 * POST /api/import/generic/commit — atomowy import.
 * multipart: file + (`profileId` ALBO `profile`, CSV) ALBO `sheets` (JSON
 * tablica {sheet, profileId|profileJson}, XLSX → wszystkie arkusze w 1 import).
 */
router.post(
  '/commit',
  upload.array('files', 10),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) return res.status(400).json({ error: 'Brak pliku' });

    const inputs = resolveDocumentInputs(req.body);
    if (inputs === undefined || inputs.length === 0) {
      return res.status(400).json({
        error: 'Podaj `inputs` (profil per dokument) albo legacy `sheets`/`profileId`/`profile`',
      });
    }

    const result = await commitGenericDocuments({
      files: files.map((f) => ({ buffer: f.buffer, originalname: f.originalname })),
      inputs,
      portfolioId: req.portfolioId,
      userId: req.userId,
    });
    if (!result.success) {
      return res.status(400).json({ ...result, error: result.errors.join('; ') });
    }
    res.json(result);
  }),
);

/** GET /api/import/generic/batches — importy generyczne tego portfela. */
router.get('/batches', (req, res) => {
  res.json({ batches: listGenericBatches(req.portfolioId) });
});

/**
 * POST /api/import/generic/reimport/:importBatch — ponowne przetworzenie batcha
 * z pliku WGRANEGO PONOWNIE (multipart, pole `file`) aktualnym profilem z
 * biblioteki. Plików nie przechowujemy, więc korekta wymaga ponownego wgrania.
 */
router.post(
  '/reimport/:importBatch',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Brak pliku' });
    const result = await reimportGenericBatchFromUpload(req.portfolioId, req.params.importBatch, {
      buffer: req.file.buffer,
      originalname: req.file.originalname,
    });
    if (!result.success) {
      return res.status(400).json({ ...result, error: result.errors.join('; ') });
    }
    res.json(result);
  }),
);

/** Pole `profile` z multipart przychodzi jako string — parsuj defensywnie. */
function parseProfileField(raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Pole `sheets` (XLSX) — JSON tablica {sheet, profileId|profileJson}. */
function parseSheetsField(raw: unknown): GenericSheetProfileInput[] | undefined {
  const parsed = parseProfileField(raw);
  return Array.isArray(parsed) ? (parsed as GenericSheetProfileInput[]) : undefined;
}

/**
 * Wejścia profili per dokument: nowe `inputs` (multi-plik, JSON tablica
 * {file, sheet, profileId|profileJson}) albo legacy `sheets` (XLSX) /
 * `profileId`/`profile` (1 CSV). undefined = nic nie podano.
 */
function resolveDocumentInputs(body: unknown): GenericSheetProfileInput[] | undefined {
  const b = (body ?? {}) as Record<string, unknown>;
  const explicit = parseProfileField(b.inputs);
  if (Array.isArray(explicit)) return explicit as GenericSheetProfileInput[];
  const sheets = parseSheetsField(b.sheets);
  if (sheets !== undefined) return sheets;
  const profileId = typeof b.profileId === 'string' && b.profileId ? b.profileId : undefined;
  const profileJson = profileId ? undefined : parseProfileField(b.profile);
  if (profileId || profileJson !== undefined) {
    return [{ sheet: undefined, profileId, profileJson }];
  }
  return undefined;
}

export default router;
