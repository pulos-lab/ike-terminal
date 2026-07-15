import type { NextFunction, Request, Response } from 'express';
import { getAuthDb } from '../auth.js';

/**
 * Admin = pierwszy zarejestrowany użytkownik (konwencja projektu — wzorzec
 * z bug-reports). Middleware zakłada, że auth middleware ustawił już
 * req.userId; montować ZA nim.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!isAdminUser(req.userId)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/** Czy dany użytkownik jest adminem (pierwsze konto w bazie). */
function isAdminUser(userId: string): boolean {
  const firstUser = getAuthDb()
    .prepare('SELECT id FROM "user" ORDER BY createdAt ASC LIMIT 1')
    .get() as { id: string } | undefined;
  return Boolean(firstUser && firstUser.id === userId);
}
