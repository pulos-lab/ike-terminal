import { Router } from 'express';
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
    const prices: Record<string, { price: number | null; currency: string }> = {};

    await mapWithConcurrency(tickers, 5, async (entry) => {
      if (entry.exchange === 'NC') {
        const price = await fetchStooqPrice(entry.ticker);
        prices[entry.ticker] = { price, currency: entry.currency };
      } else {
        const result = await fetchYahooPrice(entry.ticker);
        prices[entry.ticker] = result || { price: null, currency: entry.currency };
      }
    });

    // FX rates
    const [usdPln, cadPln, eurPln] = await Promise.all([
      fetchFxRate('USDPLN').then((r) => r || 4.0),
      fetchFxRate('CADPLN').then((r) => r || 2.95),
      fetchFxRate('EURPLN').then((r) => r || 4.3),
    ]);

    res.json({
      prices,
      fx: { USDPLN: usdPln, CADPLN: cadPln, EURPLN: eurPln },
      timestamp: new Date().toISOString(),
    });
  }),
);

export default router;
