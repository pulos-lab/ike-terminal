import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Server } from 'http';
import type { InstrumentHistoryResponse, Transaction } from 'shared';

// DATA_DIR przed importem modułów dotykających config
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-instr-history-'));
process.env.DATA_DIR = tmpDir;

// Fetchery cen zamockowane w całości — test pilnuje ROUTINGU źródeł i zakresu
// dat, nie sieci. Mocki per-test przez mockResolvedValueOnce.
const fetchYahooHistory = vi.fn();
const fetchStooqHistory = vi.fn();
const fetchBiznesradarHistory = vi.fn();

vi.mock('../../services/yahoo-finance.js', () => ({
  fetchYahooPrice: vi.fn(),
  fetchFxRate: vi.fn(),
  fetchYahooHistory: (...args: unknown[]) => fetchYahooHistory(...args),
}));
vi.mock('../../services/stooq.js', () => ({
  fetchStooqPrice: vi.fn(),
  fetchStooqHistory: (...args: unknown[]) => fetchStooqHistory(...args),
}));
vi.mock('../../services/biznesradar.js', () => ({
  fetchBiznesradarPrice: vi.fn(),
  fetchBiznesradarHistory: (...args: unknown[]) => fetchBiznesradarHistory(...args),
}));
vi.mock('../../services/stockwatch-bonds.js', () => ({
  fetchStockwatchBondPrice: vi.fn(),
}));

let server: Server;
let baseUrl: string;

const GPW_ISIN = 'PLTEST0000018';
const NC_ISIN = 'PLTESTNC00013';

function point(date: string, close = 100): { date: string; close: number } {
  return { date, close };
}

function makeTx(isin: string, date: string): Transaction {
  return {
    date,
    paperName: 'Test',
    isin,
    quantity: 10,
    side: 'K',
    price: 100,
    value: 1000,
    commission: 0,
    total: 1000,
    currency: 'PLN',
    source: 'manual',
  };
}

async function getHistory(isin: string): Promise<Response> {
  return fetch(`${baseUrl}/api/prices/instrument-history?isin=${encodeURIComponent(isin)}`);
}

beforeAll(async () => {
  const { upsertTickerMapEntry } = await import('../../db/ticker-map-repo.js');
  const { insertTransaction } = await import('../../db/transactions-repo.js');

  upsertTickerMapEntry(
    {
      isin: GPW_ISIN,
      ticker: 'TST.WA',
      name: 'Test GPW',
      exchange: 'GPW',
      currency: 'PLN',
      priceSource: 'yahoo',
    },
    'default',
  );
  upsertTickerMapEntry(
    {
      isin: NC_ISIN,
      ticker: 'TNC',
      name: 'Test NewConnect',
      exchange: 'NC',
      currency: 'PLN',
      priceSource: 'stooq',
    },
    'default',
  );
  // Dwie transakcje — zakres ma iść od NAJWCZEŚNIEJSZEJ minus 30 dni
  insertTransaction(makeTx(GPW_ISIN, '2026-03-15'), 'default');
  insertTransaction(makeTx(GPW_ISIN, '2026-05-02'), 'default');
  insertTransaction(makeTx(NC_ISIN, '2026-04-10'), 'default');

  const { default: pricesRouter } = await import('../prices.js');
  const app = express();
  // Stub middleware portfela — handler potrzebuje tylko req.portfolioId
  app.use((req, _res, next) => {
    req.portfolioId = 'default';
    next();
  });
  app.use('/api/prices', pricesRouter);
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

describe('GET /prices/instrument-history', () => {
  beforeEach(() => {
    // Reset wywołań i kolejek mockResolvedValueOnce — każdy test ustawia własne
    fetchYahooHistory.mockReset();
    fetchStooqHistory.mockReset();
    fetchBiznesradarHistory.mockReset();
  });

  it('brak isin → 400, nieznany isin → 404', async () => {
    const noIsin = await fetch(`${baseUrl}/api/prices/instrument-history`);
    expect(noIsin.status).toBe(400);
    const unknown = await getHistory('PLNIEZNANY000');
    expect(unknown.status).toBe(404);
  });

  it('GPW → Yahoo; zakres od pierwszej transakcji minus 30 dni', async () => {
    const points = Array.from({ length: 15 }, (_, i) =>
      point(`2026-04-${String(i + 1).padStart(2, '0')}`),
    );
    fetchYahooHistory.mockResolvedValueOnce(points);

    const res = await getHistory(GPW_ISIN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstrumentHistoryResponse;
    expect(body.source).toBe('yahoo');
    expect(body.ticker).toBe('TST.WA');
    expect(body.currency).toBe('PLN');
    expect(body.points).toHaveLength(15);
    // 2026-03-15 (pierwsza transakcja) − 30 dni = 2026-02-13
    expect(fetchYahooHistory).toHaveBeenCalledWith('TST.WA', '2026-02-13');
    expect(fetchStooqHistory).not.toHaveBeenCalled();
  });

  it('GPW: Yahoo szczątkowe (<10 punktów) → dłuższy wynik ze Stooq wygrywa', async () => {
    fetchYahooHistory.mockResolvedValueOnce([point('2026-04-01')]);
    const stooqPoints = Array.from({ length: 12 }, (_, i) =>
      point(`2026-04-${String(i + 1).padStart(2, '0')}`, 50),
    );
    fetchStooqHistory.mockResolvedValueOnce(stooqPoints);

    const res = await getHistory(GPW_ISIN);
    const body = (await res.json()) as InstrumentHistoryResponse;
    expect(body.source).toBe('stooq');
    expect(body.points).toHaveLength(12);
  });

  it('NC → biznesradar (Yahoo nie listuje NC)', async () => {
    fetchBiznesradarHistory.mockResolvedValueOnce([point('2026-04-01'), point('2026-04-02')]);

    const res = await getHistory(NC_ISIN);
    const body = (await res.json()) as InstrumentHistoryResponse;
    expect(body.source).toBe('biznesradar');
    // 2026-04-10 − 30 dni = 2026-03-11
    expect(fetchBiznesradarHistory).toHaveBeenCalledWith('TNC', '2026-03-11');
    expect(fetchYahooHistory).not.toHaveBeenCalled();
  });

  it('full=1 → pełna historia (start 1990-01-01, bez patrzenia na transakcje)', async () => {
    const points = Array.from({ length: 20 }, (_, i) =>
      point(`2020-01-${String(i + 1).padStart(2, '0')}`),
    );
    fetchYahooHistory.mockResolvedValueOnce(points);

    const res = await fetch(
      `${baseUrl}/api/prices/instrument-history?isin=${encodeURIComponent(GPW_ISIN)}&full=1`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstrumentHistoryResponse;
    expect(body.points).toHaveLength(20);
    expect(fetchYahooHistory).toHaveBeenCalledWith('TST.WA', '1990-01-01');
  });

  it('NC: biznesradar pusty → zapas Stooq', async () => {
    fetchBiznesradarHistory.mockResolvedValueOnce([]);
    fetchStooqHistory.mockResolvedValueOnce([point('2026-04-01'), point('2026-04-02')]);

    const res = await getHistory(NC_ISIN);
    const body = (await res.json()) as InstrumentHistoryResponse;
    expect(body.source).toBe('stooq');
    expect(body.points).toHaveLength(2);
  });
});
