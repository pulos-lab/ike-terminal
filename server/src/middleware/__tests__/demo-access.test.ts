import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Server } from 'http';

// DATA_DIR przed importem modułów dotykających config
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-demo-access-'));
process.env.DATA_DIR = tmpDir;

// requireAuth bez better-auth: sesję symuluje nagłówek x-test-user.
// Mock dotyczy modułu '../auth.js' importowanego przez demo-access.ts —
// łańcuch requireAuthOrDemo → requireAuth testujemy więc realnie.
vi.mock('../auth.js', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = req.headers['x-test-user'];
    if (typeof user === 'string' && user) {
      req.userId = user;
      return next();
    }
    return res.status(401).json({ error: 'Authentication required' });
  },
}));

let server: Server;
let baseUrl: string;
let userPortfolioId: string;

beforeAll(async () => {
  const { demoAccess, requireAuthOrDemo } = await import('../demo-access.js');
  const { portfolioMiddleware } = await import('../portfolio.js');
  const registry = await import('../../db/portfolio-registry.js');

  registry.initRegistry();
  registry.ensureDemoPortfolio();
  // Realny portfel realnego użytkownika — do testów regresji ownership
  userPortfolioId = registry.createPortfolio('Portfel usera', 'user-1').id;

  const app = express();
  const echo = express.Router();
  echo.get('/', (req, res) => res.json({ userId: req.userId, portfolioId: req.portfolioId }));
  echo.post('/', (req, res) => res.json({ userId: req.userId, portfolioId: req.portfolioId }));
  echo.delete('/', (req, res) => res.json({ userId: req.userId, portfolioId: req.portfolioId }));
  echo.post('/history', (req, res) =>
    res.json({ userId: req.userId, portfolioId: req.portfolioId }),
  );
  // Lustro montażu z index.ts (bez demoLimiter — rate limit nie jest przedmiotem testu)
  app.use('/api/portfolio', demoAccess, requireAuthOrDemo, portfolioMiddleware, echo);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Brak portu testowego');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function get(portfolioId: string | null, user?: string) {
  const headers: Record<string, string> = {};
  if (portfolioId) headers['X-Portfolio-Id'] = portfolioId;
  if (user) headers['x-test-user'] = user;
  return fetch(`${baseUrl}/api/portfolio`, { headers });
}

function mutate(method: 'POST' | 'DELETE', portfolioId: string, user?: string) {
  const headers: Record<string, string> = { 'X-Portfolio-Id': portfolioId };
  if (user) headers['x-test-user'] = user;
  return fetch(`${baseUrl}/api/portfolio`, { method, headers });
}

describe('demo-access: anonimowy read-only dostęp do portfela demo', () => {
  it('GET z nagłówkiem demo bez sesji przechodzi z syntetycznym userem', async () => {
    const res = await get('demo');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ userId: '__demo__', portfolioId: 'demo' });
  });

  it('mutacje na portfelu demo są blokowane (403 demo_read_only) — także bez sesji', async () => {
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await mutate(method, 'demo');
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'demo_read_only' });
    }
  });

  it('read-only POST /history jest na whiteliście (dashboard woła go przy wejściu)', async () => {
    const res = await fetch(`${baseUrl}/api/portfolio/history`, {
      method: 'POST',
      headers: { 'X-Portfolio-Id': 'demo' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: '__demo__', portfolioId: 'demo' });
  });

  it('zalogowany użytkownik na portfelu demo też jest read-only', async () => {
    const ok = await get('demo', 'user-1');
    expect(ok.status).toBe(200);
    expect((await ok.json()).userId).toBe('__demo__');

    const blocked = await mutate('POST', 'demo', 'user-1');
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: 'demo_read_only' });
  });
});

describe('demo-access: brak osłabienia auth poza portfelem demo', () => {
  it('GET bez sesji na inne portfele → 401 (default, cudzy UUID, brak nagłówka)', async () => {
    for (const pid of ['default', userPortfolioId, null]) {
      const res = await get(pid);
      expect(res.status).toBe(401);
    }
  });

  it('id "podszywające się" pod demo nie przechodzi walidacji formatu', async () => {
    // 'demo2' mija demoAccess (nie jest literalnym 'demo'), mija zamockowany
    // requireAuth (sesja) i wykłada się na regexie portfolioMiddleware.
    const res = await get('demo2', 'user-1');
    expect(res.status).toBe(400);
    const traversal = await get('../etc/passwd', 'user-1');
    expect(traversal.status).toBe(400);
  });

  it('zalogowany użytkownik nadal ma dostęp tylko do swoich portfeli', async () => {
    const own = await get(userPortfolioId, 'user-1');
    expect(own.status).toBe(200);
    expect((await own.json()).userId).toBe('user-1');

    const foreign = await get(userPortfolioId, 'user-2');
    expect(foreign.status).toBe(403);
  });
});

describe('ensureDemoPortfolio (rejestr)', () => {
  it('jest idempotentne i przypina syntetycznego właściciela', async () => {
    const registry = await import('../../db/portfolio-registry.js');
    const first = registry.ensureDemoPortfolio();
    const second = registry.ensureDemoPortfolio();
    expect(first.id).toBe('demo');
    expect(second.userId).toBe('__demo__');
    const demos = registry.getAllPortfolios().filter((p) => p.id === 'demo');
    expect(demos).toHaveLength(1);
  });

  it('portfel demo nie pojawia się na listach realnych użytkowników', async () => {
    const registry = await import('../../db/portfolio-registry.js');
    expect(registry.getAllPortfolios('user-1').some((p) => p.id === 'demo')).toBe(false);
    expect(registry.getAllPortfolios('__demo__').some((p) => p.id === 'demo')).toBe(true);
  });
});
