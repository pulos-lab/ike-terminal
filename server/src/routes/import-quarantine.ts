import { Router } from 'express';
import { asyncHandler } from '../middleware/async-handler.js';
import {
  countQuarantineByStatus,
  deleteQuarantineRow,
  getQuarantineRow,
  ignoreQuarantineRow,
  listQuarantineRows,
  markQuarantineRowReported,
  resolveQuarantineRow,
} from '../db/quarantine-repo.js';
import { getTransactionById } from '../db/transactions-repo.js';
import { getOperationById } from '../db/operations-repo.js';
import { upsertUnknownTypeReport } from '../db/type-aliases-repo.js';
import { redactSampleRows } from '../services/sample-redactor.js';
import { notifyNewUnknownTypeReport } from '../services/admin-notifications.js';

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

/**
 * POST /api/import/quarantine/:id/resolve — użytkownik sklasyfikował wiersz
 * i dodał wpis przez istniejący endpoint ręczny; tu tylko oznaczamy wiersz
 * jako rozstrzygnięty (z linkiem do wpisu). refId opcjonalny — para nóg FX
 * nie zwraca id z /portfolio/fx-exchanges.
 */
router.post(
  '/:id/resolve',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Nieprawidłowe id' });

    const { kind, refId, note } = (req.body ?? {}) as {
      kind?: string;
      refId?: number;
      note?: string;
    };
    if (kind !== 'transaction' && kind !== 'cash_operation') {
      return res.status(400).json({ error: 'kind musi być transaction albo cash_operation' });
    }
    if (refId !== undefined) {
      if (!Number.isInteger(refId)) {
        return res.status(400).json({ error: 'refId musi być liczbą całkowitą' });
      }
      const exists =
        kind === 'transaction' ? getTransactionById(refId, pid) : getOperationById(refId, pid);
      if (!exists) {
        return res
          .status(404)
          .json({ error: 'Wpis, na który wskazuje refId, nie istnieje w portfelu' });
      }
    }

    const ok = resolveQuarantineRow(
      id,
      { kind, refId, note: typeof note === 'string' ? note.slice(0, 500) : undefined },
      pid,
    );
    if (!ok) {
      return res.status(404).json({
        error: 'Nie znaleziono wiersza do rozstrzygnięcia (albo jest już rozstrzygnięty)',
      });
    }
    res.json({ success: true, row: getQuarantineRow(id, pid) });
  }),
);

/** Zredagowana treść zgłoszenia dla wiersza — jedno źródło prawdy dla podglądu
 * (GET /report-preview) i faktycznej wysyłki (POST /report): do globalnej bazy
 * NIGDY nie trafia nic, czego user nie zobaczył w podglądzie. */
function buildRedactedReport(row: {
  source: string;
  rawType?: string;
  headers?: string[];
  cells: string[];
}) {
  const headers = row.headers ?? row.cells.map((_, i) => `Kolumna ${i + 1}`);
  const sampleCells = redactSampleRows(headers, [row.cells])[0] ?? [];
  return { broker: row.source, rawType: row.rawType ?? null, headers, sampleCells };
}

/**
 * GET /api/import/quarantine/:id/report-preview — co DOKŁADNIE zostanie wysłane
 * do globalnej bazy zgłoszeń (transparentny podgląd redakcji przed zgodą).
 */
router.get(
  '/:id/report-preview',
  asyncHandler((req, res) => {
    const pid = req.portfolioId;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Nieprawidłowe id' });
    const row = getQuarantineRow(id, pid);
    if (!row) return res.status(404).json({ error: 'Nie znaleziono wiersza' });
    if (!row.rawType) {
      return res
        .status(400)
        .json({ error: 'Wiersz nie ma rozpoznanego typu operacji — nie można go zgłosić' });
    }
    res.json(buildRedactedReport(row));
  }),
);

/**
 * POST /api/import/quarantine/:id/report — zgłoszenie do globalnej bazy
 * (za jawnym kliknięciem użytkownika, po podglądzie redakcji):
 *  - wiersz pending → kind='unsupported' ("nie wiem / aplikacja tego nie
 *    obsługuje"), status wiersza → 'reported';
 *  - wiersz resolved → kind='classified' (sygnał luki parsera; classifiedAs
 *    mówi adminowi, jak user sklasyfikował wiersz), status zostaje 'resolved'.
 * E-mail do admina tylko przy NOWYM agregacie (broker, typ, kind).
 */
router.post(
  '/:id/report',
  asyncHandler(async (req, res) => {
    const pid = req.portfolioId;
    const userId = req.userId!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Nieprawidłowe id' });

    const row = getQuarantineRow(id, pid);
    if (!row) return res.status(404).json({ error: 'Nie znaleziono wiersza' });
    if (!row.rawType) {
      return res
        .status(400)
        .json({ error: 'Wiersz nie ma rozpoznanego typu operacji — nie można go zgłosić' });
    }
    if (row.status === 'ignored' || row.status === 'reported') {
      return res.status(400).json({ error: 'Wiersz jest już zgłoszony albo zignorowany' });
    }

    const { note, classifiedAs } = (req.body ?? {}) as { note?: string; classifiedAs?: string };
    const kind = row.status === 'resolved' ? 'classified' : 'unsupported';
    const redacted = buildRedactedReport(row);

    const result = upsertUnknownTypeReport({
      broker: row.source,
      rawType: row.rawType,
      kind,
      headers: redacted.headers,
      sampleCells: redacted.sampleCells,
      suggestion:
        classifiedAs || note
          ? {
              classifiedAs:
                typeof classifiedAs === 'string' ? classifiedAs.slice(0, 60) : undefined,
              note: typeof note === 'string' ? note.slice(0, 500) : undefined,
            }
          : undefined,
      reporterId: userId,
    });

    if (row.status === 'pending') {
      markQuarantineRowReported(id, pid, typeof note === 'string' ? note.slice(0, 500) : undefined);
    }

    if (result.isNew) {
      // Fire-and-forget — notyfikacja nigdy nie blokuje odpowiedzi.
      void notifyNewUnknownTypeReport({
        broker: row.source,
        rawType: row.rawType,
        kind,
        reporterUserId: userId,
      });
    }

    res.json({ success: true, sent: redacted, row: getQuarantineRow(id, pid) });
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
