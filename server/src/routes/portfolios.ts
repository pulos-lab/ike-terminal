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

const router = Router();

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
  const updated = updatePortfolio(id, { name, settings });
  if (!updated) return res.status(404).json({ error: 'Portfolio not found' });
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
