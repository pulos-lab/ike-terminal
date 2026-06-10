import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Server } from 'http';

// DATA_DIR przed importem modułów dotykających config
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-resolve-'));
process.env.DATA_DIR = tmpDir;

let server: Server;
let baseUrl: string;
let insertOperation: typeof import('../../db/operations-repo.js').insertOperation;
let getAllTransactions: typeof import('../../db/transactions-repo.js').getAllTransactions;

beforeAll(async () => {
  const opsRepo = await import('../../db/operations-repo.js');
  const txRepo = await import('../../db/transactions-repo.js');
  insertOperation = opsRepo.insertOperation;
  getAllTransactions = txRepo.getAllTransactions;

  const { default: portfolioRouter } = await import('../portfolio.js');
  const app = express();
  app.use(express.json());
  // Stub middleware portfela — pełny portfolioMiddleware wymaga auth + rejestru,
  // a handler resolve potrzebuje tylko req.portfolioId.
  app.use((req, _res, next) => {
    req.portfolioId = 'default';
    next();
  });
  app.use('/api/portfolio', portfolioRouter);
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

describe('POST /corporate-actions/:id/resolve', () => {
  it('synthetic SELL dziedziczy paymentCurrency z waluty operacji (nie hardkod PLN)', async () => {
    const opId = insertOperation(
      {
        date: '2025-03-14',
        operationType: 'corporate_action_pending',
        description: 'Wezwanie — XYZ Corp',
        amount: 1500,
        currency: 'USD',
        ticker: 'XYZ',
        source: 'bossa',
      },
      'default',
    );

    const res = await fetch(`${baseUrl}/api/portfolio/corporate-actions/${opId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 10, price: 150, ticker: 'XYZ', isin: 'US0000000001' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; transactionsInserted: number };
    expect(body.success).toBe(true);
    expect(body.transactionsInserted).toBe(1);

    const sell = getAllTransactions('default').find(
      (t) => t.isin === 'US0000000001' && t.side === 'S',
    );
    expect(sell).toBeDefined();
    expect(sell!.currency).toBe('USD');
    // Regresja: hardkod 'PLN' fabrykował fantomowe rozliczenie FX dla operacji w USD
    expect(sell!.paymentCurrency).toBe('USD');
  });
});
