export const BENCHMARKS = {
  sp500: { label: 'S&P 500', yahooTicker: '^GSPC', source: 'yahoo' as const },
  nasdaq: { label: 'NASDAQ', yahooTicker: '^IXIC', source: 'yahoo' as const },
  wig20: { label: 'WIG20', stooqTicker: 'wig20', source: 'stooq' as const },
  mwig40: { label: 'mWIG40', stooqTicker: 'mwig40', source: 'stooq' as const },
  swig80: { label: 'sWIG80', stooqTicker: 'swig80', source: 'stooq' as const },
} as const;

export type BenchmarkKey = keyof typeof BENCHMARKS;

export const TIME_RANGES = {
  '1M': 30,
  '3M': 90,
  '6M': 180,
  'YTD': -1, // special: from Jan 1 of current year
  '1Y': 365,
  '3Y': 1095,
  '5Y': 1825,
  'ALL': 0,
} as const;

export type TimeRangeKey = keyof typeof TIME_RANGES;

/**
 * Map of old trading names to current ISINs.
 * Used during mBank import when paper name is a former company name.
 * ISIN doesn't change when a company rebrands, so we can map old name → ISIN.
 */
export const NAME_ALIASES: Record<string, string> = {
  'ONCOARENDI': 'PLONCTH00011',       // → Molecure (MOC.WA)
  'LIVECHAT': 'PLLVTSF00010',         // → Text (TXT.WA)
  'LIVECHATSOFTWARE': 'PLLVTSF00010', // → Text (TXT.WA)
  'R22': 'PLR220000018',              // → CyberFolks (CYB.WA)
  'R22.WA': 'PLR220000018',           // → CyberFolks (CYB.WA) — XTB format
  'BRU': 'PLMOBRK00013',             // → Mo-BRUK (MBR.WA) — old ticker
  'BRU.WA': 'PLMOBRK00013',          // → Mo-BRUK (MBR.WA) — XTB format
};

export const OPERATION_TYPES = {
  deposit: 'Wpłata',
  withdrawal: 'Wypłata',
  dividend: 'Dywidenda',
  fx_exchange: 'Wymiana walut',
  fee: 'Opłata',
  commission_refund: 'Zwrot prowizji',
  other: 'Inne',
} as const;
