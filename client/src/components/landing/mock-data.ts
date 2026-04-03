// Mock data for landing page interactive demo

// ── Dashboard chart data (12 months, daily points) ─────────────────────────
function generateChartData() {
  const data: { date: string; portfolio: number; benchmark: number }[] = [];
  const startDate = new Date('2025-04-01');
  let portfolioReturn = 0;
  let benchmarkReturn = 0;

  for (let i = 0; i <= 365; i += 2) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);
    if (date > new Date('2026-04-01')) break;

    // Simulate realistic returns with some volatility
    const portfolioDelta = (Math.random() - 0.46) * 0.8;
    const benchmarkDelta = (Math.random() - 0.47) * 0.6;
    portfolioReturn += portfolioDelta;
    benchmarkReturn += benchmarkDelta;

    data.push({
      date: date.toISOString().slice(0, 10),
      portfolio: Math.round(portfolioReturn * 100) / 100,
      benchmark: Math.round(benchmarkReturn * 100) / 100,
    });
  }

  // Normalize to end at target values
  const lastP = data[data.length - 1].portfolio;
  const lastB = data[data.length - 1].benchmark;
  const pScale = 34.2 / (lastP || 1);
  const bScale = 22.8 / (lastB || 1);

  return data.map((d) => ({
    ...d,
    portfolio: Math.round(d.portfolio * pScale * 100) / 100,
    benchmark: Math.round(d.benchmark * bScale * 100) / 100,
  }));
}

export const DEMO_CHART_DATA = generateChartData();

// ── Dashboard stats ────────────────────────────────────────────────────────
export const DEMO_STATS = [
  { label: 'Stopa zwrotu', value: '+34,2%', positive: true },
  { label: 'vs S&P 500', value: '+11,4 pp', positive: true },
  { label: 'CAGR', value: '+28,1%', positive: true },
  { label: 'Volatility', value: '14,3%', positive: null },
  { label: 'Sharpe Ratio', value: '1,42', positive: true },
  { label: 'Sortino Ratio', value: '2,18', positive: true },
  { label: 'Max Drawdown', value: '-8,3%', positive: false },
  { label: 'Max DD Duration', value: '34 dni', positive: null },
  { label: 'Calmar Ratio', value: '3,39', positive: true },
  { label: 'Best Day', value: '+3,1%', positive: true },
  { label: 'Worst Day', value: '-2,4%', positive: false },
  { label: 'Win Rate', value: '56,2%', positive: true },
];

// ── Portfolio positions ────────────────────────────────────────────────────
export const DEMO_POSITIONS = [
  {
    ticker: 'CDR',
    name: 'CD Projekt',
    category: 'Stock' as const,
    quantity: 45,
    avgPrice: 198.50,
    currentPrice: 247.80,
    currency: 'PLN',
    valuePLN: 11_151.00,
    pl: 2_218.50,
    plPct: 24.88,
    weight: 14.2,
  },
  {
    ticker: 'PKO',
    name: 'PKO Bank Polski',
    category: 'Stock' as const,
    quantity: 200,
    avgPrice: 42.30,
    currentPrice: 51.75,
    currency: 'PLN',
    valuePLN: 10_350.00,
    pl: 1_890.00,
    plPct: 22.34,
    weight: 13.2,
  },
  {
    ticker: 'AAPL',
    name: 'Apple Inc.',
    category: 'Stock' as const,
    quantity: 15,
    avgPrice: 178.20,
    currentPrice: 213.40,
    currency: 'USD',
    valuePLN: 12_804.00,
    pl: 2_112.00,
    plPct: 19.74,
    weight: 16.3,
  },
  {
    ticker: 'MSFT',
    name: 'Microsoft Corp.',
    category: 'Stock' as const,
    quantity: 8,
    avgPrice: 380.50,
    currentPrice: 428.90,
    currency: 'USD',
    valuePLN: 13_724.80,
    pl: 1_548.80,
    plPct: 12.72,
    weight: 17.5,
  },
  {
    ticker: 'ASML',
    name: 'ASML Holding',
    category: 'Stock' as const,
    quantity: 3,
    avgPrice: 620.00,
    currentPrice: 734.50,
    currency: 'EUR',
    valuePLN: 9_530.10,
    pl: 1_483.35,
    plPct: 18.47,
    weight: 12.1,
  },
  {
    ticker: 'VWCE',
    name: 'Vanguard FTSE All-World',
    category: 'ETF' as const,
    quantity: 25,
    avgPrice: 108.40,
    currentPrice: 119.85,
    currency: 'EUR',
    valuePLN: 12_944.85,
    pl: 1_237.43,
    plPct: 10.56,
    weight: 16.5,
  },
  {
    ticker: 'PKN',
    name: 'PKN Orlen',
    category: 'Stock' as const,
    quantity: 80,
    avgPrice: 62.10,
    currentPrice: 58.30,
    currency: 'PLN',
    valuePLN: 4_664.00,
    pl: -304.00,
    plPct: -6.12,
    weight: 5.9,
  },
  {
    ticker: 'ALR',
    name: 'Alior Bank',
    category: 'Stock' as const,
    quantity: 50,
    avgPrice: 78.60,
    currentPrice: 86.90,
    currency: 'PLN',
    valuePLN: 4_345.00,
    pl: 415.00,
    plPct: 10.56,
    weight: 5.5,
  },
];

