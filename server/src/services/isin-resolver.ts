import type { Transaction, TickerMapEntry } from 'shared';
import { getTickerMap, upsertTickerMapEntry } from '../db/ticker-map-repo.js';
import { searchYahoo, validateStooq, searchStooqByName } from './ticker-search.js';
import { fetchYahooPrice } from './yahoo-finance.js';

interface UnresolvedIsin {
  isin: string;
  paperName: string;
  currency: string;
}

export interface ResolveResult {
  resolved: TickerMapEntry[];
  unresolved: UnresolvedIsin[];
}

// Concurrency limiter — avoid hammering Yahoo/Stooq APIs
const MAX_CONCURRENT = 3;

async function withConcurrencyLimit<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Infer exchange type from ticker symbol and Yahoo exchange string.
 */
function inferExchange(
  ticker: string,
  yahooExchange?: string,
): TickerMapEntry['exchange'] {
  if (ticker.endsWith('.WA')) return 'GPW';
  if (ticker.endsWith('.DE')) return 'XETRA';
  if (ticker.endsWith('.TO')) return 'TSX';

  if (yahooExchange) {
    const ex = yahooExchange.toUpperCase();
    if (ex.includes('NASDAQ') || ex === 'NMS' || ex === 'NGM' || ex === 'NCM') return 'NASDAQ';
    if (ex.includes('NYSE') || ex === 'NYQ') return 'NYSE';
    if (ex.includes('XETRA') || ex === 'GER') return 'XETRA';
    if (ex.includes('TSX') || ex === 'TOR') return 'TSX';
    if (ex.includes('WARSAW') || ex.includes('WSE')) return 'GPW';
  }

  return 'OTHER';
}

/**
 * Infer price source from ticker symbol.
 */
function inferPriceSource(ticker: string): 'yahoo' | 'stooq' {
  return ticker.endsWith('.WA') ? 'stooq' : 'yahoo';
}

/**
 * Try to resolve a single ISIN to a TickerMapEntry.
 *
 * Resolution order:
 * 1. Yahoo search by ISIN (most reliable — exact identifier)
 * 2. Yahoo search by paper name (fallback for small stocks)
 * 3. Stooq validation for Polish (PL*) ISINs
 */
/**
 * Check if a string looks like a real ISIN (2 uppercase letters + 10 alphanumeric chars).
 * mBank pseudo-ISINs (e.g., "ETFSP500", "PKOBP") won't match this pattern.
 */
function isRealIsin(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test(value);
}

/**
 * Split concatenated mBank ETF names into searchable queries.
 * e.g., "BETAETFWIG20TR" → "BETA ETF WIG20TR"
 *        "ETFSP500"       → "ETFSP500" (no change needed, short enough for Yahoo)
 */
function splitEtfName(name: string): string {
  const upper = name.toUpperCase();
  // Pattern: prefix + "ETF" + rest, e.g. "BETA" + "ETF" + "WIG20TR"
  const match = upper.match(/^(BETA|XTRACKERS?|ISHARES?|LYXOR|AMUNDI)?(ETF)(.+)$/i);
  if (match) {
    const parts = [match[1], match[2], match[3]].filter(Boolean);
    return parts.join(' ');
  }
  return name;
}

