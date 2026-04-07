/**
 * Automatic dividend scanner.
 *
 * Periodically checks open positions for dividend events via Yahoo Finance
 * and inserts them as cash_operations with source='auto-yahoo'.
 *
 * Tax rates depend on portfolio account type (IKE/IKZE vs regular).
 */
import { getAllPortfolios, getPortfolio } from '../db/portfolio-registry.js';
import { getAllTransactions } from '../db/transactions-repo.js';
import { getTickerMap } from '../db/ticker-map-repo.js';
import { dividendExistsForDateAndTicker, insertOperationsWithDedup, getLatestDividendDate, deleteAutoYahooDividends } from '../db/operations-repo.js';
import { getSharesAtDate } from './portfolio-engine.js';
import { fetchYahooDividendEvents } from './yahoo-finance.js';
import { DIVIDEND_TAX_REGULAR, DIVIDEND_TAX_IKE_IKZE } from 'shared';
import type { CashOperation, PortfolioSettings, TickerMapEntry } from 'shared';

export interface ScanResult {
  scanned: number;
  newDividends: number;
  errors: string[];
}

const DEFAULT_LOOKBACK_DAYS = 90;

function getCountryFromExchange(exchange: string, ticker: string): string {
  if (exchange === 'GPW' || exchange === 'NC') return 'PL';
  if (exchange === 'XETRA') return 'DE';
  if (exchange === 'TSX') return 'CA';
  if (exchange === 'NYSE' || exchange === 'NASDAQ') return 'US';

  // Fallback: infer from ticker suffix
  if (ticker.endsWith('.WA')) return 'PL';
  if (ticker.endsWith('.DE')) return 'DE';
  if (ticker.endsWith('.L') || ticker.endsWith('.IL')) return 'GB';
  if (ticker.endsWith('.TO')) return 'CA';
  if (ticker.endsWith('.HK')) return 'HK';
  if (ticker.endsWith('.SI')) return 'SG';
  if (ticker.endsWith('.T')) return 'JP';
  if (ticker.endsWith('.AX')) return 'AU';
  if (ticker.endsWith('.BR')) return 'BE';
  if (ticker.endsWith('.PA')) return 'FR';
  if (ticker.endsWith('.SW')) return 'CH';
  if (ticker.endsWith('.OL')) return 'NO';
  if (ticker.endsWith('.AS')) return 'NL';

  return 'US'; // default for unrecognized
}

function getDividendTaxRate(country: string, settings: PortfolioSettings): number {
  const table = (settings.isIKE || settings.isIKZE)
    ? DIVIDEND_TAX_IKE_IKZE
    : DIVIDEND_TAX_REGULAR;
  return table[country] ?? DIVIDEND_TAX_REGULAR['PL'];
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Scan a single portfolio for new dividend events.
 */
export async function scanDividends(portfolioId: string): Promise<ScanResult> {
  const portfolio = getPortfolio(portfolioId);
  if (!portfolio) {
    return { scanned: 0, newDividends: 0, errors: [`Portfolio ${portfolioId} not found`] };
  }

  const settings = portfolio.settings;
  const transactions = getAllTransactions(portfolioId);
  const tickerMap = getTickerMap(portfolioId);

  if (transactions.length === 0) {
    return { scanned: 0, newDividends: 0, errors: [] };
  }

  // Clean up previous auto-yahoo dividends (may contain duplicates from broken dedup)
  const deleted = deleteAutoYahooDividends(portfolioId);
  if (deleted > 0) {
    console.log(`[dividend-scanner] ${portfolioId}: cleaned up ${deleted} old auto-yahoo dividends`);
  }

  // Determine scan start date: from last broker-imported dividend, or 90 days back
  const latestDiv = getLatestDividendDate(portfolioId);
  let startDate: string;
  if (latestDiv) {
    startDate = latestDiv;
  } else {
    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - DEFAULT_LOOKBACK_DAYS);
    const lookbackStr = lookbackDate.toISOString().split('T')[0];
    const earliestTx = transactions.reduce(
      (min, t) => t.date < min ? t.date : min,
      transactions[0].date
    );
    startDate = earliestTx > lookbackStr ? lookbackStr : earliestTx;
  }

  // Collect unique ISINs with their ticker map entries (exclude NC — Stooq only, no dividend data)
  const isinEntries = new Map<string, TickerMapEntry>();
  for (const [isin, entry] of tickerMap) {
    if (entry.exchange === 'NC') continue;
    if (entry.priceSource === 'stooq') continue;
    isinEntries.set(isin, entry);
  }

  const newOperations: CashOperation[] = [];
  const errors: string[] = [];
  let scanned = 0;

  for (const [isin, entry] of isinEntries) {
    try {
      const events = await fetchYahooDividendEvents(entry.ticker, startDate);
      scanned++;

      for (const event of events) {
        // Skip if dividend already exists (from any source)
        if (dividendExistsForDateAndTicker(portfolioId, event.date, entry.ticker)) {
          continue;
        }

        const shares = getSharesAtDate(transactions, isin, event.date);
        if (shares <= 0) continue;

        const country = getCountryFromExchange(entry.exchange, entry.ticker);
        const taxRate = getDividendTaxRate(country, settings);
        const grossAmount = roundTo2(event.amount * shares);
        const taxAmount = roundTo2(grossAmount * taxRate);
        const netAmount = roundTo2(grossAmount - taxAmount);

        const taxPct = Math.round(taxRate * 100);
        const accountType = (settings.isIKE || settings.isIKZE) ? 'IKE/IKZE' : 'zwykłe';
        const description = `Dywidenda ${entry.ticker} (${shares} szt. × ${event.amount} ${entry.currency}, podatek ${taxPct}% [${accountType}])`;

        newOperations.push({
          date: event.date,
          operationType: 'dividend',
          description,
          amount: netAmount,
          currency: entry.currency,
          ticker: entry.ticker,
          source: 'auto-yahoo',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${entry.ticker}: ${msg}`);
    }
  }

  let inserted = 0;
  if (newOperations.length > 0) {
    const result = insertOperationsWithDedup(newOperations, portfolioId);
    inserted = result.inserted;
    console.log(`[dividend-scanner] ${portfolioId}: scanned ${scanned} tickers, inserted ${inserted} new dividends`);
  } else if (scanned > 0) {
    console.log(`[dividend-scanner] ${portfolioId}: scanned ${scanned} tickers, no new dividends`);
  }

  return { scanned, newDividends: inserted, errors };
}

/**
 * Scan all portfolios for new dividends.
 * Called by the scheduled job.
 */
export async function scanAllPortfolios(): Promise<void> {
  const portfolios = getAllPortfolios();
  for (const p of portfolios) {
    try {
      await scanDividends(p.id);
    } catch (err) {
      console.error(`[dividend-scanner] Error scanning ${p.id}:`, err);
    }
  }
}
