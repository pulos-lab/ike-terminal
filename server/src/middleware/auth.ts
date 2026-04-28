import type { Request, Response, NextFunction } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../auth.js';

// ── Extend Express Request with user info ───────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

/**
 * Authentication middleware — validates session and sets req.userId.
 * Returns 401 for unauthenticated requests.
 * Public routes (health, auth) should be mounted BEFORE this middleware.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session?.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    req.userId = session.user.id;
    req.userEmail = session.user.email;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Authentication required' });
  }
}
