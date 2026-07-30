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
import { demoAccess, demoLimiter, requireAuthOrDemo } from './middleware/demo-access.js';
import { initRegistry, getAllPortfolios } from './db/portfolio-registry.js';
import { closeDb } from './db/connection.js';
import { initAllPortfolioDbs } from './db/startup-init.js';
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
import { getEarningsCalendarService } from './services/earnings/earnings-calendar.js';
import { getBondCatalog } from './services/bond-catalog.js';
import { backfillTickerNamesForPortfolio } from './services/ticker-name-backfill.js';
import { scanAllPortfolios } from './services/dividend-scanner.js';
import { scanAllInterest } from './services/interest-scanner.js';
import { getBiznesradarGuard } from './services/biznesradar-guard.js';

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

// Limit 1 MB: największy legalny JSON to bulk-delete (~10k id ≈ 90 KB);
// pliki importu idą multipartem (multer, osobne limity 5 MB).
app.use(express.json({ limit: '1mb' }));

// ── Rate limit mutacji (POST/PUT/PATCH/DELETE na /api) ─────────────────────
// GET-y zostają na globalnym 500/15min; auth ma własne, ciaśniejsze limitery
// (mountowane wyżej). Multi-plikowy import = jeden multipart POST, więc
// 300/15min nie ogranicza legalnych scenariuszy.
app.use(
  '/api',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
    message: { error: 'Too many write requests. Try again later.' },
  }),
);

// ── Health check (public, no auth) ──────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  // Stan guardów źródeł scrapowanych — POLE INFORMACYJNE: odcięcie/zmiana
  // markupu źródła NIE zmienia statusu ani kodu HTTP (deploy waliduje
  // `curl -sf` i nie może oblewać przez awarię zewnętrznego serwisu).
  let sources: Record<string, unknown>;
  try {
    sources = { biznesradar: getBiznesradarGuard().getState() };
  } catch (err) {
    console.error('[health] odczyt stanu guarda źródeł nie powiódł się:', err);
    sources = { biznesradar: { error: 'unavailable' } };
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    googleAuthEnabled: !!(config.googleClientId && config.googleClientSecret),
    sources,
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

// Guard per portfel (initAllPortfolioDbs): zepsuta baza jednego portfela nie
// blokuje startu serwera — incydent 2026-07-23 (root-owned demo.db → crash-loop).
const dbInit = initAllPortfolioDbs();
if (dbInit.failed.length > 0) {
  console.error(
    `Databases initialized WITH ERRORS: ${dbInit.ok.length} OK, ` +
      `${dbInit.failed.length} pominięte (${dbInit.failed.map((f) => f.id).join(', ')}).`,
  );
} else {
  console.log('All databases initialized, ticker maps seeded.');
}

// ── Protected API Routes (auth + portfolio middleware applied only to /api) ──
app.use('/api/portfolios', requireAuth, portfolioMiddleware, portfoliosRouter);
// Trzy montaże demo-aware: anonimowe GET-y na portfel demo przechodzą bez sesji
// (demoAccess ustawia syntetycznego usera), wszystko inne idzie przez requireAuth
// jak dotąd. Mutacje na demo blokuje demoAccess (403 demo_read_only).
app.use(
  '/api/prices',
  demoLimiter,
  demoAccess,
  requireAuthOrDemo,
  portfolioMiddleware,
  pricesRouter,
);
app.use(
  '/api/portfolio',
  demoLimiter,
  demoAccess,
  requireAuthOrDemo,
  portfolioMiddleware,
  portfolioRouter,
);
app.use(
  '/api/import',
  demoLimiter,
  demoAccess,
  requireAuthOrDemo,
  portfolioMiddleware,
  importRouter,
);
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
  // Honoruj status błędów middleware (np. 413 body-parsera przy limicie 1 MB)
  // zamiast spłaszczać wszystko do 500; 4xx to błąd klienta, nie serwera.
  const status =
    (err as { status?: number; statusCode?: number }).status ??
    (err as { statusCode?: number }).statusCode ??
    500;
  console.error('Unhandled error:', err.message);
  res
    .status(status)
    .json({ error: isProduction && status >= 500 ? 'Internal server error' : err.message });
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

// ── Interest scanner (oprocentowanie wolnych środków, raz/dobę per portfel) ──
setTimeout(() => {
  try {
    scanAllInterest();
  } catch (err) {
    console.error('Initial interest scan failed:', err);
  }
}, 35_000);

setInterval(
  () => {
    try {
      scanAllInterest();
    } catch (err) {
      console.error('Interest scan failed:', err);
    }
  },
  12 * 60 * 60 * 1000,
);

// ── Kalendarz publikacji wyników ───────────────────────────────────────────
// Odświeżanie MUSI chodzić z timera, a nie leniwie w handlerze jak kalendarz
// dywidend: zamiatanie kalendarza Nasdaq to kilkadziesiąt żądań (~15 s), więc
// czekanie na nie w ścieżce /positions zamieniłoby widok portfela w wąskie gardło.
// Terminarz polskich spółek dociąga się dodatkowo leniwie, gdy w portfelu pojawi
// się spółka, której slug widzimy pierwszy raz.
setTimeout(() => {
  getEarningsCalendarService()
    .refreshAll()
    .catch((err) => console.error('Initial earnings calendar refresh failed:', err));
}, 45_000);

setInterval(
  () => {
    getEarningsCalendarService()
      .refreshAll()
      .catch((err) => console.error('Earnings calendar refresh failed:', err));
  },
  24 * 60 * 60 * 1000,
);

// Bliskie okno częściej — to w nim spółki najczęściej przesuwają termin,
// a właśnie ono zasila alert „za 7 dni".
setInterval(
  () => {
    getEarningsCalendarService()
      .refreshUs({ nearWindowOnly: true })
      .catch((err) => console.error('Earnings near-window refresh failed:', err));
  },
  6 * 60 * 60 * 1000,
);

// ── Katalog obligacji: wczytaj on-demand dograne serie do rejestru runtime (Etap 2 #167) ──
try {
  const loaded = getBondCatalog().loadStoredBondsIntoRegistry();
  if (loaded > 0) console.log(`[bond-catalog] ${loaded} obligacji z bazy w rejestrze runtime`);
} catch (err) {
  console.error('[bond-catalog] load przy starcie nieudany:', err);
}

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
