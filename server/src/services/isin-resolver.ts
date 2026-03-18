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

// Stooq ticker aliases for renamed/rebranded Polish companies (old ticker → current Stooq ticker)
const STOOQ_ALIASES: Record<string, string> = {
  'DINO': 'DNP',      // Dino Polska
  'R22': 'CBF',       // R22 → CyberFolks
  'BRU': 'MBR',       // old ticker → Mo-BRUK
  'CCC': 'MOD',       // CCC → Modivo (2026)
  'RAEN': 'GVT',      // Raen → Grupa Virtus (2026)
  'NEPTS': 'YAN',     // Neptis → Yanosik (2026)
  'VGN': 'TEC',       // Vinci Gen → Tecnovatica (2026)
  'EON': 'EUV',       // EO Networks → Euvic (2026)
  'DTL': 'VAI',       // Detalion Games → Volaria AI (2025)
  'PKN': 'ORL',       // PKN Orlen → Orlen (2023)
  'LVC': 'TXT',       // LiveChat → Text (2023)
  'FMF': 'GNE',       // Famur → Grenevia (2023)
  'GBK': 'CPT',       // GetBack → Capitea (2023)
  'OAT': 'MOC',       // OncoArendi → Molecure (2022)
  '4FM': 'DIG',       // 4FUN Media → Digital Network (2022)
  'WSC': 'GGP',       // Work Service → Gi Group Poland (2021)
  'LCC': 'DVL',       // LC Corp → Develia (2019)
  'VST': 'VRG',       // Vistula Group → VRG (2018)
  'PIL': 'DAT',       // PiLab → DataWalk (2018)
  // NewConnect renamed tickers
  'RAE': 'GVT',       // Raen → Grupa Virtus (2026)
  'VAK': 'BTF',       // Vakomtek → BTCS (2025)
  'SUN': 'MIG',       // Sundragon → Military Group (2025)
  'PGM': 'GNS',       // Polska Grupa Motoryzacyjna → Grupa Niewiadów (2025)
  'PUN': 'RAE',       // PunkPirates → Raen (2023)
  'BRZ': 'HUB',       // Boruta-Zachem → Hub.Tech (2022)
  'MCP': 'BEL',       // Medcamp → BeLeaf (2022)
  'IQP': 'PUN',       // IQ Partners → PunkPirates (2020)
  '7FT': 'OML',       // 7Fit → One More Level (2020)
  'BSP': 'IVO',       // Baltic Storage → Incuvo (2020)
  'ZAK': 'PDG',       // Zaks → Pyramid Games (2019)
  'SKN': 'SIM',       // Skin-System → SimFabric (2019)
  'BLU': 'CLC',       // Blumerang Pre-IPO → Columbus Energy (2018)
};

async function resolveIsin(
  isin: string,
  paperName: string,
  txCurrency: string,
): Promise<TickerMapEntry | null> {
  const isPseudoIsin = !isRealIsin(isin);

  // Should we prefer Warsaw Stock Exchange results?
  const isRealPolishIsin = isin.startsWith('PL') && isRealIsin(isin);
  const isPolishTicker = isRealPolishIsin || isin.endsWith('.WA') || (isPseudoIsin && txCurrency === 'PLN');

  // Clean up paper names: remove Bossa suffixes like "-NC", "-NC-FIX", "-C"
  const cleanName = paperName
    .replace(/-NC(?:-FIX)?$/i, '')
    .replace(/-C$/i, '')
    .replace(/\.WA$/i, '') // strip .WA suffix for Stooq lookups
    .trim();

  // === Polish pseudo-ISINs: Stooq FIRST (authoritative for GPW) ===
  // This covers: mBank tickers (CDR, KTY), XTB new format (Cyfrowy Polsat, PGE),
  // XTB old format (.WA suffix like JSW.WA, ANR.WA)
  if (isPolishTicker && isPseudoIsin && cleanName.length >= 2) {
    // Check aliases for ambiguous names (e.g., "Dino" → "DNP")
    const aliasedName = STOOQ_ALIASES[cleanName.toUpperCase()] || cleanName;

    // 1. Stooq ticker validation (works for short tickers: PGE, CDR, JSW, DNP)
    const candidates = [aliasedName];
    if (!aliasedName.toUpperCase().startsWith('ETF') && !aliasedName.toUpperCase().startsWith('BETA')) {
      if (aliasedName.length > 4) candidates.push(aliasedName.substring(0, 4));
      if (aliasedName.length > 3) candidates.push(aliasedName.substring(0, 3));
    }

    for (const candidate of candidates) {
      const stooqResult = await validateStooq(candidate);
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

    // 2. Stooq company name search (works for full names: mBank, Tauron, Budimex)
    if (cleanName.length >= 3) {
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

    // 3. Yahoo fallback with .WA preference
    const byIsin = await searchYahoo(isin);
    if (byIsin.length > 0) {
      const hit = byIsin.find(r => r.symbol.endsWith('.WA')) || byIsin[0];
      return await buildEntry(isin, hit.symbol, hit.name, hit.exchange, paperName, txCurrency);
    }

    if (cleanName !== isin) {
      const byName = await searchYahoo(cleanName);
      if (byName.length > 0) {
        const hit = byName.find(r => r.symbol.endsWith('.WA')) || byName[0];
        return await buildEntry(isin, hit.symbol, hit.name, hit.exchange, paperName, txCurrency);
      }
    }

    return null;
  }

  // === Non-Polish or real ISINs: Yahoo first ===

  // Strategy 1: Yahoo search by ISIN
  const byIsin = await searchYahoo(isin);
  if (byIsin.length > 0) {
    const hit = isPolishTicker
      ? byIsin.find(r => r.symbol.endsWith('.WA')) || byIsin[0]
      : byIsin[0];
    return await buildEntry(isin, hit.symbol, hit.name, hit.exchange, paperName, txCurrency);
  }

  // Strategy 2: Yahoo search by paper name
  if (cleanName.length >= 2) {
    const searchVariants = [cleanName];
    if (isPseudoIsin) {
      const split = splitEtfName(cleanName);
      if (split !== cleanName) searchVariants.push(split);
    }

    for (const variant of searchVariants) {
      const byName = await searchYahoo(variant);
      if (byName.length > 0) {
        return await buildEntry(isin, byName[0].symbol, byName[0].name, byName[0].exchange, paperName, txCurrency);
      }
    }
  }

  // Strategy 3: Stooq validation (fallback for real Polish ISINs)
  if (isPolishTicker && cleanName.length >= 2) {
    const candidates = [cleanName];
    if (!cleanName.toUpperCase().startsWith('ETF') && !cleanName.toUpperCase().startsWith('BETA')) {
      if (cleanName.length > 4) candidates.push(cleanName.substring(0, 4));
      if (cleanName.length > 3) candidates.push(cleanName.substring(0, 3));
    }

    for (const candidate of candidates) {
      const stooqResult = await validateStooq(candidate, cleanName);
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
