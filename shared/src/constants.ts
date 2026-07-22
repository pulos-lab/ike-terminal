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
// Łączna stawka podatku od dywidend dla polskiego rezydenta podatkowego.
// USA: zakładamy złożony W-8BEN (stawka traktatowa 15% WHT) — Bossa, XTB i mBank
// obsługują W-8BEN i realne wyciągi potwierdzają 15% (np. Bossa "netto ELV 85% USD",
// XTB "MSFT.US USD WHT 15%"). Użytkownik bez W-8BEN dostaje 30% u źródła —
// wtedy kwotę auto-dywidendy trzeba skorygować ręcznie.

/** Zwykłe konto maklerskie: WHT u źródła (Poziom 1) + polski podatek (Poziom 3) */
export const DIVIDEND_TAX_REGULAR: Record<string, number> = {
  PL: 0.19, // 0% WHT + 19% PL tax
  US: 0.19, // 15% WHT (W-8BEN) + 4% PL tax
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
  US: 0.15, // 15% WHT (W-8BEN) + 0%
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

// ============ Podatek od odsetek (od wolnych środków) ============
// Odsetki od gotówki to przychód ze źródła polskiego (broker) — podatek Belki 19%
// na koncie zwykłym, zwolnienie na IKE/IKZE. Bez zagranicznego WHT (inaczej niż
// dywidendy). Broker zwykle pobiera go u źródła (np. XTB „Free funds interest tax").
export const FREE_CASH_INTEREST_TAX_REGULAR = 0.19;
export const FREE_CASH_INTEREST_TAX_IKE_IKZE = 0;

/**
 * Awaryjne kursy walut → PLN, używane WYŁĄCZNIE gdy fetch z Yahoo zawiedzie.
 * Jedno źródło prawdy dla server (portfolio-engine, routes) — wartości orientacyjne,
 * lepsze niż 1:1, ale UI powinien docelowo sygnalizować że kurs jest awaryjny.
 */
export const DEFAULT_FX_PLN: Record<string, number> = {
  PLN: 1,
  USD: 4.0,
  CAD: 2.95,
  EUR: 4.3,
  GBP: 5.1,
  NOK: 0.38,
  HKD: 0.52,
  JPY: 0.028,
  CHF: 4.5,
  SEK: 0.39,
  DKK: 0.58,
  AUD: 2.65,
  SGD: 3.0,
  CZK: 0.17,
  MXN: 0.22,
};

// ============ Tryb demo (publiczny portfel przykładowy) ============

/**
 * Zarezerwowane id współdzielonego portfela demo. Bezpieczne jako klucz bypassa:
 * realne portfele mają id 'default' albo UUID v4 (createPortfolio), a dotychczasowy
 * regex walidacji nagłówka X-Portfolio-Id nie dopuszczał literału 'demo'.
 */
export const DEMO_PORTFOLIO_ID = 'demo';

/** Syntetyczny właściciel portfela demo — better-auth generuje własne id, więc żaden realny użytkownik nie może go dostać. */
export const DEMO_USER_ID = '__demo__';
