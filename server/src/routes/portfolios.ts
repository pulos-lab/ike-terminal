import { Router } from 'express';
import { getAllPortfolios, createPortfolio, updatePortfolio, deletePortfolio, isPortfolioOwnedBy } from '../db/portfolio-registry.js';
import { getDb, closeDb } from '../db/connection.js';
import { seedTickerMap } from '../db/ticker-map-repo.js';

const router = Router();

// GET /api/portfolios — returns only portfolios owned by the authenticated user
router.get('/', (req, res) => {
  res.json(getAllPortfolios(req.userId));
});

// POST /api/portfolios
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

  const portfolio = createPortfolio(name.trim(), req.userId);
  getDb(portfolio.id);
  seedTickerMap(portfolio.id);
  res.json(portfolio);
});

// PUT /api/portfolios/:id
router.put('/:id', (req, res) => {
  const { id } = req.params;
  if (req.userId && !isPortfolioOwnedBy(id, req.userId)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { name, settings } = req.body;
  const updated = updatePortfolio(id, { name, settings });
  if (!updated) return res.status(404).json({ error: 'Portfolio not found' });
  res.json(updated);
});

// DELETE /api/portfolios/:id
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  if (id === 'default') return res.status(400).json({ error: 'Cannot delete default portfolio' });
  if (req.userId && !isPortfolioOwnedBy(id, req.userId)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  closeDb(id);
  deletePortfolio(id);
  res.json({ success: true });
});

export default router;
