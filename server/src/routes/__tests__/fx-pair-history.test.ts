import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Server } from 'http';
import type { FxPairHistoryResponse } from 'shared';

// DATA_DIR przed importem modułów dotykających config
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-fx-pair-history-'));
process.env.DATA_DIR = tmpDir;

// Fetcher zamockowany — test pilnuje whitelisty par, zakresu dat i matematyki
// cross-pary, nie sieci.
const fetchYahooHistory = vi.fn();

vi.mock('../../services/yahoo-finance.js', () => ({
  fetchYahooPrice: vi.fn(),
  fetchFxRate: vi.fn(),
  fetchYahooHistory: (...args: unknown[]) => fetchYahooHistory(...args),
}));
vi.mock('../../services/stooq.js', () => ({
  fetchStooqPrice: vi.fn(),
  fetchStooqHistory: vi.fn(),
}));
vi.mock('../../services/biznesradar.js', () => ({
  fetchBiznesradarPrice: vi.fn(),
  fetchBiznesradarHistory: vi.fn(),
}));
vi.mock('../../services/stockwatch-bonds.js', () => ({
  fetchStockwatchBondPrice: vi.fn(),
}));

let server: Server;
let baseUrl: string;

function point(date: string, close: number): { date: string; close: number } {
  return { date, close };
}

async function getPairHistory(query: string): Promise<Response> {
  return fetch(`${baseUrl}/api/prices/fx-pair-history${query}`);
}

beforeAll(async () => {
  const { insertOperations } = await import('../../db/operations-repo.js');

  // Para nóg wymiany PLN→USD w konwencji bossy (fx_pair = kierunek "PLN/USD")
  // + para EUR→USD w konwencji IBKR (fx_pair = para "EUR/USD"). Zakres endpointu
  // ma iść od NAJWCZEŚNIEJSZEJ wymiany danej pary minus 30 dni, niezależnie od
  // zapisu fx_pair — dopasowanie po zbiorze walut.
  insertOperations(
    [
      {
        date: '2026-03-15',
        operationType: 'fx_exchange',
        description: 'Wymiana waluty PLN/USD 4.0',
        amount: -4000,
        currency: 'PLN',
        fxRate: 4.0,
        fxPair: 'PLN/USD',
        source: 'bossa',
      },
      {
        date: '2026-03-15',
        operationType: 'fx_exchange',
        description: 'Wymiana waluty PLN/USD 4.0',
        amount: 1000,
        currency: 'USD',
        fxRate: 4.0,
        fxPair: 'PLN/USD',
        source: 'bossa',
      },
      {
        date: '2026-04-20',
        operationType: 'fx_exchange',
        description: 'Wymiana EUR/USD @ 1.10',
        amount: -100,
        currency: 'EUR',
        fxRate: 1.1,
        fxPair: 'EUR/USD',
        source: 'ibkr',
      },
      {
        date: '2026-04-20',
        operationType: 'fx_exchange',
        description: 'Wymiana EUR/USD @ 1.10',
        amount: 110,
        currency: 'USD',
        fxRate: 1.1,
        fxPair: 'EUR/USD',
        source: 'ibkr',
      },
    ],
    'default',
  );

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

describe('GET /prices/fx-pair-history', () => {
  beforeEach(() => {
    fetchYahooHistory.mockReset();
  });

  it('brak pair / para spoza whitelisty → 400', async () => {
    expect((await getPairHistory('')).status).toBe(400);
    expect((await getPairHistory('?pair=GBPPLN')).status).toBe(400);
    expect((await getPairHistory('?pair=usdpln')).status).toBe(400);
  });

  it('USDPLN: zakres od pierwszej wymiany {PLN,USD} minus 30 dni (fx_pair bossy = "PLN/USD")', async () => {
    fetchYahooHistory.mockResolvedValueOnce([point('2026-03-01', 4.0), point('2026-03-02', 4.01)]);

    const res = await getPairHistory('?pair=USDPLN');
    expect(res.status).toBe(200);
    const body = (await res.json()) as FxPairHistoryResponse;
    expect(body.pair).toBe('USDPLN');
    expect(body.currency).toBe('PLN');
    expect(body.points).toHaveLength(2);
    // 2026-03-15 (wymiana bossy) − 30 dni = 2026-02-13
    expect(fetchYahooHistory).toHaveBeenCalledWith('USDPLN=X', '2026-02-13');
  });

  it('EURPLN bez żadnej wymiany pary → zakres 1 rok wstecz', async () => {
    fetchYahooHistory.mockResolvedValueOnce([point('2026-01-02', 4.3)]);

    const res = await getPairHistory('?pair=EURPLN');
    expect(res.status).toBe(200);
    const [ticker, start] = fetchYahooHistory.mock.calls[0] as [string, string];
    expect(ticker).toBe('EURPLN=X');
    // ~365 dni wstecz od dziś (tolerancja na moment odpalenia testu)
    const expected = new Date();
    expected.setUTCDate(expected.getUTCDate() - 365);
    expect(Math.abs(new Date(start).getTime() - expected.getTime())).toBeLessThan(
      3 * 24 * 3600 * 1000,
    );
  });

  it('USDEUR: iloraz USDPLN/EURPLN per data, tylko przecięcie dat', async () => {
    fetchYahooHistory.mockImplementation((ticker: string) => {
      if (ticker === 'USDPLN=X') {
        return Promise.resolve([
          point('2026-04-01', 4.0),
          point('2026-04-02', 4.2),
          point('2026-04-03', 4.1), // brak EURPLN tego dnia → punkt wypada
        ]);
      }
      if (ticker === 'EURPLN=X') {
        return Promise.resolve([point('2026-04-01', 5.0), point('2026-04-02', 4.2)]);
      }
      return Promise.resolve([]);
    });

    const res = await getPairHistory('?pair=USDEUR');
    expect(res.status).toBe(200);
    const body = (await res.json()) as FxPairHistoryResponse;
    expect(body.currency).toBe('EUR');
    expect(body.points).toEqual([point('2026-04-01', 0.8), point('2026-04-02', 1)]);
    // Zakres od wymiany EUR→USD IBKR: 2026-04-20 − 30 dni = 2026-03-21
    expect(fetchYahooHistory).toHaveBeenCalledWith('USDPLN=X', '2026-03-21');
    expect(fetchYahooHistory).toHaveBeenCalledWith('EURPLN=X', '2026-03-21');
  });

  it('full=1 → start 1990-01-01, bez patrzenia na wymiany', async () => {
    fetchYahooHistory.mockResolvedValueOnce([point('2001-01-02', 4.15)]);

    const res = await getPairHistory('?pair=USDPLN&full=1');
    expect(res.status).toBe(200);
    expect(fetchYahooHistory).toHaveBeenCalledWith('USDPLN=X', '1990-01-01');
  });
});
