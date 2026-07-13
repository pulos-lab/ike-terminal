/**
 * Panel typów operacji — /api/admin/type-aliases (requireAuth + requireAdmin
 * w index.ts). Dwa zasoby:
 *  - zgłoszenia (unknown_type_reports): kolejka nieznanych typów ze skrzynek
 *    "Do wyjaśnienia" użytkowników (kind: classified = luka parsera,
 *    unsupported = feature-gap) — approve tworzy alias, reject/wont-fix zamyka;
 *  - aliasy (operation_type_aliases): mapa (broker, surowy typ) → klasyfikacja,
 *    konsumowana przez parsery przy każdym imporcie; revoke wyłącza bez śladu
 *    retro (alias działa tylko na przyszłe importy).
 */
import { Router } from 'express';
import type { CashOperationAliasTarget, TypeAliasTarget, UnknownTypeReportStatus } from 'shared';
import {
  getUnknownTypeReport,
  listOperationTypeAliases,
  listUnknownTypeReports,
  revokeOperationTypeAlias,
  setUnknownTypeReportStatus,
  upsertOperationTypeAlias,
} from '../db/type-aliases-repo.js';
import { KNOWN_PARSER_TYPES, knownTypesForBroker } from '../parsers/known-types.js';
import { asyncHandler } from '../middleware/async-handler.js';

const router = Router();

/** GET /catalog — dozwolone targety do formularza approve (per broker + operationTypes). */
router.get('/catalog', (_req, res) => {
  res.json({
    parserTypes: Object.fromEntries(
      Object.entries(KNOWN_PARSER_TYPES).map(([broker, set]) => [broker, [...set].sort()]),
    ),
    operationTypes: [...ALIAS_OPERATION_TYPES],
  });
});

const REPORT_STATUSES = new Set(['open', 'approved', 'rejected', 'wont_fix']);
const REPORT_KINDS = new Set(['classified', 'unsupported']);

/** operationType dozwolone w targetach cash_operation (lustro walidacji parsera XTB). */
const ALIAS_OPERATION_TYPES = new Set([
  'deposit',
  'withdrawal',
  'dividend',
  'fee',
  'trade_fee',
  'commission_refund',
  'capital_return',
  'other',
]);

/** Walidacja targetu aliasu — zwraca komunikat błędu (PL) albo null gdy OK. */
function validateAliasTarget(broker: string, target: TypeAliasTarget): string | null {
  if (target.kind === 'ignore') return null;
  if (target.kind === 'parser_type') {
    const catalog = knownTypesForBroker(broker);
    if (!catalog) {
      return `Broker "${broker}" nie obsługuje aliasów parser_type (brak katalogu typów)`;
    }
    if (!target.value || !catalog.has(target.value)) {
      return `Target "${target.value ?? ''}" nie jest znanym typem parsera ${broker}. Dozwolone: ${[...catalog].join(', ')}`;
    }
    return null;
  }
  if (target.kind === 'cash_operation') {
    let parsed: CashOperationAliasTarget;
    try {
      parsed = JSON.parse(target.value ?? '');
    } catch {
      return 'Target cash_operation musi być poprawnym JSON-em';
    }
    if (!parsed?.operationType || !ALIAS_OPERATION_TYPES.has(parsed.operationType)) {
      return `operationType musi być jednym z: ${[...ALIAS_OPERATION_TYPES].join(', ')}`;
    }
    if (parsed.sign !== undefined && !['file', '+', '-'].includes(parsed.sign)) {
      return "sign musi być 'file', '+' albo '-'";
    }
    return null;
  }
  return 'Nieznany rodzaj targetu';
}

function parseTargetFromBody(body: unknown): TypeAliasTarget | null {
  const b = body as { targetKind?: string; targetValue?: string };
  if (!b?.targetKind || !['parser_type', 'cash_operation', 'ignore'].includes(b.targetKind)) {
    return null;
  }
  return {
    kind: b.targetKind as TypeAliasTarget['kind'],
    value: typeof b.targetValue === 'string' ? b.targetValue : undefined,
  };
}

/** GET /reports?status=open&kind= — kolejka zgłoszeń (kind='unsupported' = feature-gap). */
router.get('/reports', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
  if (status && !REPORT_STATUSES.has(status)) {
    return res.status(400).json({ error: `Nieznany status: ${status}` });
  }
  if (kind && !REPORT_KINDS.has(kind)) {
    return res.status(400).json({ error: `Nieznany kind: ${kind}` });
  }
  res.json({
    reports: listUnknownTypeReports({
      status: status as UnknownTypeReportStatus | undefined,
      kind: kind as 'classified' | 'unsupported' | undefined,
    }),
  });
});

