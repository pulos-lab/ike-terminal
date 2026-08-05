import { Router, type Request, type Response, type NextFunction } from 'express';
import type { BenchmarkKey, PortfolioShare } from 'shared';
import { asyncHandler } from '../middleware/async-handler.js';
import { getShareByToken, deleteShareForPortfolio } from '../db/share-repo.js';
import { getPortfolio } from '../db/portfolio-registry.js';
import { buildHistoryView } from '../services/portfolio-views.js';
import { buildPositionsViewMemoized } from '../services/positions-memo.js';
import { toPublicHistory, toPublicPositions } from '../services/share-redaction.js';

/**
 * Publiczne endpointy share — montowane BEZ requireAuth/portfolioMiddleware.
 * Zawiera wyłącznie 3 GET-y; żadna mutacja nie istnieje pod /api/public.
 *
 * Jednolite 404 dla: złego formatu tokenu, nieistniejącego, wygasłego,
 * cofniętego linku i niedostępnego zakresu — brak wyroczni enumeracji.
 */
const router = Router();

// Strona i dane share nie mają być indeksowane
router.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

const NOT_FOUND = { error: 'Link nieprawidłowy lub wygasły' };

interface ShareLocals {
  share: PortfolioShare;
  portfolioName: string;
}

/** Walidacja tokenu + share + istnienia portfela. portfolioId pochodzi
 *  WYŁĄCZNIE z wiersza share — nigdy z nagłówka. */
router.param('token', (req: Request, res: Response, next: NextFunction, token: string) => {
  const share = getShareByToken(token); // regex + expiry + lazy delete w repo
  if (!share) return res.status(404).json(NOT_FOUND);
  const portfolio = getPortfolio(share.portfolioId);
  if (!portfolio) {
    // Portfel skasowany, a share osierocony (backstop — DELETE portfela też kasuje share)
    deleteShareForPortfolio(share.portfolioId);
    return res.status(404).json(NOT_FOUND);
  }
  (res.locals as unknown as ShareLocals).share = share;
  (res.locals as unknown as ShareLocals).portfolioName = portfolio.name;
  next();
});

// GET /api/public/share/:token/meta
router.get('/share/:token/meta', (req: Request, res: Response) => {
  const { share, portfolioName } = res.locals as unknown as ShareLocals;
  res.json({
    portfolioName,
    scope: share.scope,
    showAmounts: share.showAmounts,
    benchmark: share.benchmark,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
  });
});

// GET /api/public/share/:token/history — benchmark z wiersza share (widz nie wybiera);
// filtrowanie zakresu czasu zostaje po stronie klienta, jak na dashboardzie
router.get(
  '/share/:token/history',
  asyncHandler(async (req, res) => {
    const { share } = res.locals as unknown as ShareLocals;
    const view = await buildHistoryView(share.portfolioId, share.benchmark as BenchmarkKey);
    res.json(toPublicHistory(view, share.showAmounts));
  }),
);

// GET /api/public/share/:token/positions — 404 (nie 403) gdy zakres bez pozycji
router.get(
  '/share/:token/positions',
  asyncHandler(async (req, res) => {
    const { share } = res.locals as unknown as ShareLocals;
    if (share.scope !== 'chart_positions') return res.status(404).json(NOT_FOUND);
    const view = await buildPositionsViewMemoized(share.portfolioId);
    res.json(toPublicPositions(view, share.showAmounts));
  }),
);

export default router;
