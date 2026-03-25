import { Request, Response, NextFunction } from 'express';
import { getPortfolio, isPortfolioOwnedBy } from '../db/portfolio-registry.js';

// Portfolio ID must be 'default' or a valid UUID v4
const VALID_PORTFOLIO_ID = /^(default|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

declare global {
  namespace Express {
    interface Request {
      portfolioId: string;
    }
  }
}

export function portfolioMiddleware(req: Request, res: Response, next: NextFunction) {
  const portfolioId = (req.headers['x-portfolio-id'] as string) || 'default';

  // Validate portfolio ID format (prevent path traversal)
  if (!VALID_PORTFOLIO_ID.test(portfolioId)) {
    return res.status(400).json({ error: 'Invalid portfolio ID format' });
  }

  // Skip existence/ownership check for portfolio management routes
  if (req.path.startsWith('/api/portfolios')) {
    req.portfolioId = portfolioId;
    return next();
  }

  // Auth required — if userId is not set, reject
  if (!req.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const portfolio = getPortfolio(portfolioId);
  if (!portfolio) {
    return res.status(404).json({ error: 'Portfolio not found' });
  }

  // Ownership check — always enforced
  if (!isPortfolioOwnedBy(portfolioId, req.userId)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  req.portfolioId = portfolioId;
  next();
}
