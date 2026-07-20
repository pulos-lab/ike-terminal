import type { CashOperation, PortfolioSettings, TickerMapEntry, Transaction } from 'shared';
import { DEFAULT_PORTFOLIO_SETTINGS } from 'shared';

/**
 * Ręcznie ułożony, FIKCYJNY portfel demo: "dobrze prowadzone IKE 2021–2026".
 * Kwoty i ilości są zmyślone; ISIN-y i tickery są prawdziwe, żeby działały
 * historia cen (Yahoo), wyceny live i klasyfikacja sektorowa. Ceny transakcji
 * mieszczą się w historycznie wiarygodnych widełkach, więc zyski/straty na
 * pozycjach wyglądają sensownie na tle realnych notowań.
 *
 * Narracja: coroczne wpłaty ~limit IKE, kilka spółek GPW + globalny ETF (VWCE)
 * + dwie spółki US (po wymianie PLN→USD), jedna bolesna strata (Allegro kupione
 * na górce 2021), jedna zrealizowana z zyskiem (część PKO), dywidendy PL i US
 * (US z 15% podatkiem u źródła — IKE nie chroni przed WHT).
 */

export const DEMO_PORTFOLIO_NAME = 'Portfel demo';

export const DEMO_SETTINGS: PortfolioSettings = {
  ...DEFAULT_PORTFOLIO_SETTINGS,
  isIKE: true,
  commissionPl: 0.39,
  commissionForeign: 0.29,
  minCommissionPl: 5,
  minCommissionForeign: 19,
};

