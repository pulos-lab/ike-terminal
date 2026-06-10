import { Router } from 'express';
import { BENCHMARKS, type ShareScope, type ShareSettingsInput, type ShareValidity } from 'shared';
import { asyncHandler } from '../middleware/async-handler.js';
import {
  createShare,
  deleteShareForPortfolio,
  getShareForPortfolio,
  updateShare,
} from '../db/share-repo.js';

/**
 * CRUD publicznego linku — montowany za requireAuth + portfolioMiddleware,
 * więc req.portfolioId jest zawsze zwalidowanym portfelem zalogowanego usera.
 */
const router = Router();

const VALID_SCOPES: ShareScope[] = ['chart', 'chart_positions'];
const VALID_VALIDITY: ShareValidity[] = ['indefinite', '7d', '30d', '90d'];

function parseSettings(body: unknown): ShareSettingsInput | null {
  const { scope, showAmounts, benchmark, validity } = (body ?? {}) as Record<string, unknown>;
  if (!VALID_SCOPES.includes(scope as ShareScope)) return null;
  if (typeof showAmounts !== 'boolean') return null;
  if (typeof benchmark !== 'string' || !(benchmark in BENCHMARKS)) return null;
  if (!VALID_VALIDITY.includes(validity as ShareValidity)) return null;
  return {
    scope: scope as ShareScope,
    showAmounts,
    benchmark,
    validity: validity as ShareValidity,
  };
}

// GET /api/share — aktywny link dla bieżącego portfela (albo null)
router.get(
  '/',
  asyncHandler((req, res) => {
    const share = getShareForPortfolio(req.portfolioId);
    res.json({ share });
  }),
);

// POST /api/share — utwórz link (409 gdy już istnieje — UI woła najpierw GET,
// więc to tylko guard na race)
router.post(
  '/',
  asyncHandler((req, res) => {
    const settings = parseSettings(req.body);
    if (!settings) return res.status(400).json({ error: 'Nieprawidłowe ustawienia' });
    if (getShareForPortfolio(req.portfolioId)) {
      return res.status(409).json({ error: 'Portfel ma już aktywny link' });
    }
    const share = createShare(req.portfolioId, settings);
    res.json({ share });
  }),
);

// PUT /api/share — zmiana ustawień; token bez zmian, expiresAt przeliczane od teraz
router.put(
  '/',
  asyncHandler((req, res) => {
    const settings = parseSettings(req.body);
    if (!settings) return res.status(400).json({ error: 'Nieprawidłowe ustawienia' });
    const share = updateShare(req.portfolioId, settings);
    if (!share) return res.status(404).json({ error: 'Brak aktywnego linku' });
    res.json({ share });
  }),
);

// DELETE /api/share — natychmiastowe unieważnienie (hard delete)
router.delete(
  '/',
  asyncHandler((req, res) => {
    deleteShareForPortfolio(req.portfolioId);
    res.json({ success: true });
  }),
);

export default router;
