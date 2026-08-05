import { Router } from 'express';
import { DEFAULT_FX_PLN } from 'shared';
import type { InstrumentHistoryResponse, LivePrice, LivePricesResponse } from 'shared';
import { fetchYahooPrice, fetchFxRate, fetchYahooHistory } from '../services/yahoo-finance.js';
import { primeYahooQuotes } from '../services/yahoo-quotes.js';
import { fetchStooqPrice, fetchStooqHistory } from '../services/stooq.js';
import { fetchBiznesradarPrice, fetchBiznesradarHistory } from '../services/biznesradar.js';
import { fetchStockwatchBondPrice } from '../services/stockwatch-bonds.js';
import { getAllTickers, getTickerByIsin } from '../db/ticker-map-repo.js';
import { getTransactionsByIsin } from '../db/transactions-repo.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { mapWithConcurrency } from '../services/concurrency.js';

const router = Router();

// GET /api/prices/live - fetch live prices for all portfolio tickers
router.get(
  '/live',
  asyncHandler(async (req, res) => {
    const tickers = getAllTickers(req.portfolioId);
    const prices: Record<string, LivePrice> = {};

    // Jedno żądanie zbiorcze zamiast N pojedynczych: wypełnia ten sam cache,
    // z którego czytają fetchYahooPrice i fetchFxRate niżej. NC/CATALYST poza
    // batchem — Yahoo ich nie kwotuje.
    await primeYahooQuotes([
      ...tickers
        .filter((e) => e.exchange !== 'NC' && e.exchange !== 'CATALYST')
        .map((e) => e.ticker),
      'USDPLN=X',
      'CADPLN=X',
      'EURPLN=X',
      'GBPPLN=X',
    ]);

    await mapWithConcurrency(tickers, 5, async (entry) => {
      if (entry.exchange === 'NC') {
        // biznesradar główne źródło NC (Stooq CSV endpoint padł ~03.2026); Stooq zapas.
        const price =
          (await fetchBiznesradarPrice(entry.ticker)) ?? (await fetchStooqPrice(entry.ticker));
        prices[entry.ticker] = { price, currency: entry.currency };
      } else if (entry.exchange === 'CATALYST') {
        // Obligacje: stockwatch (kurs w % nominału), Stooq zapas — wcześniej
        // szły do Yahoo, który ich nie zna, i zawsze wracał null.
        const sw = await fetchStockwatchBondPrice(entry.ticker);
        const price = sw?.price ?? (await fetchStooqPrice(entry.ticker));
        prices[entry.ticker] = { price, currency: entry.currency };
      } else {
        const result = await fetchYahooPrice(entry.ticker);
        let price = result?.price ?? null;
        // GPW: zapas biznesradar przy chybieniu Yahoo — jak w silniku pozycji.
        if (price === null && (entry.exchange === 'GPW' || entry.ticker.endsWith('.WA'))) {
          price = await fetchBiznesradarPrice(entry.ticker);
        }
        prices[entry.ticker] = { price, currency: result?.currency ?? entry.currency };
      }
    });

    // FX rates — GBPPLN doszedł, bo dialogi FX/transakcji pre-fillują kurs GBP
    // z tego endpointu (wcześniej fx.GBPPLN nigdy nie istniało i pre-fill milcząco
    // nie działał).
    const [usdPln, cadPln, eurPln, gbpPln] = await Promise.all([
      fetchFxRate('USDPLN').then((r) => r || DEFAULT_FX_PLN.USD),
      fetchFxRate('CADPLN').then((r) => r || DEFAULT_FX_PLN.CAD),
      fetchFxRate('EURPLN').then((r) => r || DEFAULT_FX_PLN.EUR),
      fetchFxRate('GBPPLN').then((r) => r || DEFAULT_FX_PLN.GBP),
    ]);

    const payload: LivePricesResponse = {
      prices,
      fx: { USDPLN: usdPln, CADPLN: cadPln, EURPLN: eurPln, GBPPLN: gbpPln },
      timestamp: new Date().toISOString(),
    };
    res.json(payload);
  }),
);

// GET /api/prices/instrument-history?isin=...[&full=1] — historia kursu jednego
// instrumentu (wykres pozycji z markerami K/S). Zakres: od pierwszej transakcji
// minus 30 dni bufora (kontekst kursu sprzed wejścia w pozycję); z full=1 pełna
// dostępna historia notowań (preset ALL/3Y sięgający przed pierwszą transakcję).
router.get(
  '/instrument-history',
  asyncHandler(async (req, res) => {
    const isin = typeof req.query.isin === 'string' ? req.query.isin : '';
    if (!isin) {
      res.status(400).json({ error: 'Parametr isin jest wymagany' });
      return;
    }
    const entry = getTickerByIsin(isin, req.portfolioId);
    if (!entry) {
      res.status(404).json({ error: 'Nieznany instrument' });
      return;
    }

    let startDate: string;
    if (req.query.full === '1') {
      // Pełna historia — Yahoo utnie na faktycznym początku notowań; dla NC/Catalyst
      // ogranicznikiem jest cap stron biznesradar (dociąga przyrostowo).
      startDate = '1990-01-01';
    } else {
      const txs = getTransactionsByIsin(isin, req.portfolioId);
      const firstTxDate = txs.length ? txs[0].date.split('T')[0] : null;
      const start = new Date(firstTxDate ? `${firstTxDate}T00:00:00Z` : Date.now());
      start.setUTCDate(start.getUTCDate() - (firstTxDate ? 30 : 365));
      startDate = start.toISOString().split('T')[0];
    }

    // Routing źródeł jak przy historii dashboardu: NC/Catalyst → biznesradar → Stooq,
    // reszta → Yahoo → Stooq (gdy Yahoo zwróci szczątkowe dane).
    let points: Array<{ date: string; close: number }>;
    let source: string;
    if (entry.exchange === 'NC' || entry.exchange === 'CATALYST') {
      points = await fetchBiznesradarHistory(entry.ticker, startDate);
      source = 'biznesradar';
      if (points.length < 2) {
        points = await fetchStooqHistory(entry.ticker, startDate);
        source = 'stooq';
      }
    } else {
      points = await fetchYahooHistory(entry.ticker, startDate);
      source = 'yahoo';
      if (points.length < 10) {
        const fallback = await fetchStooqHistory(entry.ticker, startDate);
        if (fallback.length > points.length) {
          points = fallback;
          source = 'stooq';
        }
      }
    }

    const payload: InstrumentHistoryResponse = {
      isin,
      ticker: entry.ticker,
      name: entry.name,
      currency: entry.currency,
      source,
      points,
    };
    res.json(payload);
  }),
);

export default router;
