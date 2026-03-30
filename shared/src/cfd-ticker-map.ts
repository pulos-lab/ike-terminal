/**
 * Static mapping of popular CFD instrument names (as used by XTB)
 * to Yahoo Finance tickers for live price fetching.
 *
 * When a CFD transaction is imported or manually added, this map
 * provides the Yahoo ticker so the position appears in open positions
 * with live prices.
 */

export interface CfdTickerEntry {
  yahooTicker: string;
  name: string;
  currency: string;
}

export const CFD_TICKER_MAP: Record<string, CfdTickerEntry> = {
  // ── Surowce ────────────────────────────────────────────────────────────
  'GOLD':      { yahooTicker: 'GC=F',  name: 'Gold',           currency: 'USD' },
  'SILVER':    { yahooTicker: 'SI=F',  name: 'Silver',         currency: 'USD' },
  'OIL.WTI':   { yahooTicker: 'CL=F',  name: 'Crude Oil WTI',  currency: 'USD' },
  'OIL':       { yahooTicker: 'CL=F',  name: 'Crude Oil WTI',  currency: 'USD' },
  'OIL.BRENT': { yahooTicker: 'BZ=F',  name: 'Brent Crude',    currency: 'USD' },
  'NATGAS':    { yahooTicker: 'NG=F',  name: 'Natural Gas',    currency: 'USD' },
  'COPPER':    { yahooTicker: 'HG=F',  name: 'Copper',         currency: 'USD' },
  'PLAT':      { yahooTicker: 'PL=F',  name: 'Platinum',       currency: 'USD' },
  'PALLAD':    { yahooTicker: 'PA=F',  name: 'Palladium',      currency: 'USD' },
  'WHEAT':     { yahooTicker: 'ZW=F',  name: 'Wheat',          currency: 'USD' },
  'CORN':      { yahooTicker: 'ZC=F',  name: 'Corn',           currency: 'USD' },
  'SOYBEAN':   { yahooTicker: 'ZS=F',  name: 'Soybean',        currency: 'USD' },
  'COTTON':    { yahooTicker: 'CT=F',  name: 'Cotton',         currency: 'USD' },
  'COCOA':     { yahooTicker: 'CC=F',  name: 'Cocoa',          currency: 'USD' },
  'COFFEE':    { yahooTicker: 'KC=F',  name: 'Coffee',         currency: 'USD' },
  'SUGAR':     { yahooTicker: 'SB=F',  name: 'Sugar',          currency: 'USD' },

  // ── Indeksy ────────────────────────────────────────────────────────────
  'US500':     { yahooTicker: 'ES=F',   name: 'S&P 500',       currency: 'USD' },
  'US100':     { yahooTicker: 'NQ=F',   name: 'NASDAQ 100',    currency: 'USD' },
  'US30':      { yahooTicker: 'YM=F',   name: 'Dow Jones',     currency: 'USD' },
  'US2000':    { yahooTicker: 'RTY=F',  name: 'Russell 2000',  currency: 'USD' },
  'DE40':      { yahooTicker: '^GDAXI', name: 'DAX 40',        currency: 'EUR' },
  'UK100':     { yahooTicker: '^FTSE',  name: 'FTSE 100',      currency: 'GBP' },
  'FRA40':     { yahooTicker: '^FCHI',  name: 'CAC 40',        currency: 'EUR' },
  'EU50':      { yahooTicker: '^STOXX50E', name: 'Euro Stoxx 50', currency: 'EUR' },
  'JAP225':    { yahooTicker: '^N225',  name: 'Nikkei 225',    currency: 'JPY' },
  'SPA35':     { yahooTicker: '^IBEX',  name: 'IBEX 35',       currency: 'EUR' },
  'W20':       { yahooTicker: 'WIG20.WA', name: 'WIG20',       currency: 'PLN' },
  'VIX':       { yahooTicker: '^VIX',   name: 'VIX',           currency: 'USD' },

  // ── Forex ──────────────────────────────────────────────────────────────
  'EURUSD':    { yahooTicker: 'EURUSD=X', name: 'EUR/USD',     currency: 'USD' },
  'GBPUSD':    { yahooTicker: 'GBPUSD=X', name: 'GBP/USD',     currency: 'USD' },
  'USDPLN':    { yahooTicker: 'USDPLN=X', name: 'USD/PLN',     currency: 'PLN' },
  'EURPLN':    { yahooTicker: 'EURPLN=X', name: 'EUR/PLN',     currency: 'PLN' },
  'GBPPLN':    { yahooTicker: 'GBPPLN=X', name: 'GBP/PLN',     currency: 'PLN' },
  'USDJPY':    { yahooTicker: 'USDJPY=X', name: 'USD/JPY',     currency: 'JPY' },
  'USDCHF':    { yahooTicker: 'USDCHF=X', name: 'USD/CHF',     currency: 'CHF' },
  'AUDUSD':    { yahooTicker: 'AUDUSD=X', name: 'AUD/USD',     currency: 'USD' },
  'USDCAD':    { yahooTicker: 'USDCAD=X', name: 'USD/CAD',     currency: 'CAD' },
  'NZDUSD':    { yahooTicker: 'NZDUSD=X', name: 'NZD/USD',     currency: 'USD' },
  'EURGBP':    { yahooTicker: 'EURGBP=X', name: 'EUR/GBP',     currency: 'GBP' },
  'EURJPY':    { yahooTicker: 'EURJPY=X', name: 'EUR/JPY',     currency: 'JPY' },
  'EURCHF':    { yahooTicker: 'EURCHF=X', name: 'EUR/CHF',     currency: 'CHF' },

  // ── Krypto ─────────────────────────────────────────────────────────────
  'BITCOIN':   { yahooTicker: 'BTC-USD', name: 'Bitcoin',      currency: 'USD' },
  'ETHEREUM':  { yahooTicker: 'ETH-USD', name: 'Ethereum',     currency: 'USD' },
  'LITECOIN':  { yahooTicker: 'LTC-USD', name: 'Litecoin',     currency: 'USD' },
  'RIPPLE':    { yahooTicker: 'XRP-USD', name: 'Ripple',       currency: 'USD' },
  'SOLANA':    { yahooTicker: 'SOL-USD', name: 'Solana',       currency: 'USD' },
};

/**
 * Find Yahoo ticker for a CFD instrument name (case-insensitive).
 */
export function findCfdTicker(instrument: string): CfdTickerEntry | null {
  return CFD_TICKER_MAP[instrument.toUpperCase()] ?? null;
}
