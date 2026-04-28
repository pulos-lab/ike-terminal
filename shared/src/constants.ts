export const BENCHMARKS = {
  none: { label: 'Brak', source: 'none' as const, currency: 'PLN' },
  sp500: { label: 'S&P 500', yahooTicker: '^GSPC', source: 'yahoo' as const, currency: 'USD' },
  nasdaq: { label: 'NASDAQ', yahooTicker: '^IXIC', source: 'yahoo' as const, currency: 'USD' },
  wig: {
    label: 'WIG',
    stooqTicker: 'wig',
    yahooTicker: 'WIG.WA',
    source: 'stooq' as const,
    currency: 'PLN',
  },
  wig20: {
    label: 'WIG20',
    stooqTicker: 'wig20',
    yahooTicker: 'WIG20.WA',
    source: 'stooq' as const,
    currency: 'PLN',
  },
  mwig40: {
    label: 'mWIG40',
    stooqTicker: 'mwig40',
    yahooTicker: 'MWIG40.WA',
    source: 'stooq' as const,
    currency: 'PLN',
  },
  swig80: {
    label: 'sWIG80',
    stooqTicker: 'swig80',
    yahooTicker: 'SWIG80.WA',
    source: 'stooq' as const,
    currency: 'PLN',
  },
} as const;

export type BenchmarkKey = keyof typeof BENCHMARKS;

export const TIME_RANGES = {
  '1M': 30,
  '3M': 90,
  '6M': 180,
  YTD: -1, // special: from Jan 1 of current year
  '1Y': 365,
  '3Y': 1095,
  '5Y': 1825,
  ALL: 0,
} as const;

export type TimeRangeKey = keyof typeof TIME_RANGES;

/**
 * Map of old trading names to current ISINs.
 * Used during mBank import when paper name is a former company name.
 * ISIN doesn't change when a company rebrands, so we can map old name → ISIN.
 */
export const NAME_ALIASES: Record<string, string> = {
  ONCOARENDI: 'PLONCTH00011', // → Molecure (MOC.WA)
  LIVECHAT: 'PLLVTSF00010', // → Text (TXT.WA)
  LIVECHATSOFTWARE: 'PLLVTSF00010', // → Text (TXT.WA)
  R22: 'PLR220000018', // → CyberFolks (CYB.WA)
  'R22.WA': 'PLR220000018', // → CyberFolks (CYB.WA) — XTB format
  BRU: 'PLMOBRK00013', // → Mo-BRUK (MBR.WA) — old ticker
  'BRU.WA': 'PLMOBRK00013', // → Mo-BRUK (MBR.WA) — XTB format
};

// ============ Dividend Tax Tables ============
// Łączna stawka podatku od dywidend dla polskiego rezydenta podatkowego

/** Zwykłe konto maklerskie: WHT u źródła (Poziom 1) + polski podatek (Poziom 3) */
export const DIVIDEND_TAX_REGULAR: Record<string, number> = {
  PL: 0.19, // 0% WHT + 19% PL tax
  US: 0.34, // 30% WHT + 4% PL tax
  GB: 0.19, // 0% WHT + 19% PL tax
  DE: 0.304, // 26.4% WHT + 4% PL tax
  BE: 0.19, // 15% WHT + 4% PL tax
  CH: 0.19, // 15% WHT + 4% PL tax
  FR: 0.19, // 15% WHT + 4% PL tax
  JP: 0.19, // 15% WHT + 4% PL tax
  AU: 0.19, // 15% WHT + 4% PL tax
  HK: 0.19, // 0% WHT + 19% PL tax
  SG: 0.19, // 0% WHT + 19% PL tax
  CA: 0.19, // 15% WHT + 4% PL tax
  NL: 0.19, // 15% WHT + 4% PL tax
  IE: 0.19, // 15% WHT + 4% PL tax
  NO: 0.19, // 15% WHT + 4% PL tax
};

/** IKE / IKZE: tylko WHT u źródła (Poziom 1), Poziom 3 = 0% */
export const DIVIDEND_TAX_IKE_IKZE: Record<string, number> = {
  PL: 0, // 0% WHT + 0% = zwolnienie
  US: 0.3, // 30% WHT + 0%
  GB: 0, // 0% WHT + 0%
  DE: 0.264, // 26.4% WHT + 0%
  BE: 0.15, // 15% WHT + 0%
  CH: 0.15, // 15% WHT + 0%
  FR: 0.15, // 15% WHT + 0%
  JP: 0.15, // 15% WHT + 0%
  AU: 0.15, // 15% WHT + 0%
  HK: 0, // 0% WHT + 0%
  SG: 0, // 0% WHT + 0%
  CA: 0.15, // 15% WHT + 0%
  NL: 0.15, // 15% WHT + 0%
  IE: 0.15, // 15% WHT + 0%
  NO: 0.15, // 15% WHT + 0%
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
