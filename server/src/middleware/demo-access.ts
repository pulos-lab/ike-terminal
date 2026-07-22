import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { DEMO_PORTFOLIO_ID, DEMO_USER_ID } from 'shared';
import { requireAuth } from './auth.js';

/**
 * Anonimowy, read-only dostęp do współdzielonego portfela demo.
 *
 * Bypass auth jest keyed WYŁĄCZNIE po literalnym nagłówku `X-Portfolio-Id: demo`
 * i dopuszcza tylko metody read — każda mutacja na portfelu demo (także od
 * zalogowanego użytkownika) dostaje 403 `demo_read_only`, które klient mapuje
 * na CTA "Załóż konto". Requesty bez nagłówka demo przechodzą dalej nietknięte
 * (do requireAuth w requireAuthOrDemo).
 *
 * Ownership w portfolioMiddleware przechodzi naturalnie: wpis rejestru portfela
 * demo ma userId = DEMO_USER_ID i dokładnie ten userId ustawiamy tutaj.
 */

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Read-only endpointy, które z przyczyn historycznych używają POST (body z
 * parametrami zapytania). Dashboard woła POST /history, a Portfel POST
 * /risk-return automatycznie przy wejściu — bez tych wyjątków demo nie
 * wyrenderuje wykresów.
 */
const READ_POST_WHITELIST = new Set(['/api/portfolio/history', '/api/portfolio/risk-return']);

function isReadRequest(req: Request): boolean {
  if (READ_METHODS.has(req.method)) return true;
  return req.method === 'POST' && READ_POST_WHITELIST.has(req.baseUrl + req.path);
}

function isDemoRequest(req: Request): boolean {
  return req.headers['x-portfolio-id'] === DEMO_PORTFOLIO_ID;
}

/** Ciaśniejszy limit dla anonimowego ruchu demo (wzorzec /api/public: 120/15min). */
export const demoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !isDemoRequest(req),
});

export function demoAccess(req: Request, res: Response, next: NextFunction) {
  if (!isDemoRequest(req)) return next();
  if (!isReadRequest(req)) {
    return res.status(403).json({ error: 'demo_read_only' });
  }
  req.userId = DEMO_USER_ID;
  next();
}

/** Zamiennik requireAuth w montażach demo-aware: demoAccess ustawił już syntetycznego usera. */
export function requireAuthOrDemo(req: Request, res: Response, next: NextFunction) {
  if (req.userId === DEMO_USER_ID) return next();
  return requireAuth(req, res, next);
}
