import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import {
  countQuarantineByStatus,
  deleteQuarantineRow,
  getQuarantineRow,
  ignoreQuarantineRow,
  listQuarantineRows,
} from '../db/quarantine-repo.js';

// Skrzynka "Do wyjaśnienia" — wiersze importu, których parser nie rozpoznał.
// Montowana pod /api/import/quarantine (dziedziczy auth + portfolioMiddleware).

const router = Router();

const VALID_STATUSES = new Set(['pending', 'resolved', 'ignored', 'reported']);

/** GET /api/import/quarantine?status=pending → { rows, counts } */
router.get(
  '/',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const statusParam = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusParam && !VALID_STATUSES.has(statusParam)) {
      return res.status(400).json({ error: `Nieznany status: ${statusParam}` });
    }
    res.json({
      rows: listQuarantineRows(statusParam as any, pid),
      counts: countQuarantineByStatus(pid),
    });
  }),
);

/** POST /api/import/quarantine/:id/ignore — "to nie transakcja / nieistotne". */
router.post(
  '/:id/ignore',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Nieprawidłowe id' });
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined;
    const ok = ignoreQuarantineRow(id, note, pid);
    if (!ok) {
      return res
        .status(404)
        .json({ error: 'Nie znaleziono wiersza do zignorowania (albo jest już rozstrzygnięty)' });
    }
    res.json({ success: true, row: getQuarantineRow(id, pid) });
  }),
);

/** DELETE /api/import/quarantine/:id — twarde usunięcie wpisu ze skrzynki. */
router.delete(
  '/:id',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Nieprawidłowe id' });
    const ok = deleteQuarantineRow(id, pid);
    if (!ok) return res.status(404).json({ error: 'Nie znaleziono wiersza' });
    res.json({ success: true });
  }),
);

export default router;
