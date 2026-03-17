import { Request, Response, NextFunction } from 'express';
import { getPortfolio } from '../db/portfolio-registry.js';

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

  req.portfolioId = portfolioId;
  next();
}