export const DEMO_CASH = [
  { currency: 'PLN', balance: 2_340.25, valuePLN: 2_340.25, weight: 2.9 },
  { currency: 'USD', balance: 124.80, valuePLN: 499.20, weight: 0.6 },
];

export const DEMO_PORTFOLIO_TOTAL = {
  valuePLN: 82_353.20,
  invested: 61_420.00,
  pl: 20_933.20,
  plPct: 34.08,
};

// ── Closed Trades (FIFO grouped) ──────────────────────────────────────────

export interface DemoClosedTrade {
  ticker: string;
  quantity: number;
  buyDate: string;
  buyPrice: number;
  sellDate: string;
  sellPrice: number;
  currency: string;
  profitLoss: number;
  profitLossPct: number;
  holdingDays: number;
}

export interface DemoTradeGroup {
  ticker: string;
  sellDate: string;
  sellPrice: number;
  currency: string;
  totalQuantity: number;
  totalProfitLoss: number;
  weightedProfitLossPct: number;
  trades: DemoClosedTrade[];
}

export const DEMO_CLOSED_TRADES: DemoTradeGroup[] = [
  {
    ticker: 'CDR',
    sellDate: '2026-03-10',
    sellPrice: 268.40,
    currency: 'PLN',
    totalQuantity: 45,
    totalProfitLoss: 3_226.50,
    weightedProfitLossPct: 38.16,
    trades: [
      { ticker: 'CDR', quantity: 20, buyDate: '2025-04-15', buyPrice: 172.30, sellDate: '2026-03-10', sellPrice: 268.40, currency: 'PLN', profitLoss: 1_922.00, profitLossPct: 55.77, holdingDays: 330 },
      { ticker: 'CDR', quantity: 15, buyDate: '2025-07-22', buyPrice: 198.50, sellDate: '2026-03-10', sellPrice: 268.40, currency: 'PLN', profitLoss: 1_048.50, profitLossPct: 35.21, holdingDays: 231 },
      { ticker: 'CDR', quantity: 10, buyDate: '2025-11-03', buyPrice: 242.80, sellDate: '2026-03-10', sellPrice: 268.40, currency: 'PLN', profitLoss: 256.00, profitLossPct: 10.54, holdingDays: 128 },
    ],
  },
  {
    ticker: 'AAPL',
    sellDate: '2026-02-18',
    sellPrice: 228.90,
    currency: 'USD',
    totalQuantity: 12,
    totalProfitLoss: 625.20,
    weightedProfitLossPct: 29.50,
    trades: [
      { ticker: 'AAPL', quantity: 5, buyDate: '2025-03-10', buyPrice: 168.40, sellDate: '2026-02-18', sellPrice: 228.90, currency: 'USD', profitLoss: 302.50, profitLossPct: 35.93, holdingDays: 345 },
      { ticker: 'AAPL', quantity: 7, buyDate: '2025-06-05', buyPrice: 185.30, sellDate: '2026-02-18', sellPrice: 228.90, currency: 'USD', profitLoss: 305.20, profitLossPct: 23.53, holdingDays: 258 },
    ],
  },
  {
    ticker: 'PKN',
    sellDate: '2026-01-22',
    sellPrice: 56.80,
    currency: 'PLN',
    totalQuantity: 80,
    totalProfitLoss: -424.00,
    weightedProfitLossPct: -8.53,
    trades: [
      { ticker: 'PKN', quantity: 80, buyDate: '2025-09-05', buyPrice: 62.10, sellDate: '2026-01-22', sellPrice: 56.80, currency: 'PLN', profitLoss: -424.00, profitLossPct: -8.53, holdingDays: 139 },
    ],
  },
  {
    ticker: 'VWCE',
    sellDate: '2026-03-25',
    sellPrice: 124.60,
    currency: 'EUR',
    totalQuantity: 30,
    totalProfitLoss: 482.40,
    weightedProfitLossPct: 14.83,
    trades: [
      { ticker: 'VWCE', quantity: 15, buyDate: '2025-04-22', buyPrice: 108.40, sellDate: '2026-03-25', sellPrice: 124.60, currency: 'EUR', profitLoss: 243.00, profitLossPct: 14.94, holdingDays: 337 },
      { ticker: 'VWCE', quantity: 15, buyDate: '2025-08-14', buyPrice: 105.00, sellDate: '2026-03-25', sellPrice: 124.60, currency: 'EUR', profitLoss: 294.00, profitLossPct: 18.67, holdingDays: 223 },
    ],
  },
];

