import { Router } from 'express';
import { fetchYahooPrice, fetchFxRate } from '../services/yahoo-finance.js';
import { fetchStooqPrice } from '../services/stooq.js';
import { getAllTickers } from '../db/ticker-map-repo.js';

const router = Router();

// GET /api/prices/live - fetch live prices for all portfolio tickers
router.get('/live', async (req, res) => {
  try {
    const tickers = getAllTickers(req.portfolioId);
    const prices: Record<string, { price: number | null; currency: string }> = {};

    // Fetch in parallel with concurrency limit
    const batchSize = 5;
    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      await Promise.all(batch.map(async (entry) => {
        if (entry.priceSource === 'stooq' || entry.ticker.endsWith('.WA')) {
          const price = await fetchStooqPrice(entry.ticker);
          prices[entry.ticker] = { price, currency: entry.currency };
        } else {
          const result = await fetchYahooPrice(entry.ticker);
          prices[entry.ticker] = result || { price: null, currency: entry.currency };
        }
      }));
    }

    // FX rates
    const [usdPln, cadPln, eurPln] = await Promise.all([
      fetchFxRate('USDPLN').then(r => r || 4.0),
      fetchFxRate('CADPLN').then(r => r || 2.95),
      fetchFxRate('EURPLN').then(r => r || 4.3),
    ]);

    res.json({
      prices,
      fx: { USDPLN: usdPln, CADPLN: cadPln, EURPLN: eurPln },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Price fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

export default router;
