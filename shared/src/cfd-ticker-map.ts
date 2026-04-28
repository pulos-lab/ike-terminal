/**
 * Static mapping of CFD instrument names (as used by XTB) to Yahoo Finance
 * tickers for live price fetching and category detection.
 *
 * Source: XTB "Specyfikacja instrumentów CFD" (14.03.2026) — 180 instruments.
 * Also used as a heuristic fallback to detect CFD category when the XTB
 * "Closed Positions" sheet is missing from the XLSX export.
 */

export interface CfdTickerEntry {
  yahooTicker: string;
  name: string;
  currency: string;
}

export const CFD_TICKER_MAP: Record<string, CfdTickerEntry> = {
  // ── Surowce ────────────────────────────────────────────────────────────
  GOLD: { yahooTicker: 'GC=F', name: 'Gold', currency: 'USD' },
  SILVER: { yahooTicker: 'SI=F', name: 'Silver', currency: 'USD' },
  OIL: { yahooTicker: 'BZ=F', name: 'Brent Crude', currency: 'USD' },
  'OIL.WTI': { yahooTicker: 'CL=F', name: 'Crude Oil WTI', currency: 'USD' },
  NATGAS: { yahooTicker: 'NG=F', name: 'Natural Gas', currency: 'USD' },
  COPPER: { yahooTicker: 'HG=F', name: 'Copper', currency: 'USD' },
  PLATINUM: { yahooTicker: 'PL=F', name: 'Platinum', currency: 'USD' },
  PLAT: { yahooTicker: 'PL=F', name: 'Platinum', currency: 'USD' }, // alias
  PALLADIUM: { yahooTicker: 'PA=F', name: 'Palladium', currency: 'USD' },
  PALLAD: { yahooTicker: 'PA=F', name: 'Palladium', currency: 'USD' }, // alias
  WHEAT: { yahooTicker: 'ZW=F', name: 'Wheat', currency: 'USD' },
  CORN: { yahooTicker: 'ZC=F', name: 'Corn', currency: 'USD' },
  SOYBEAN: { yahooTicker: 'ZS=F', name: 'Soybean', currency: 'USD' },
  SOYOIL: { yahooTicker: 'ZL=F', name: 'Soybean Oil', currency: 'USD' },
  COTTON: { yahooTicker: 'CT=F', name: 'Cotton', currency: 'USD' },
  COCOA: { yahooTicker: 'CC=F', name: 'Cocoa', currency: 'USD' },
  COFFEE: { yahooTicker: 'KC=F', name: 'Coffee', currency: 'USD' },
  SUGAR: { yahooTicker: 'SB=F', name: 'Sugar', currency: 'USD' },
  ALUMINIUM: { yahooTicker: 'ALI=F', name: 'Aluminium', currency: 'USD' },
  CATTLE: { yahooTicker: 'LE=F', name: 'Live Cattle', currency: 'USD' },
  GASOLINE: { yahooTicker: 'RB=F', name: 'RBOB Gasoline', currency: 'USD' },
  LEANHOGS: { yahooTicker: 'HE=F', name: 'Lean Hogs', currency: 'USD' },
  TNOTE: { yahooTicker: 'ZN=F', name: 'US 10Y T-Note', currency: 'USD' },
  // Untraceable commodities (no Yahoo equivalent):
  // BUND10Y, SCHATZ2Y, EMISS, LSGASOIL, NICKEL, ZINC

  // ── Indeksy ────────────────────────────────────────────────────────────
  US500: { yahooTicker: 'ES=F', name: 'S&P 500', currency: 'USD' },
  US100: { yahooTicker: 'NQ=F', name: 'NASDAQ 100', currency: 'USD' },
  US30: { yahooTicker: 'YM=F', name: 'Dow Jones', currency: 'USD' },
  US2000: { yahooTicker: 'RTY=F', name: 'Russell 2000', currency: 'USD' },
  DE40: { yahooTicker: '^GDAXI', name: 'DAX 40', currency: 'EUR' },
  UK100: { yahooTicker: '^FTSE', name: 'FTSE 100', currency: 'GBP' },
  FRA40: { yahooTicker: '^FCHI', name: 'CAC 40', currency: 'EUR' },
  EU50: { yahooTicker: '^STOXX50E', name: 'Euro Stoxx 50', currency: 'EUR' },
  JP225: { yahooTicker: '^N225', name: 'Nikkei 225', currency: 'JPY' },
  JAP225: { yahooTicker: '^N225', name: 'Nikkei 225', currency: 'JPY' }, // alias
  SPA35: { yahooTicker: '^IBEX', name: 'IBEX 35', currency: 'EUR' },
  W20: { yahooTicker: 'WIG20.WA', name: 'WIG20', currency: 'PLN' },
  VIX: { yahooTicker: '^VIX', name: 'VIX', currency: 'USD' },
  'AU200.CASH': { yahooTicker: '^AXJO', name: 'ASX 200', currency: 'AUD' },
  AUT20: { yahooTicker: '^ATX', name: 'ATX 20', currency: 'EUR' },
  BRACOMP: { yahooTicker: '^BVSP', name: 'Bovespa', currency: 'BRL' },
  CH50CASH: { yahooTicker: '^HSCE', name: 'FTSE China A50', currency: 'HKD' },
  'CHN.CASH': { yahooTicker: '^HSCE', name: 'China H-shares', currency: 'HKD' },
  'HK.CASH': { yahooTicker: '^HSI', name: 'Hang Seng', currency: 'HKD' },
  ITA40: { yahooTicker: '^FTMIB', name: 'FTSE MIB', currency: 'EUR' },
  MEXCOMP: { yahooTicker: '^MXX', name: 'IPC Mexico', currency: 'MXN' },
  NED25: { yahooTicker: '^AEX', name: 'AEX 25', currency: 'EUR' },
  SG20CASH: { yahooTicker: '^STI', name: 'Straits Times', currency: 'SGD' },
  SUI20: { yahooTicker: '^SSMI', name: 'SMI', currency: 'CHF' },
  USDIDX: { yahooTicker: 'DX-Y.NYB', name: 'US Dollar Index', currency: 'USD' },
  VSTOXX: { yahooTicker: '^V2TX', name: 'VSTOXX', currency: 'EUR' },
  // Untraceable indices: VIET30

  // ── Forex ──────────────────────────────────────────────────────────────
  AUDCAD: { yahooTicker: 'AUDCAD=X', name: 'AUD/CAD', currency: 'CAD' },
  AUDCHF: { yahooTicker: 'AUDCHF=X', name: 'AUD/CHF', currency: 'CHF' },
  AUDJPY: { yahooTicker: 'AUDJPY=X', name: 'AUD/JPY', currency: 'JPY' },
  AUDNZD: { yahooTicker: 'AUDNZD=X', name: 'AUD/NZD', currency: 'NZD' },
  AUDUSD: { yahooTicker: 'AUDUSD=X', name: 'AUD/USD', currency: 'USD' },
  CADCHF: { yahooTicker: 'CADCHF=X', name: 'CAD/CHF', currency: 'CHF' },
  CADJPY: { yahooTicker: 'CADJPY=X', name: 'CAD/JPY', currency: 'JPY' },
  CADMXN: { yahooTicker: 'CADMXN=X', name: 'CAD/MXN', currency: 'MXN' },
  CHFHUF: { yahooTicker: 'CHFHUF=X', name: 'CHF/HUF', currency: 'HUF' },
  CHFJPY: { yahooTicker: 'CHFJPY=X', name: 'CHF/JPY', currency: 'JPY' },
  CHFNOK: { yahooTicker: 'CHFNOK=X', name: 'CHF/NOK', currency: 'NOK' },
  CHFPLN: { yahooTicker: 'CHFPLN=X', name: 'CHF/PLN', currency: 'PLN' },
  CHFSEK: { yahooTicker: 'CHFSEK=X', name: 'CHF/SEK', currency: 'SEK' },
  EURAUD: { yahooTicker: 'EURAUD=X', name: 'EUR/AUD', currency: 'AUD' },
  EURCAD: { yahooTicker: 'EURCAD=X', name: 'EUR/CAD', currency: 'CAD' },
  EURCHF: { yahooTicker: 'EURCHF=X', name: 'EUR/CHF', currency: 'CHF' },
  EURCNH: { yahooTicker: 'EURCNH=X', name: 'EUR/CNH', currency: 'CNH' },
  EURCZK: { yahooTicker: 'EURCZK=X', name: 'EUR/CZK', currency: 'CZK' },
  EURGBP: { yahooTicker: 'EURGBP=X', name: 'EUR/GBP', currency: 'GBP' },
  EURHUF: { yahooTicker: 'EURHUF=X', name: 'EUR/HUF', currency: 'HUF' },
  EURJPY: { yahooTicker: 'EURJPY=X', name: 'EUR/JPY', currency: 'JPY' },
  EURMXN: { yahooTicker: 'EURMXN=X', name: 'EUR/MXN', currency: 'MXN' },
  EURNOK: { yahooTicker: 'EURNOK=X', name: 'EUR/NOK', currency: 'NOK' },
  EURNZD: { yahooTicker: 'EURNZD=X', name: 'EUR/NZD', currency: 'NZD' },
  EURPLN: { yahooTicker: 'EURPLN=X', name: 'EUR/PLN', currency: 'PLN' },
  EURRON: { yahooTicker: 'EURRON=X', name: 'EUR/RON', currency: 'RON' },
  EURSGD: { yahooTicker: 'EURSGD=X', name: 'EUR/SGD', currency: 'SGD' },
  EURSEK: { yahooTicker: 'EURSEK=X', name: 'EUR/SEK', currency: 'SEK' },
  EURTRY: { yahooTicker: 'EURTRY=X', name: 'EUR/TRY', currency: 'TRY' },
  EURUSD: { yahooTicker: 'EURUSD=X', name: 'EUR/USD', currency: 'USD' },
  EURZAR: { yahooTicker: 'EURZAR=X', name: 'EUR/ZAR', currency: 'ZAR' },
  GBPAUD: { yahooTicker: 'GBPAUD=X', name: 'GBP/AUD', currency: 'AUD' },
  GBPCAD: { yahooTicker: 'GBPCAD=X', name: 'GBP/CAD', currency: 'CAD' },
  GBPCHF: { yahooTicker: 'GBPCHF=X', name: 'GBP/CHF', currency: 'CHF' },
  GBPJPY: { yahooTicker: 'GBPJPY=X', name: 'GBP/JPY', currency: 'JPY' },
  GBPMXN: { yahooTicker: 'GBPMXN=X', name: 'GBP/MXN', currency: 'MXN' },
  GBPNOK: { yahooTicker: 'GBPNOK=X', name: 'GBP/NOK', currency: 'NOK' },
  GBPNZD: { yahooTicker: 'GBPNZD=X', name: 'GBP/NZD', currency: 'NZD' },
  GBPPLN: { yahooTicker: 'GBPPLN=X', name: 'GBP/PLN', currency: 'PLN' },
  GBPSGD: { yahooTicker: 'GBPSGD=X', name: 'GBP/SGD', currency: 'SGD' },
  GBPSEK: { yahooTicker: 'GBPSEK=X', name: 'GBP/SEK', currency: 'SEK' },
  GBPUSD: { yahooTicker: 'GBPUSD=X', name: 'GBP/USD', currency: 'USD' },
  GBPZAR: { yahooTicker: 'GBPZAR=X', name: 'GBP/ZAR', currency: 'ZAR' },
  NOKSEK: { yahooTicker: 'NOKSEK=X', name: 'NOK/SEK', currency: 'SEK' },
  NZDCAD: { yahooTicker: 'NZDCAD=X', name: 'NZD/CAD', currency: 'CAD' },
  NZDCHF: { yahooTicker: 'NZDCHF=X', name: 'NZD/CHF', currency: 'CHF' },
  NZDJPY: { yahooTicker: 'NZDJPY=X', name: 'NZD/JPY', currency: 'JPY' },
  NZDSGD: { yahooTicker: 'NZDSGD=X', name: 'NZD/SGD', currency: 'SGD' },
  NZDUSD: { yahooTicker: 'NZDUSD=X', name: 'NZD/USD', currency: 'USD' },
  USDBRL: { yahooTicker: 'USDBRL=X', name: 'USD/BRL', currency: 'BRL' },
  USDCAD: { yahooTicker: 'USDCAD=X', name: 'USD/CAD', currency: 'CAD' },
  USDCHF: { yahooTicker: 'USDCHF=X', name: 'USD/CHF', currency: 'CHF' },
  USDCLP: { yahooTicker: 'USDCLP=X', name: 'USD/CLP', currency: 'CLP' },
  USDCNH: { yahooTicker: 'USDCNH=X', name: 'USD/CNH', currency: 'CNH' },
  USDCZK: { yahooTicker: 'USDCZK=X', name: 'USD/CZK', currency: 'CZK' },
  USDHUF: { yahooTicker: 'USDHUF=X', name: 'USD/HUF', currency: 'HUF' },
  USDILS: { yahooTicker: 'USDILS=X', name: 'USD/ILS', currency: 'ILS' },
  USDINR: { yahooTicker: 'USDINR=X', name: 'USD/INR', currency: 'INR' },
  USDJPY: { yahooTicker: 'USDJPY=X', name: 'USD/JPY', currency: 'JPY' },
  USDMXN: { yahooTicker: 'USDMXN=X', name: 'USD/MXN', currency: 'MXN' },
  USDNOK: { yahooTicker: 'USDNOK=X', name: 'USD/NOK', currency: 'NOK' },
  USDPLN: { yahooTicker: 'USDPLN=X', name: 'USD/PLN', currency: 'PLN' },
  USDRON: { yahooTicker: 'USDRON=X', name: 'USD/RON', currency: 'RON' },
  USDSEK: { yahooTicker: 'USDSEK=X', name: 'USD/SEK', currency: 'SEK' },
  USDSGD: { yahooTicker: 'USDSGD=X', name: 'USD/SGD', currency: 'SGD' },
  USDTHB: { yahooTicker: 'USDTHB=X', name: 'USD/THB', currency: 'THB' },
  USDTRY: { yahooTicker: 'USDTRY=X', name: 'USD/TRY', currency: 'TRY' },
  USDZAR: { yahooTicker: 'USDZAR=X', name: 'USD/ZAR', currency: 'ZAR' },
  ZARJPY: { yahooTicker: 'ZARJPY=X', name: 'ZAR/JPY', currency: 'JPY' },

  // ── Krypto ─────────────────────────────────────────────────────────────
  AAVE: { yahooTicker: 'AAVE-USD', name: 'Aave', currency: 'USD' },
  ALGORAND: { yahooTicker: 'ALGO-USD', name: 'Algorand', currency: 'USD' },
  APECOIN: { yahooTicker: 'APE-USD', name: 'ApeCoin', currency: 'USD' },
  ARBITRUM: { yahooTicker: 'ARB-USD', name: 'Arbitrum', currency: 'USD' },
  AVALANCHE: { yahooTicker: 'AVAX-USD', name: 'Avalanche', currency: 'USD' },
  BINANCECOIN: { yahooTicker: 'BNB-USD', name: 'Binance Coin', currency: 'USD' },
  BITCOIN: { yahooTicker: 'BTC-USD', name: 'Bitcoin', currency: 'USD' },
  BITCOINCASH: { yahooTicker: 'BCH-USD', name: 'Bitcoin Cash', currency: 'USD' },
  BONK: { yahooTicker: 'BONK-USD', name: 'Bonk', currency: 'USD' },
  CARDANO: { yahooTicker: 'ADA-USD', name: 'Cardano', currency: 'USD' },
  CHAINLINK: { yahooTicker: 'LINK-USD', name: 'Chainlink', currency: 'USD' },
  CHILIZ: { yahooTicker: 'CHZ-USD', name: 'Chiliz', currency: 'USD' },
  COMPOUND: { yahooTicker: 'COMP-USD', name: 'Compound', currency: 'USD' },
  COSMOS: { yahooTicker: 'ATOM-USD', name: 'Cosmos', currency: 'USD' },
  COTI: { yahooTicker: 'COTI-USD', name: 'COTI', currency: 'USD' },
  CURVEDAO: { yahooTicker: 'CRV-USD', name: 'Curve DAO', currency: 'USD' },
  DECENTRALAND: { yahooTicker: 'MANA-USD', name: 'Decentraland', currency: 'USD' },
  DOGECOIN: { yahooTicker: 'DOGE-USD', name: 'Dogecoin', currency: 'USD' },
  DOGWIFHAT: { yahooTicker: 'WIF-USD', name: 'dogwifhat', currency: 'USD' },
  DYDX: { yahooTicker: 'DYDX-USD', name: 'dYdX', currency: 'USD' },
  ETHEREUM: { yahooTicker: 'ETH-USD', name: 'Ethereum', currency: 'USD' },
  FARTCOIN: { yahooTicker: 'FARTCOIN-USD', name: 'Fartcoin', currency: 'USD' },
  FILECOIN: { yahooTicker: 'FIL-USD', name: 'Filecoin', currency: 'USD' },
  GALA: { yahooTicker: 'GALA-USD', name: 'Gala', currency: 'USD' },
  GRAPH: { yahooTicker: 'GRT-USD', name: 'The Graph', currency: 'USD' },
  HEDERA: { yahooTicker: 'HBAR-USD', name: 'Hedera', currency: 'USD' },
  INJECTIVE: { yahooTicker: 'INJ-USD', name: 'Injective', currency: 'USD' },
  INTERCOMP: { yahooTicker: 'ICP-USD', name: 'Internet Computer', currency: 'USD' },
  JUPITER: { yahooTicker: 'JUP-USD', name: 'Jupiter', currency: 'USD' },
  KUSAMA: { yahooTicker: 'KSM-USD', name: 'Kusama', currency: 'USD' },
  KYBER: { yahooTicker: 'KNC-USD', name: 'Kyber Network', currency: 'USD' },
  LITECOIN: { yahooTicker: 'LTC-USD', name: 'Litecoin', currency: 'USD' },
  MOONBEAM: { yahooTicker: 'GLMR-USD', name: 'Moonbeam', currency: 'USD' },
  NEAR: { yahooTicker: 'NEAR-USD', name: 'NEAR Protocol', currency: 'USD' },
  ONDO: { yahooTicker: 'ONDO-USD', name: 'Ondo Finance', currency: 'USD' },
  PEPE: { yahooTicker: 'PEPE-USD', name: 'Pepe', currency: 'USD' },
  POLKADOT: { yahooTicker: 'DOT-USD', name: 'Polkadot', currency: 'USD' },
  POLYGON: { yahooTicker: 'POL-USD', name: 'Polygon', currency: 'USD' },
  POPCAT: { yahooTicker: 'POPCAT-USD', name: 'Popcat', currency: 'USD' },
  PYTH: { yahooTicker: 'PYTH-USD', name: 'Pyth Network', currency: 'USD' },
  RENDER: { yahooTicker: 'RENDER-USD', name: 'Render', currency: 'USD' },
  RIPPLE: { yahooTicker: 'XRP-USD', name: 'Ripple', currency: 'USD' },
  SANDBOX: { yahooTicker: 'SAND-USD', name: 'The Sandbox', currency: 'USD' },
  SHIBA: { yahooTicker: 'SHIB-USD', name: 'Shiba Inu', currency: 'USD' },
  SOLANA: { yahooTicker: 'SOL-USD', name: 'Solana', currency: 'USD' },
  STARKNET: { yahooTicker: 'STRK-USD', name: 'Starknet', currency: 'USD' },
  STELLAR: { yahooTicker: 'XLM-USD', name: 'Stellar', currency: 'USD' },
  STEPN: { yahooTicker: 'GMT-USD', name: 'STEPN', currency: 'USD' },
  SUI: { yahooTicker: 'SUI-USD', name: 'Sui', currency: 'USD' },
  SUSHI: { yahooTicker: 'SUSHI-USD', name: 'SushiSwap', currency: 'USD' },
  TEZOS: { yahooTicker: 'XTZ-USD', name: 'Tezos', currency: 'USD' },
  TONCOIN: { yahooTicker: 'TON-USD', name: 'Toncoin', currency: 'USD' },
  TRON: { yahooTicker: 'TRX-USD', name: 'TRON', currency: 'USD' },
  TRUMP: { yahooTicker: 'TRUMP-USD', name: 'TRUMP', currency: 'USD' },
  UNISWAP: { yahooTicker: 'UNI-USD', name: 'Uniswap', currency: 'USD' },
  VECHAIN: { yahooTicker: 'VET-USD', name: 'VeChain', currency: 'USD' },
  ZCASH: { yahooTicker: 'ZEC-USD', name: 'Zcash', currency: 'USD' },
};

