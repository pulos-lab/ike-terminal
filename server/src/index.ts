import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { toNodeHandler } from 'better-auth/node';
import { config, isProduction } from './config.js';
import { auth, closeAuthDb } from './auth.js';
import { requireAuth } from './middleware/auth.js';
import { initRegistry, getAllPortfolios } from './db/portfolio-registry.js';
import { getDb, closeDb } from './db/connection.js';
import { seedTickerMap } from './db/ticker-map-repo.js';
import { portfolioMiddleware } from './middleware/portfolio.js';
import portfoliosRouter from './routes/portfolios.js';
import pricesRouter from './routes/prices.js';
import portfolioRouter from './routes/portfolio.js';
import importRouter from './routes/import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind reverse proxy (Caddy) — needed for secure cookies
app.set('trust proxy', isProduction ? 1 : false);

// ── Security ────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: isProduction
    ? {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'script-src': ["'self'", 'stats.tixterminal.app'],
          'connect-src': ["'self'", 'stats.tixterminal.app'],
        },
      }
    : false,
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
}));

app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Stricter limit on sign-up: max 3 registrations per IP per hour
app.use('/api/auth/sign-up', rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created. Try again later.' },
}));

// ── CORS ────────────────────────────────────────────────────────────────────
const corsOrigins = isProduction
  ? [config.corsOrigin]
  : ['http://localhost:5173', 'http://localhost:5174'];
app.use(cors({ origin: corsOrigins, credentials: true }));

// ── Production: serve SPA static files (BEFORE auth — public assets) ────────
if (isProduction) {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
}

// ── Better Auth handler (MUST be before express.json) ───────────────────────
app.all('/api/auth/*', toNodeHandler(auth));

app.use(express.json());

// ── Health check (public, no auth) ──────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    googleAuthEnabled: !!(config.googleClientId && config.googleClientSecret),
  });
});

// ── Database initialization ─────────────────────────────────────────────────
initRegistry();

for (const portfolio of getAllPortfolios()) {
  getDb(portfolio.id);
  seedTickerMap(portfolio.id);
}
console.log('All databases initialized, ticker maps seeded.');

// ── Protected API Routes (auth + portfolio middleware applied only to /api) ──
app.use('/api/portfolios', requireAuth, portfolioMiddleware, portfoliosRouter);
app.use('/api/prices', requireAuth, portfolioMiddleware, pricesRouter);
app.use('/api/portfolio', requireAuth, portfolioMiddleware, portfolioRouter);
app.use('/api/import', requireAuth, portfolioMiddleware, importRouter);

// ── SPA fallback (after API routes — serves index.html for client routing) ──
if (isProduction) {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(clientDist, 'index.html'));
    }
  });
}

// ── Global error handler ────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: isProduction ? 'Internal server error' : err.message });
});

// ── Start server ────────────────────────────────────────────────────────────
const server = app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port} [${config.nodeEnv}]`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────────
function shutdown(signal: string) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  server.close(() => {
    closeDb();
    closeAuthDb();
    console.log('All database connections closed. Bye.');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('Forced shutdown after timeout.');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
