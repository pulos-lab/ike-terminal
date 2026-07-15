import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Server } from 'http';

// DATA_DIR przed importem modułów dotykających config
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-tx-validation-'));
process.env.DATA_DIR = tmpDir;

let server: Server;
let baseUrl: string;

/**
 * Guardy wejścia POST/PUT /transactions: format daty (YYYY-MM-DD) oraz
 * skończoność liczb. JSON.parse('1e999') daje Infinity — przed guardami
 * przechodziło walidację `!quantity` / `price == null` i lądowało w bazie.
 * Payloady z 1e999 budowane stringiem (JSON.stringify(Infinity) → null).
 */

async function postTransaction(rawBody: string): Promise<Response> {
  return fetch(`${baseUrl}/api/portfolio/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
}

beforeAll(async () => {
  const { upsertTickerMapEntry } = await import('../../db/ticker-map-repo.js');
  // Pre-seed tickera: getTickerBySymbol trafia w mapę i handler nie strzela do Yahoo.
  upsertTickerMapEntry(
    {
      isin: 'US0000000001',
      ticker: 'TVAL',
      name: 'Test Validation Corp',
      exchange: 'OTHER',
      currency: 'USD',
      priceSource: 'yahoo',
    },
    'default',
  );

  const { default: portfolioRouter } = await import('../portfolio.js');
  const app = express();
  app.use(express.json());
  // Stub middleware portfela — pełny portfolioMiddleware wymaga auth + rejestru,
  // a walidacja potrzebuje tylko req.portfolioId.
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

describe('POST /transactions — walidacja wejścia', () => {
  it('data w złym formacie (15.07.2026) → 400', async () => {
    const res = await postTransaction(
      JSON.stringify({ date: '15.07.2026', ticker: 'TVAL', side: 'K', quantity: 1, price: 10 }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/YYYY-MM-DD/);
  });

  it('quantity 1e999 (Infinity po JSON.parse) → 400', async () => {
    const res = await postTransaction(
      '{"date":"2026-07-15","ticker":"TVAL","side":"K","quantity":1e999,"price":10}',
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/quantity/);
  });

  it('ujemne quantity → 400', async () => {
    const res = await postTransaction(
      JSON.stringify({ date: '2026-07-15', ticker: 'TVAL', side: 'K', quantity: -5, price: 10 }),
    );
    expect(res.status).toBe(400);
  });

  it('price 1e999 → 400', async () => {
    const res = await postTransaction(
      '{"date":"2026-07-15","ticker":"TVAL","side":"K","quantity":1,"price":1e999}',
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/price/);
  });

  it('opcja ze strike 1e999 → 400', async () => {
    const res = await postTransaction(
      '{"date":"2026-07-15","side":"K","quantity":1,"price":2.5,"category":"option",' +
        '"option":{"underlying":"TVAL","expiry":"2026-12-18","strike":1e999,"optionType":"C"}}',
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/strike/);
  });

  it('poprawny payload → 200 z id (ticker z mapy, bez sieci)', async () => {
    const res = await postTransaction(
      JSON.stringify({ date: '2026-07-15', ticker: 'TVAL', side: 'K', quantity: 10, price: 25.5 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number };
    expect(body.id).toBeGreaterThan(0);
  });
});

describe('PUT /transactions/:id — walidacja pól podanych', () => {
  it('zła data → 400; Infinity w fxRate → 400; poprawna częściowa edycja → 200', async () => {
    // Transakcja-baza do edycji
    const createRes = await postTransaction(
      JSON.stringify({ date: '2026-07-15', ticker: 'TVAL', side: 'K', quantity: 2, price: 100 }),
    );
    expect(createRes.status).toBe(200);
    const { id } = (await createRes.json()) as { id: number };

    const badDate = await fetch(`${baseUrl}/api/portfolio/transactions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '15.07.2026' }),
    });
    expect(badDate.status).toBe(400);

    const badFx = await fetch(`${baseUrl}/api/portfolio/transactions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"fxRate":1e999}',
    });
    expect(badFx.status).toBe(400);

    const ok = await fetch(`${baseUrl}/api/portfolio/transactions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 3 }),
    });
    expect(ok.status).toBe(200);
  });
});
