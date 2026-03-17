import { Router } from 'express';
import { getAllPortfolios, createPortfolio, updatePortfolio, deletePortfolio } from '../db/portfolio-registry.js';
import { getDb, closeDb } from '../db/connection.js';
import { seedTickerMap } from '../db/ticker-map-repo.js';

const router = Router();

// GET /api/portfolios
router.get('/', (_req, res) => {
  res.json(getAllPortfolios());
});

// POST /api/portfolios
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });

  const portfolio = createPortfolio(name.trim());
  // Initialize DB + seed ticker map for the new portfolio
  getDb(portfolio.id);
  seedTickerMap(portfolio.id);
  res.json(portfolio);
});

// PUT /api/portfolios/:id
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name, settings } = req.body;
  const updated = updatePortfolio(id, { name, settings });
  if (!updated) return res.status(404).json({ error: 'Portfolio not found' });
  res.json(updated);
});

// DELETE /api/portfolios/:id
router.delete('/:id', (req, res) => {
  const { id } = req.params;
  if (id === 'default') return res.status(400).json({ error: 'Cannot delete default portfolio' });

  closeDb(id);
  deletePortfolio(id);
  res.json({ success: true });
});

export default router;
