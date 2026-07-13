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
import { seedTickerMap, migrateGpwToYahoo } from './db/ticker-map-repo.js';
import { portfolioMiddleware } from './middleware/portfolio.js';
import portfoliosRouter from './routes/portfolios.js';
import pricesRouter from './routes/prices.js';
import portfolioRouter from './routes/portfolio.js';
import importRouter from './routes/import.js';
import bugReportsRouter from './routes/bug-reports.js';
import adminImportProfilesRouter from './routes/admin-import-profiles.js';
import adminTypeAliasesRouter from './routes/admin-type-aliases.js';
import { requireAdmin } from './middleware/require-admin.js';
import { purgeAllRawFiles } from './db/import-profiles-repo.js';
import shareRouter from './routes/share.js';
import publicShareRouter from './routes/public-share.js';
import { updateBenchmarkPrices } from './services/benchmark-updater.js';
import { backfillTickerNamesForPortfolio } from './services/ticker-name-backfill.js';
import { scanAllPortfolios } from './services/dividend-scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind reverse proxy (Caddy) — needed for secure cookies
app.set('trust proxy', isProduction ? 1 : false);

// ── HTTP request logging ────────────────────────────────────────────────────
// W produkcji logujemy tylko mutacje + błędy (GET-y są hałaśliwe: price polling,
// benchmark refresh). W dev logujemy wszystko.
app.use((req: Request, res: Response, next: NextFunction) => {
  const isMutation = req.method !== 'GET' && req.method !== 'HEAD';
  if (!isMutation && isProduction) return next();
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const isError = res.statusCode >= 400;
    if (!isMutation && !isError && isProduction) return; // skip healthy GETs in prod
    const tag = isError ? 'ERROR' : 'OK';
    const user = req.userId ? req.userId.slice(0, 8) : '-';
    console.log(
      `[${tag}] ${req.method} ${req.originalUrl} → ${res.statusCode} ${ms}ms user=${user}`,
    );
  });
  next();
});

// ── Security ────────────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            'script-src': ["'self'", 'stats.tixterminal.app'],
            'connect-src': ["'self'", 'stats.tixterminal.app'],
          },
        }
      : false,
  }),
);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use(
  '/api/auth',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Stricter limit on sign-up: max 3 registrations per IP per hour
app.use(
  '/api/auth/sign-up',
  rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many accounts created. Try again later.' },
  }),
);

// Brute-force protection on login: max 10 attempts per 15 min
app.use(
  '/api/auth/sign-in',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again later.' },
  }),
);

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

// ── Benchmark diagnostics (public, temporary) ─────────────────────────────
app.get('/api/benchmark-diag', async (_req, res) => {
  const { loadHistoricalPrices, getLastCachedDate } = await import('./services/history-cache.js');
  const tickers = ['wig', 'wig20', 'mwig40', 'swig80'];
  const result: Record<string, any> = { dataDir: config.dataDir };
  for (const t of tickers) {
    const last = getLastCachedDate(t);
    const data = loadHistoricalPrices(t);
    result[t] = { count: data.length, first: data[0]?.date, last: last };
  }
  res.json(result);
});

// ── Database initialization ─────────────────────────────────────────────────
initRegistry();

for (const portfolio of getAllPortfolios()) {
  getDb(portfolio.id);
  seedTickerMap(portfolio.id);
  const migrated = migrateGpwToYahoo(portfolio.id);
  if (migrated > 0) console.log(`  Migrated ${migrated} GPW tickers to Yahoo in ${portfolio.id}`);
}
console.log('All databases initialized, ticker maps seeded.');

// ── Protected API Routes (auth + portfolio middleware applied only to /api) ──
app.use('/api/portfolios', requireAuth, portfolioMiddleware, portfoliosRouter);
app.use('/api/prices', requireAuth, portfolioMiddleware, pricesRouter);
app.use('/api/portfolio', requireAuth, portfolioMiddleware, portfolioRouter);
app.use('/api/import', requireAuth, portfolioMiddleware, importRouter);
app.use('/api/bug-reports', requireAuth, bugReportsRouter);
app.use('/api/admin/import-profiles', requireAuth, requireAdmin, adminImportProfilesRouter);
app.use('/api/admin/type-aliases', requireAuth, requireAdmin, adminTypeAliasesRouter);
app.use('/api/share', requireAuth, portfolioMiddleware, shareRouter);

// ── Public share endpoints (NO auth — dostęp przez kryptograficzny token) ────
// Ciaśniejszy rate limit niż globalny: anonimowy ruch, tylko 3 GET-y.
app.use(
  '/api/public',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  publicShareRouter,
);

// ── SPA fallback (after API routes — serves index.html for client routing) ──
if (isProduction) {
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      if (req.path.startsWith('/share/')) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      }
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

// ── Jednorazowe wyczyszczenie legacy surowych plików importu (prywatność) ────
// Plików użytkownika nie przechowujemy; ta funkcja czyści to, co zapisały starsze
// wersje. Idempotentne (kolejny start: 0 wierszy).
setTimeout(() => {
  try {
    const cleared = purgeAllRawFiles();
    if (cleared > 0) {
      console.log(`Import: wyczyszczono ${cleared} legacy surowych plików (prywatność)`);
    }
  } catch (err) {
    console.error('Czyszczenie surowych plików importu nie powiodło się:', (err as Error).message);
  }
}, 5_000);

// ── Ticker name backfill (one-shot per startup, idempotent) ────────────────
// Naprawia ticker_map.name dla wpisów gdzie `name = ticker` — pozostałość po
// starszej wersji POST /transactions auto-create, która używała symbolu jako
// placeholderu. WHERE filtruje już-naprawione wpisy, więc kolejne uruchomienia
// nie powtarzają roboty. Fire-and-forget by nie blokować startupu.
setTimeout(() => {
  (async () => {
    let totalUpdated = 0;
    for (const portfolio of getAllPortfolios()) {
      try {
        const { candidates, updated, skipped } = await backfillTickerNamesForPortfolio(
          portfolio.id,
        );
        totalUpdated += updated;
        if (candidates > 0) {
          console.log(
            `[ticker-name-backfill] ${portfolio.id}: ${candidates} candidate(s) → ${updated} updated, ${skipped} skipped`,
          );
        }
      } catch (err: any) {
        console.error(`[ticker-name-backfill] ${portfolio.id}: ${err.message}`);
      }
    }
    if (totalUpdated > 0) {
      console.log(`[ticker-name-backfill] done — ${totalUpdated} name(s) refreshed from Yahoo`);
    }
  })();
}, 15_000);

// ── Benchmark price updater (fetch latest from Stooq every 6h) ─────────────
setTimeout(() => {
  updateBenchmarkPrices().catch((err) => console.error('Initial benchmark update failed:', err));
}, 10_000);

setInterval(
  () => {
    updateBenchmarkPrices().catch((err) => console.error('Benchmark update failed:', err));
  },
  6 * 60 * 60 * 1000,
);

// ── Dividend scanner (auto-detect dividends every 12h) ─────────────────────
setTimeout(() => {
  scanAllPortfolios().catch((err) => console.error('Initial dividend scan failed:', err));
}, 30_000);

setInterval(
  () => {
    scanAllPortfolios().catch((err) => console.error('Dividend scan failed:', err));
  },
  12 * 60 * 60 * 1000,
);

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
