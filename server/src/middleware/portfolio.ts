import { Request, Response, NextFunction } from 'express';
import { getPortfolio, isPortfolioOwnedBy } from '../db/portfolio-registry.js';

declare global {
  namespace Express {
    interface Request {
      portfolioId: string;
    }
  }
}

export function portfolioMiddleware(req: Request, res: Response, next: NextFunction) {
  const portfolioId = (req.headers['x-portfolio-id'] as string) || 'default';

  // Skip validation for portfolio management routes
  if (req.path.startsWith('/api/portfolios')) {
    req.portfolioId = portfolioId;
    return next();
  }

  const portfolio = getPortfolio(portfolioId);
  if (!portfolio) {
    return res.status(404).json({ error: 'Portfolio not found' });
  }

  // Ownership check (multi-tenancy) — skip if no auth (userId not set)
  if (req.userId && !isPortfolioOwnedBy(portfolioId, req.userId)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  req.portfolioId = portfolioId;
  next();
}
