import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Server } from 'http';

// DATA_DIR przed importem modułów dotykających config
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-ticker-repair-'));
process.env.DATA_DIR = tmpDir;

let server: Server;
let baseUrl: string;

/**
 * PUT /api/portfolio/ticker-map/:isin — ręczna naprawa błędnie rozwiązanego
 * wpisu. Dotąd korekta wymagała skryptów fix-* przez SSH albo edycji per
 * transakcja (AUTO_<TICKER>, fragmentacja pozycji). Endpoint przepina całą
 * pozycję i świadomie omija kotwicę anty-flip (force).
 */

async function putEntry(isin: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/portfolio/ticker-map/${encodeURIComponent(isin)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const WRONG_ISIN = 'US6901471018'; // scenariusz z produ: Outlook Therapeutics → OUTDOORZY
const OK_ISIN = 'US0378331005';

beforeAll(async () => {
  const { upsertTickerMapEntry } = await import('../../db/ticker-map-repo.js');
  // Błędnie rozwiązany wpis — REALNY (nie stub), więc chroni go kotwica.
  upsertTickerMapEntry(
    {
      isin: WRONG_ISIN,
      ticker: 'OUT.WA',
      name: 'OUTDOORZY S.A.',
      exchange: 'NC',
      currency: 'PLN',
      priceSource: 'stooq',
      sector: 'Handel detaliczny',
      supersector: 'Handel i usługi',
    },
    'default',
  );
  upsertTickerMapEntry(
    {
      isin: OK_ISIN,
      ticker: 'AAPL',
      name: 'Apple Inc.',
      exchange: 'NASDAQ',
      currency: 'USD',
      priceSource: 'yahoo',
      sector: 'Sprzęt i oprogramowanie',
      supersector: 'Technologie',
    },
    'default',
  );

  const { default: portfolioRouter } = await import('../portfolio.js');
  const app = express();
  app.use(express.json());
  // Stub middleware portfela — handler potrzebuje tylko req.portfolioId.
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PUT /api/portfolio/ticker-map/:isin', () => {
  it('404 dla ISIN-u bez wpisu', async () => {
    const res = await putEntry('XX0000000000', { ticker: 'ABC' });
    expect(res.status).toBe(404);
  });

  it('400 bez tickera', async () => {
    const res = await putEntry(WRONG_ISIN, { currency: 'USD' });
    expect(res.status).toBe(400);
  });

  it('400 dla nieznanej giełdy i złej waluty', async () => {
    expect((await putEntry(WRONG_ISIN, { ticker: 'OTLK', exchange: 'MOON' })).status).toBe(400);
    expect((await putEntry(WRONG_ISIN, { ticker: 'OTLK', currency: 'DOLARY' })).status).toBe(400);
  });

  it('naprawia wpis MIMO kotwicy anty-flip i czyści sektor przy zmianie tickera', async () => {
    const res = await putEntry(WRONG_ISIN, {
      ticker: 'otlk',
      name: 'Outlook Therapeutics, Inc.',
      exchange: 'NASDAQ',
      currency: 'USD',
      priceSource: 'yahoo',
    });
    expect(res.status).toBe(200);
    const { entry } = (await res.json()) as { entry: Record<string, unknown> };
    expect(entry).toMatchObject({
      isin: WRONG_ISIN,
      ticker: 'OTLK',
      name: 'Outlook Therapeutics, Inc.',
      exchange: 'NASDAQ',
      currency: 'USD',
      priceSource: 'yahoo',
    });
    // Stary sektor opisywał CUDZY papier (OUTDOORZY) — po przepięciu ma zniknąć,
    // uzupełni go lazy backfill sektorów.
    expect(entry.sector ?? undefined).toBeUndefined();
    expect(entry.supersector ?? undefined).toBeUndefined();
  });

  it('korekta bez zmiany tickera (np. sama waluta) ZACHOWUJE sektor', async () => {
    const res = await putEntry(OK_ISIN, { ticker: 'AAPL', currency: 'USD' });
    expect(res.status).toBe(200);
    const { entry } = (await res.json()) as { entry: Record<string, unknown> };
    expect(entry.ticker).toBe('AAPL');
    expect(entry.supersector).toBe('Technologie');
  });
});