export const DEMO_TICKERS: TickerMapEntry[] = [
  {
    isin: 'PLOPTTC00011',
    ticker: 'CDR.WA',
    name: 'CD Projekt',
    exchange: 'GPW',
    currency: 'PLN',
    priceSource: 'yahoo',
    supersector: 'Handel i usługi',
    sector: 'Gry',
    country: 'Poland',
  },
  {
    isin: 'PLPKO0000016',
    ticker: 'PKO.WA',
    name: 'PKO BP',
    exchange: 'GPW',
    currency: 'PLN',
    priceSource: 'yahoo',
    supersector: 'Finanse',
    sector: 'Banki',
    country: 'Poland',
  },
  {
    isin: 'PLPZU0000011',
    ticker: 'PZU.WA',
    name: 'PZU',
    exchange: 'GPW',
    currency: 'PLN',
    priceSource: 'yahoo',
    supersector: 'Finanse',
    sector: 'Ubezpieczenia',
    country: 'Poland',
  },
  {
    isin: 'PLALLGR00005',
    ticker: 'ALE.WA',
    name: 'Allegro.eu',
    exchange: 'GPW',
    currency: 'PLN',
    priceSource: 'yahoo',
    supersector: 'Handel i usługi',
    sector: 'Handel internetowy',
    country: 'Poland',
  },
  {
    isin: 'PLGSPR000014',
    ticker: 'GTN.WA',
    name: 'Getin Holding',
    exchange: 'GPW',
    currency: 'PLN',
    priceSource: 'yahoo',
    supersector: 'Finanse',
    sector: 'Banki',
    country: 'Poland',
  },
  {
    isin: 'IE00BK5BQT80',
    ticker: 'VWCE.DE',
    name: 'Vanguard FTSE All-World UCITS ETF',
    exchange: 'XETRA',
    currency: 'EUR',
    priceSource: 'yahoo',
    supersector: 'ETF',
  },
  {
    isin: 'US0378331005',
    ticker: 'AAPL',
    name: 'Apple Inc.',
    exchange: 'NASDAQ',
    currency: 'USD',
    priceSource: 'yahoo',
    supersector: 'Technologie',
    sector: 'Elektronika użytkowa',
    country: 'United States',
  },
  {
    isin: 'US5949181045',
    ticker: 'MSFT',
    name: 'Microsoft Corp.',
    exchange: 'NASDAQ',
    currency: 'USD',
    priceSource: 'yahoo',
    supersector: 'Technologie',
    sector: 'Oprogramowanie',
    country: 'United States',
  },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Zwięzły konstruktor transakcji demo — total wg konwencji silnika (K: value+prowizja, S: value−prowizja). */
function tx(
  date: string,
  isin: string,
  paperName: string,
  side: 'K' | 'S',
  quantity: number,
  price: number,
  currency: string,
  commission: number,
  opts: { paymentCurrency?: string; fxRate?: number; category?: Transaction['category'] } = {},
): Transaction {
  const value = round2(quantity * price);
  return {
    date,
    paperName,
    isin,
    quantity,
    side,
    price,
    value,
    commission,
    total: round2(side === 'K' ? value + commission : value - commission),
    currency,
    paymentCurrency: opts.paymentCurrency,
    fxRate: opts.fxRate,
    category: opts.category ?? 'stock',
    source: 'manual',
    importBatch: 'seed-demo',
  };
}

// VWCE i MSFT (część zakupów) rozliczane w PLN przez auto-FX brokera:
// paymentCurrency='PLN' + fxRate (PLN za 1 EUR/USD). AAPL płacone z gotówki USD
// po jawnej wymianie walut (patrz DEMO_OPERATIONS).
export const DEMO_TRANSACTIONS: Transaction[] = [
  // ── 2021: pierwszy rok IKE ──
  tx('2021-02-10', 'PLALLGR00005', 'Allegro.eu', 'K', 60, 68.0, 'PLN', 15.94),
  tx('2021-03-15', 'PLPKO0000016', 'PKO BP', 'K', 100, 32.1, 'PLN', 12.52),
  tx('2021-05-20', 'PLPZU0000011', 'PZU', 'K', 120, 34.5, 'PLN', 16.15),
  tx('2021-09-10', 'IE00BK5BQT80', 'Vanguard FTSE All-World UCITS ETF', 'K', 8, 97.2, 'EUR', 3.1, {
    paymentCurrency: 'PLN',
    fxRate: 4.57,
    category: 'etf',
  }),
  // ── 2022: dokupowanie w bessie + bolesne cięcie straty na Allegro ──
  tx('2022-03-08', 'IE00BK5BQT80', 'Vanguard FTSE All-World UCITS ETF', 'K', 12, 89.5, 'EUR', 3.3, {
    paymentCurrency: 'PLN',
    fxRate: 4.68,
    category: 'etf',
  }),
  // Getin Holding — zagranie pod uchwalony zwrot z obniżenia kapitału (1 zł/akcję):
  // kupno po ~1,17 zł, realny zwrot 30.12.2022, realna dywidenda 0,58 zł (05.2023),
  // sprzedaż po ~0,60 zł. Na nogach akcyjnych strata, ale wypłaty z nawiązką ją
  // pokrywają — dokładnie tak wyglądała prawdziwa teza inwestycyjna na GTN.
  tx('2022-06-08', 'PLGSPR000014', 'Getin Holding', 'K', 2000, 1.17, 'PLN', 9.13),
  tx('2022-06-15', 'PLOPTTC00011', 'CD Projekt', 'K', 30, 92.3, 'PLN', 10.8),
  tx('2022-10-12', 'PLPKO0000016', 'PKO BP', 'K', 150, 22.4, 'PLN', 13.1),
  tx('2022-11-18', 'PLALLGR00005', 'Allegro.eu', 'S', 60, 24.1, 'PLN', 5.64),
  tx('2022-12-05', 'PLPZU0000011', 'PZU', 'K', 100, 26.8, 'PLN', 10.45),
  // ── 2023: wejście na rynek US (po wymianie PLN→USD) ──
  tx('2023-03-10', 'US0378331005', 'Apple Inc.', 'K', 15, 150.1, 'USD', 7.0),
  tx(
    '2023-06-14',
    'IE00BK5BQT80',
    'Vanguard FTSE All-World UCITS ETF',
    'K',
    14,
    99.8,
    'EUR',
    4.05,
    {
      paymentCurrency: 'PLN',
      fxRate: 4.51,
      category: 'etf',
    },
  ),
  tx('2023-09-14', 'PLGSPR000014', 'Getin Holding', 'S', 2000, 0.6, 'PLN', 5.0),
  tx('2023-11-21', 'PLOPTTC00011', 'CD Projekt', 'K', 20, 104.9, 'PLN', 8.18),
  // ── 2024 ──
  tx('2024-01-22', 'PLOPTTC00011', 'CD Projekt', 'K', 15, 117.5, 'PLN', 6.87),
  tx('2024-04-16', 'PLPKO0000016', 'PKO BP', 'K', 100, 52.3, 'PLN', 20.4),
  tx('2024-06-12', 'US5949181045', 'Microsoft Corp.', 'K', 5, 424.0, 'USD', 6.15, {
    paymentCurrency: 'PLN',
    fxRate: 3.98,
  }),
  tx(
    '2024-09-18',
    'IE00BK5BQT80',
    'Vanguard FTSE All-World UCITS ETF',
    'K',
    10,
    118.4,
    'EUR',
    3.43,
    {
      paymentCurrency: 'PLN',
      fxRate: 4.28,
      category: 'etf',
    },
  ),
  // ── 2025: realizacja zysku na części PKO ──
  tx(
    '2025-02-11',
    'IE00BK5BQT80',
    'Vanguard FTSE All-World UCITS ETF',
    'K',
    12,
    126.7,
    'EUR',
    4.41,
    {
      paymentCurrency: 'PLN',
      fxRate: 4.19,
      category: 'etf',
    },
  ),
  tx('2025-05-14', 'PLPKO0000016', 'PKO BP', 'S', 100, 67.8, 'PLN', 26.44),
  tx('2025-05-20', 'PLPZU0000011', 'PZU', 'K', 80, 47.9, 'PLN', 14.94),
  tx('2025-10-07', 'PLOPTTC00011', 'CD Projekt', 'K', 10, 194.5, 'PLN', 7.59),
  tx(
    '2025-11-13',
    'IE00BK5BQT80',
    'Vanguard FTSE All-World UCITS ETF',
    'K',
    15,
    131.8,
    'EUR',
    5.73,
    {
      paymentCurrency: 'PLN',
      fxRate: 4.24,
      category: 'etf',
    },
  ),
  // ── 2026 ──
  tx('2026-02-10', 'US5949181045', 'Microsoft Corp.', 'K', 4, 468.0, 'USD', 5.43, {
    paymentCurrency: 'PLN',
    fxRate: 3.92,
  }),
  tx(
    '2026-03-12',
    'IE00BK5BQT80',
    'Vanguard FTSE All-World UCITS ETF',
    'K',
    20,
    137.6,
    'EUR',
    7.98,
    {
      paymentCurrency: 'PLN',
      fxRate: 4.26,
      category: 'etf',
    },
  ),
  tx('2026-05-19', 'PLPKO0000016', 'PKO BP', 'K', 120, 70.6, 'PLN', 33.04),
];

function deposit(date: string, amount: number, year: number): CashOperation {
  return {
    date,
    operationType: 'deposit',
    description: `Wpłata na IKE ${year}`,
    amount,
    currency: 'PLN',
    source: 'manual',
    importBatch: 'seed-demo',
  };
}

/** Dywidenda netto (PL w IKE: 0% podatku; US: 15% WHT potrącone u źródła). */
function dividend(
  date: string,
  ticker: string,
  amount: number,
  currency: string,
  description: string,
): CashOperation {
  return {
    date,
    operationType: 'dividend',
    description,
    amount,
    currency,
    ticker,
    source: 'manual',
    importBatch: 'seed-demo',
  };
}

export const DEMO_OPERATIONS: CashOperation[] = [
  // ── Wpłaty roczne (limity IKE z danego roku) ──
  deposit('2021-01-05', 15777, 2021),
  deposit('2022-01-04', 17766, 2022),
  deposit('2023-01-04', 20805, 2023),
  deposit('2024-01-03', 23472, 2024),
  deposit('2025-01-07', 26019, 2025),
  deposit('2026-01-05', 28260, 2026),
  // ── Wymiana walut przed zakupem AAPL (para nóg jak w POST /fx-exchanges) ──
  {
    date: '2023-03-08',
    operationType: 'fx_exchange',
    description: 'Wymiana waluty PLN/USD 4.42',
    amount: -10000,
    currency: 'PLN',
    fxRate: 4.42,
    fxPair: 'PLN/USD',
    source: 'manual',
    importBatch: 'seed-demo',
  },
  {
    date: '2023-03-08',
    operationType: 'fx_exchange',
    description: 'Wymiana waluty PLN/USD 4.42',
    amount: 2262.44,
    currency: 'USD',
    fxRate: 4.42,
    fxPair: 'PLN/USD',
    source: 'manual',
    importBatch: 'seed-demo',
  },
  // ── Dywidendy GPW (w IKE bez podatku Belki) ──
  dividend('2022-10-06', 'PZU.WA', 232.8, 'PLN', '1.94 PLN/szt · podatek 0% (IKE)'),
  // Realna dywidenda GTN: 0,58 zł/akcję, dzień dywidendy 05.05.2023, wypłata 10.05.2023
  dividend('2023-05-10', 'GTN.WA', 1160.0, 'PLN', '0.58 PLN/szt · podatek 0% (IKE)'),
  dividend('2023-08-10', 'PKO.WA', 320.0, 'PLN', '1.28 PLN/szt · podatek 0% (IKE)'),
  dividend('2023-09-21', 'PZU.WA', 528.0, 'PLN', '2.40 PLN/szt · podatek 0% (IKE)'),
  dividend('2024-08-14', 'PKO.WA', 647.5, 'PLN', '2.59 PLN/szt · podatek 0% (IKE)'),
  dividend('2024-09-19', 'PZU.WA', 954.8, 'PLN', '4.34 PLN/szt · podatek 0% (IKE)'),
  dividend('2025-08-13', 'PKO.WA', 427.5, 'PLN', '2.85 PLN/szt · podatek 0% (IKE)'),
  dividend('2025-09-18', 'PZU.WA', 1341.0, 'PLN', '4.47 PLN/szt · podatek 0% (IKE)'),
  // ── Pozostałe przepływy (zakładka "Korekty i koszty") ──
  {
    date: '2024-01-15',
    operationType: 'fee',
    description: 'Opłata roczna za dostęp do notowań GPW',
    amount: -49.0,
    currency: 'PLN',
    source: 'manual',
    importBatch: 'seed-demo',
  },
  {
    date: '2025-01-14',
    operationType: 'fee',
    description: 'Opłata roczna za dostęp do notowań GPW',
    amount: -49.0,
    currency: 'PLN',
    source: 'manual',
    importBatch: 'seed-demo',
  },
  {
    date: '2024-06-20',
    operationType: 'commission_refund',
    description: 'Zwrot prowizji — promocja brokera',
    amount: 18.5,
    currency: 'PLN',
    source: 'manual',
    importBatch: 'seed-demo',
  },
  {
    date: '2025-07-01',
    operationType: 'other',
    subkind: 'interest',
    description: 'Odsetki od wolnych środków',
    amount: 42.37,
    currency: 'PLN',
    source: 'manual',
    importBatch: 'seed-demo',
  },
  {
    date: '2026-01-02',
    operationType: 'other',
    subkind: 'interest',
    description: 'Odsetki od wolnych środków',
    amount: 38.11,
    currency: 'PLN',
    source: 'manual',
    importBatch: 'seed-demo',
  },
  // ── Zdarzenie korporacyjne: REALNY zwrot kapitału Getin Holding ──
  // Obniżenie wartości nominalnej akcji z 4,00 zł do 0,10 zł; wypłata 1,00 zł
  // na akcję, dzień ustalenia praw 09.12.2022, wypłata przez KDPW 30.12.2022.
  // Cash wpływa, pozycja bez zmian — silnik liczy capital_return do
  // zrealizowanego zwrotu, sekcja "Zdarzenia korporacyjne" pokazuje badge.
  {
    date: '2022-12-30',
    operationType: 'capital_return',
    subkind: 'nominal_reduction',
    description:
      'Obniżenie wartości nominalnej akcji z 4,00 zł do 0,10 zł (1,00 zł/szt. × 2000 szt.)',
    amount: 2000.0,
    currency: 'PLN',
    ticker: 'GTN.WA',
    source: 'manual',
    importBatch: 'seed-demo',
  },
  // ── Dywidendy US (netto po 15% WHT, wypłata w USD) ──
  dividend('2023-08-17', 'AAPL', 3.06, 'USD', '0.24 USD/szt · podatek 15%'),
  dividend('2024-02-15', 'AAPL', 3.06, 'USD', '0.24 USD/szt · podatek 15%'),
  dividend('2024-08-15', 'AAPL', 3.19, 'USD', '0.25 USD/szt · podatek 15%'),
  dividend('2024-09-12', 'MSFT', 3.19, 'USD', '0.75 USD/szt · podatek 15%'),
  dividend('2024-12-12', 'MSFT', 3.19, 'USD', '0.75 USD/szt · podatek 15%'),
  dividend('2025-02-13', 'AAPL', 3.19, 'USD', '0.25 USD/szt · podatek 15%'),
  dividend('2025-03-13', 'MSFT', 3.53, 'USD', '0.83 USD/szt · podatek 15%'),
  dividend('2025-08-14', 'AAPL', 3.32, 'USD', '0.26 USD/szt · podatek 15%'),
  dividend('2025-09-11', 'MSFT', 3.53, 'USD', '0.83 USD/szt · podatek 15%'),
  dividend('2026-02-12', 'AAPL', 3.32, 'USD', '0.26 USD/szt · podatek 15%'),
  dividend('2026-03-12', 'MSFT', 6.35, 'USD', '0.83 USD/szt · podatek 15%'),
];
