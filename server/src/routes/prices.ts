import { Router } from 'express';
import { DEFAULT_FX_PLN } from 'shared';
import type { LivePrice, LivePricesResponse } from 'shared';
import { fetchYahooPrice, fetchFxRate } from '../services/yahoo-finance.js';
import { fetchStooqPrice } from '../services/stooq.js';
import { getAllTickers } from '../db/ticker-map-repo.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { mapWithConcurrency } from '../services/concurrency.js';

const router = Router();

// GET /api/prices/live - fetch live prices for all portfolio tickers
router.get(
  '/live',
  asyncHandler(async (req, res) => {
    const tickers = getAllTickers(req.portfolioId);
    const prices: Record<string, LivePrice> = {};

    await mapWithConcurrency(tickers, 5, async (entry) => {
      if (entry.exchange === 'NC') {
        const price = await fetchStooqPrice(entry.ticker);
        prices[entry.ticker] = { price, currency: entry.currency };
      } else {
        const result = await fetchYahooPrice(entry.ticker);
        prices[entry.ticker] = result || { price: null, currency: entry.currency };
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

export default router;