/** GET /reports/:id — detal ze zredagowaną próbką i sugestiami użytkowników. */
router.get('/reports/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Nieprawidłowe id' });
  const report = getUnknownTypeReport(id);
  if (!report) return res.status(404).json({ error: 'Zgłoszenie nie istnieje' });
  res.json({ report });
});

/**
 * POST /reports/:id/approve — tworzy/aktualizuje alias APPROVED dla
 * (broker, raw_type) zgłoszenia i zamyka zgłoszenie. Od następnego importu
 * typ działa automatycznie dla wszystkich użytkowników (bez deployu).
 */
router.post(
  '/reports/:id/approve',
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Nieprawidłowe id' });
    const report = getUnknownTypeReport(id);
    if (!report) return res.status(404).json({ error: 'Zgłoszenie nie istnieje' });

    const target = parseTargetFromBody(req.body);
    if (!target) {
      return res
        .status(400)
        .json({ error: 'targetKind musi być parser_type, cash_operation albo ignore' });
    }
    const validationError = validateAliasTarget(report.broker, target);
    if (validationError) return res.status(400).json({ error: validationError });

    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined;
    const alias = upsertOperationTypeAlias({
      broker: report.broker,
      rawType: report.rawType,
      target,
      status: 'approved',
      actorUserId: req.userId!,
      note,
      reportId: id,
    });
    setUnknownTypeReportStatus(id, 'approved', req.userId!, note);
    res.json({ success: true, alias, report: getUnknownTypeReport(id) });
  }),
);

/** POST /reports/:id/reject — zgłoszenie odrzucone (np. duplikat/nieczytelne). */
router.post(
  '/reports/:id/reject',
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Nieprawidłowe id' });
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined;
    if (!setUnknownTypeReportStatus(id, 'rejected', req.userId!, note)) {
      return res.status(404).json({ error: 'Zgłoszenie nie istnieje' });
    }
    res.json({ success: true, report: getUnknownTypeReport(id) });
  }),
);

/** POST /reports/:id/wont-fix — feature-gap odnotowany, świadomie poza zakresem. */
router.post(
  '/reports/:id/wont-fix',
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Nieprawidłowe id' });
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined;
    if (!setUnknownTypeReportStatus(id, 'wont_fix', req.userId!, note)) {
      return res.status(404).json({ error: 'Zgłoszenie nie istnieje' });
    }
    res.json({ success: true, report: getUnknownTypeReport(id) });
  }),
);

/** GET /aliases?broker= — pełna mapa aliasów (wszystkie statusy). */
router.get('/aliases', (req, res) => {
  const broker = typeof req.query.broker === 'string' ? req.query.broker : undefined;
  res.json({ aliases: listOperationTypeAliases(broker) });
});

/** POST /aliases — ręczne dodanie aliasu przez admina (bez zgłoszenia). */
router.post(
  '/aliases',
  asyncHandler((req, res) => {
    const { broker, rawType } = (req.body ?? {}) as { broker?: string; rawType?: string };
    if (!broker?.trim() || !rawType?.trim()) {
      return res.status(400).json({ error: 'Wymagane pola: broker, rawType' });
    }
    const target = parseTargetFromBody(req.body);
    if (!target) {
      return res
        .status(400)
        .json({ error: 'targetKind musi być parser_type, cash_operation albo ignore' });
    }
    const validationError = validateAliasTarget(broker, target);
    if (validationError) return res.status(400).json({ error: validationError });

    const alias = upsertOperationTypeAlias({
      broker,
      rawType,
      target,
      status: 'approved',
      actorUserId: req.userId!,
      note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined,
    });
    res.json({ success: true, alias });
  }),
);

/** POST /aliases/:id/revoke — wyłączenie aliasu (działa tylko na przyszłe importy). */
router.post(
  '/aliases/:id/revoke',
  asyncHandler((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Nieprawidłowe id' });
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined;
    if (!revokeOperationTypeAlias(id, req.userId!, note)) {
      return res.status(404).json({ error: 'Alias nie istnieje albo nie jest zatwierdzony' });
    }
    res.json({ success: true });
  }),
);

export default router;