async function resolveIsin(
  isin: string,
  paperName: string,
  txCurrency: string,
): Promise<TickerMapEntry | null> {
  const isPseudoIsin = !isRealIsin(isin); // mBank ticker names used as ISIN placeholders

  // --- Strategy 1: Yahoo search by ISIN ---
  const byIsin = await searchYahoo(isin);
  if (byIsin.length > 0) {
    const hit = isPseudoIsin
      ? byIsin.find(r => r.symbol.endsWith('.WA')) || byIsin[0]
      : byIsin[0];
    return await buildEntry(isin, hit.symbol, hit.name, hit.exchange, paperName, txCurrency);
  }

  // --- Strategy 2: Yahoo search by paper name ---
  // Clean up Bossa paper names: remove suffixes like "-NC", "-NC-FIX", "-C"
  const cleanName = paperName
    .replace(/-NC(?:-FIX)?$/i, '')
    .replace(/-C$/i, '')
    .trim();

  if (cleanName.length >= 2) {
    // For mBank pseudo-ISINs, also try splitting concatenated ETF names
    // e.g., "BETAETFWIG20TR" → "BETA ETF WIG20TR"
    const searchVariants = [cleanName];
    if (isPseudoIsin) {
      const split = splitEtfName(cleanName);
      if (split !== cleanName) searchVariants.push(split);
    }

    for (const variant of searchVariants) {
      const byName = await searchYahoo(variant);
      if (byName.length > 0) {
        // For Polish ISINs or mBank pseudo-ISINs (PLN currency), prefer .WA results
        const preferWA = isin.startsWith('PL') || isPseudoIsin;
        const preferred = preferWA
          ? byName.find(r => r.symbol.endsWith('.WA')) || byName[0]
          : byName[0];

        return await buildEntry(isin, preferred.symbol, preferred.name, preferred.exchange, paperName, txCurrency);
      }
    }
  }

  // --- Strategy 2.5: Stooq company name search ---
  // mBank paper names often don't match Stooq ticker symbols (e.g. POLHOLROZ → prh)
  // Stooq /cmp/?q= resolves by company name
  if (isPseudoIsin && cleanName.length >= 3) {
    const stooqSearch = await searchStooqByName(cleanName);
    if (stooqSearch) {
      return {
        isin,
        ticker: stooqSearch.symbol,
        name: stooqSearch.name,
        exchange: (stooqSearch.exchange === 'NC' ? 'NC' : 'GPW') as TickerMapEntry['exchange'],
        currency: 'PLN',
        priceSource: 'stooq',
      };
    }
  }

  // --- Strategy 3: Stooq validation for Polish stocks ---
  // Run for real Polish ISINs (PL*) or mBank pseudo-ISINs (ticker names)
  const tryStooq = isin.startsWith('PL') || isPseudoIsin;
  if (tryStooq && cleanName.length >= 2) {
    // Try full name first, then shorter candidates (common GPW ticker patterns)
    const candidates = [cleanName];
    // Only try shortened versions for non-ETF tickers
    if (!cleanName.toUpperCase().startsWith('ETF') && !cleanName.toUpperCase().startsWith('BETA')) {
      candidates.push(cleanName.substring(0, 4));
      candidates.push(cleanName.substring(0, 3));
    }

    for (const candidate of candidates) {
      const stooqResult = await validateStooq(candidate, isPseudoIsin ? undefined : cleanName);
      if (stooqResult) {
        return {
          isin,
          ticker: stooqResult.symbol,
          name: stooqResult.name !== candidate.toUpperCase() ? stooqResult.name : paperName,
          exchange: 'GPW',
          currency: 'PLN',
          priceSource: 'stooq',
        };
      }
    }
  }

  return null;
}

/**
 * Build a TickerMapEntry from a resolved Yahoo result.
 * Fetches the actual price to get the currency (Yahoo search doesn't return it).
 */
async function buildEntry(
  isin: string,
  ticker: string,
  name: string,
  yahooExchange: string | undefined,
  paperName: string,
  txCurrency: string,
): Promise<TickerMapEntry> {
  const exchange = inferExchange(ticker, yahooExchange);
  const priceSource = inferPriceSource(ticker);

  // For .WA tickers, we know it's PLN/stooq — skip Yahoo price lookup
  if (ticker.endsWith('.WA')) {
    return {
      isin,
      ticker,
      name: name || paperName,
      exchange,
      currency: 'PLN',
      priceSource: 'stooq',
    };
  }

  // For other tickers, try to get currency from Yahoo price API
  let currency = txCurrency;
  try {
    const priceData = await fetchYahooPrice(ticker);
    if (priceData?.currency) {
      currency = priceData.currency;
    }
  } catch {
    // Fall back to transaction currency
  }

  return {
    isin,
    ticker,
    name: name || paperName,
    exchange,
    currency,
    priceSource,
  };
}

/**
 * Resolve unknown ISINs from imported transactions.
 *
 * Compares ISINs in the transactions against the existing ticker_map,
 * then attempts to auto-resolve any that are missing via Yahoo Finance
 * and Stooq lookups. Resolved entries are persisted to the database.
 */
export async function resolveUnknownIsins(
  transactions: Transaction[],
  portfolioId: string,
): Promise<ResolveResult> {
  const existingMap = getTickerMap(portfolioId);

  // Collect unique ISINs with their paper names and currencies
  const unknowns = new Map<string, { paperName: string; currency: string }>();
  for (const tx of transactions) {
    if (!existingMap.has(tx.isin) && !unknowns.has(tx.isin)) {
      unknowns.set(tx.isin, { paperName: tx.paperName, currency: tx.currency });
    }
  }

  if (unknowns.size === 0) {
    return { resolved: [], unresolved: [] };
  }

  console.log(`ISIN resolver: ${unknowns.size} unknown ISINs to resolve`);

  const resolved: TickerMapEntry[] = [];
  const unresolved: UnresolvedIsin[] = [];

  const items = Array.from(unknowns.entries());

  await withConcurrencyLimit(items, async ([isin, { paperName, currency }]) => {
    try {
      const entry = await resolveIsin(isin, paperName, currency);
      if (entry) {
        upsertTickerMapEntry(entry, portfolioId);
        resolved.push(entry);
        console.log(`  ✓ ${isin} → ${entry.ticker} (${entry.name})`);
      } else {
        unresolved.push({ isin, paperName, currency });
        console.log(`  ✗ ${isin} (${paperName}) — could not resolve`);
      }
    } catch (error) {
      console.error(`  ✗ ${isin} (${paperName}) — error:`, error);
      unresolved.push({ isin, paperName, currency });
    }
  });

  console.log(`ISIN resolver: ${resolved.length} resolved, ${unresolved.length} unresolved`);
  return { resolved, unresolved };
}
