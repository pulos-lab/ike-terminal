import { Router } from 'express';
import {
  getAllPortfolios,
  createPortfolio,
  updatePortfolio,
  deletePortfolio,
  isPortfolioOwnedBy,
} from '../db/portfolio-registry.js';
import { getDb, closeDb } from '../db/connection.js';
import { seedTickerMap } from '../db/ticker-map-repo.js';
import { purgeAllData } from '../db/transactions-repo.js';
import { deleteShareForPortfolio } from '../db/share-repo.js';
import { scanInterest } from '../services/interest-scanner.js';
import { isFiniteNumber } from './validation.js';
import { DEMO_PORTFOLIO_ID } from 'shared';

const router = Router();

// Portfel demo jest współdzielony i read-only — mutacje blokujemy jawnie,
// zanim ownership check w ogóle zdąży odpowiedzieć (defense in depth).
router.use('/:id', (req, res, next) => {
  if (req.params.id === DEMO_PORTFOLIO_ID && req.method !== 'GET') {
    return res.status(403).json({ error: 'demo_read_only' });
  }
  next();
});

/**
 * Waliduje `settings.freeCashInterest` (oprocentowanie wolnych środków). Zwraca
 * komunikat błędu (string) gdy pole jest obecne i niepoprawne, albo null gdy OK.
 * Silnik i zapis do bazy ufają temu polu, więc odsiewamy tu śmieci.
 */
function validateFreeCashInterest(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object') return null;
  const fci = (settings as Record<string, unknown>).freeCashInterest;
  if (fci === undefined || fci === null) return null;
  if (!Array.isArray(fci)) return 'freeCashInterest musi być tablicą';
  const seen = new Set<string>();
  for (const entry of fci) {
    if (!entry || typeof entry !== 'object') return 'Nieprawidłowy wpis oprocentowania';
    const { currency, annualRatePct, cap } = entry as Record<string, unknown>;
    if (typeof currency !== 'string' || !currency.trim()) return 'Wymagana waluta';
    const cur = currency.trim().toUpperCase();
    if (seen.has(cur)) return `Zduplikowana waluta: ${cur}`;
    seen.add(cur);
    if (!isFiniteNumber(annualRatePct) || annualRatePct < 0) return 'Stawka musi być liczbą ≥ 0';
    if (cap !== undefined && cap !== null && (!isFiniteNumber(cap) || cap < 0)) {
      return 'Limit (cap) musi być liczbą ≥ 0';
    }
  }
  return null;
}

// GET /api/portfolios — returns portfolios owned by the authenticated user
// Auto-creates a default portfolio if user has none
router.get('/', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });

  let portfolios = getAllPortfolios(req.userId);

  if (portfolios.length === 0) {
    const portfolio = createPortfolio('Mój portfel', req.userId);
    getDb(portfolio.id);
    seedTickerMap(portfolio.id);
    portfolios = [portfolio];
  }

  res.json(portfolios);
});

// POST /api/portfolios
router.post('/', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

  const portfolio = createPortfolio(name.trim(), req.userId);
  getDb(portfolio.id);
  seedTickerMap(portfolio.id);
  res.json(portfolio);
});

// PUT /api/portfolios/:id
router.put('/:id', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const { id } = req.params;
  if (!isPortfolioOwnedBy(id, req.userId)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { name, settings } = req.body;
  const fciError = validateFreeCashInterest(settings);
  if (fciError) return res.status(400).json({ error: fciError });

  const updated = updatePortfolio(id, { name, settings });
  if (!updated) return res.status(404).json({ error: 'Portfolio not found' });

  // Przelicz auto-odsetki od razu po zmianie stawki/capu (force pomija dzienny
  // throttle). Insert/delete wewnątrz bumpuje dataVersion → memo historii się
  // unieważnia, więc dashboard i saldo pokazują nową wartość natychmiast.
  if (settings !== undefined) {
    try {
      scanInterest(id, true);
    } catch (err) {
      console.error(`[portfolios] scanInterest po zapisie ustawień ${id}:`, err);
    }
  }

  res.json(updated);
});

// DELETE /api/portfolios/:id
router.delete('/:id', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const { id } = req.params;
  if (id === 'default') return res.status(400).json({ error: 'Cannot delete default portfolio' });
  if (!isPortfolioOwnedBy(id, req.userId)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  closeDb(id);
  deletePortfolio(id);
  deleteShareForPortfolio(id); // publiczny link nie może przeżyć portfela
  res.json({ success: true });
});

// DELETE /api/portfolios/:id/data — purge all data but keep the portfolio
router.delete('/:id/data', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const { id } = req.params;
  if (!isPortfolioOwnedBy(id, req.userId)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  purgeAllData(id);
  res.json({ success: true });
});

export default router;