// ── Dividends ──────────────────────────────────────────────────────────────
export const DEMO_DIVIDEND_TOTAL = 4_230.50;

export const DEMO_DIVIDEND_YEARLY = [
  { year: '2024', amount: 1_120 },
  { year: '2025', amount: 2_340 },
  { year: '2026', amount: 770.50 },
];

export const DEMO_DIVIDENDS = [
  { date: '2026-03-15', ticker: 'PKO', amount: 310.00, currency: 'PLN' },
  { date: '2026-02-28', ticker: 'AAPL', amount: 142.50, currency: 'USD' },
  { date: '2026-01-10', ticker: 'MSFT', amount: 98.40, currency: 'USD' },
  { date: '2025-12-18', ticker: 'CDR', amount: 225.00, currency: 'PLN' },
  { date: '2025-09-20', ticker: 'PKO', amount: 620.00, currency: 'PLN' },
  { date: '2025-06-15', ticker: 'AAPL', amount: 135.00, currency: 'USD' },
  { date: '2025-03-22', ticker: 'ASML', amount: 87.60, currency: 'EUR' },
];

// ── Cash Flow (deposits vs portfolio value) ────────────────────────────────
export const DEMO_CASHFLOW_CHART = [
  { date: '2024-01-15', netCashFlow: 10_000, portfolioValue: 10_000 },
  { date: '2024-03-01', netCashFlow: 10_000, portfolioValue: 10_420 },
  { date: '2024-04-10', netCashFlow: 20_000, portfolioValue: 21_150 },
  { date: '2024-06-01', netCashFlow: 20_000, portfolioValue: 22_800 },
  { date: '2024-07-15', netCashFlow: 30_000, portfolioValue: 33_400 },
  { date: '2024-09-01', netCashFlow: 30_000, portfolioValue: 35_200 },
  { date: '2024-10-20', netCashFlow: 40_000, portfolioValue: 44_100 },
  { date: '2024-12-01', netCashFlow: 40_000, portfolioValue: 46_300 },
  { date: '2025-01-10', netCashFlow: 50_000, portfolioValue: 54_800 },
  { date: '2025-03-01', netCashFlow: 50_000, portfolioValue: 56_200 },
  { date: '2025-05-15', netCashFlow: 55_000, portfolioValue: 62_400 },
  { date: '2025-07-01', netCashFlow: 55_000, portfolioValue: 58_900 },
  { date: '2025-09-01', netCashFlow: 61_420, portfolioValue: 65_100 },
  { date: '2025-11-01', netCashFlow: 61_420, portfolioValue: 71_800 },
  { date: '2026-01-01', netCashFlow: 61_420, portfolioValue: 75_200 },
  { date: '2026-03-01', netCashFlow: 61_420, portfolioValue: 82_353 },
];

export const DEMO_CASHFLOW_SUMMARY = {
  totalDeposits: 65_420.00,
  totalWithdrawals: 4_000.00,
  net: 61_420.00,
};

export const DEMO_CASHFLOW_ENTRIES = [
  { date: '2025-09-01', type: 'deposit' as const, amount: 6_420 },
  { date: '2025-05-15', type: 'deposit' as const, amount: 5_000 },
  { date: '2025-01-10', type: 'deposit' as const, amount: 10_000 },
  { date: '2024-10-20', type: 'deposit' as const, amount: 10_000 },
  { date: '2024-07-15', type: 'deposit' as const, amount: 10_000 },
  { date: '2024-07-01', type: 'withdrawal' as const, amount: 4_000 },
  { date: '2024-04-10', type: 'deposit' as const, amount: 10_000 },
  { date: '2024-01-15', type: 'deposit' as const, amount: 10_000 },
];
