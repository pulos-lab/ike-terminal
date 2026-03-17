import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { config } from './config.js';
import { initRegistry, getAllPortfolios } from './db/portfolio-registry.js';
import { getDb } from './db/connection.js';
import { seedTickerMap } from './db/ticker-map-repo.js';
import { portfolioMiddleware } from './middleware/portfolio.js';
import portfoliosRouter from './routes/portfolios.js';
import pricesRouter from './routes/prices.js';
import portfolioRouter from './routes/portfolio.js';
import importRouter from './routes/import.js';

const app = express();

app.use(cors({ origin: ['http://localhost:5173', 'http://localhost:5174'] }));
app.use(express.json());

// Initialize portfolio registry (migrates portfolio.db → default.db on first run)
initRegistry();

// Initialize databases and seed ticker maps for all portfolios
for (const portfolio of getAllPortfolios()) {
  getDb(portfolio.id);
  seedTickerMap(portfolio.id);
}
console.log('All databases initialized, ticker maps seeded.');

// Portfolio middleware — sets req.portfolioId from X-Portfolio-Id header
app.use(portfolioMiddleware);

// Routes
app.use('/api/portfolios', portfoliosRouter);
app.use('/api/prices', pricesRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/import', importRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global error handler — catches multer errors, unhandled throws, etc.
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
});