/**
 * Find Yahoo ticker for a CFD instrument name (case-insensitive).
 */
export function findCfdTicker(instrument: string): CfdTickerEntry | null {
  return CFD_TICKER_MAP[instrument.toUpperCase()] ?? null;
}

export type CfdSector = 'Surowce' | 'Indeksy' | 'Forex' | 'Krypto';

/**
 * Derive CFD sector from a CfdTickerEntry using Yahoo ticker conventions.
 *
 * Yahoo symbol conventions follow natural sector groupings:
 * - `...-USD` → kryptowaluta (BTC-USD, ETH-USD…)
 * - `...=X`   → para walutowa / Forex (EURUSD=X…)
 * - `^...`    → indeks notowany przez Yahoo (^GSPC, ^FTSE…)
 * - `...=F` w kilku przypadkach → indeks futures (ES=F, NQ=F, YM=F, RTY=F)
 * - pozostałe `...=F` → futures surowca (GC=F, CL=F, NG=F…)
 * - specjalne: DX-Y.NYB (Dollar Index → Indeksy), WIG20.WA (→ Indeksy)
 *
 * Yahoo `assetProfile` nie zwraca sensownego sektora dla futures/forex/crypto
 * — ta mapa jest autorytatywnym źródłem dla CFD w portfelach XTB.
 */
const CFD_INDEX_FUTURES = new Set(['ES=F', 'NQ=F', 'YM=F', 'RTY=F']);

export function getCfdSector(entry: CfdTickerEntry): CfdSector {
  const y = entry.yahooTicker;
  if (y.endsWith('-USD')) return 'Krypto';
  if (y.endsWith('=X')) return 'Forex';
  if (y.startsWith('^') || y === 'DX-Y.NYB' || y.endsWith('.WA')) return 'Indeksy';
  if (CFD_INDEX_FUTURES.has(y)) return 'Indeksy';
  return 'Surowce'; // pozostałe futures =F (GC=F, CL=F, NG=F, HG=F, …)
}
