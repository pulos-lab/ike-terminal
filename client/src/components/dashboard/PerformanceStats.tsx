import { useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { formatPercent, formatNumber } from '@/lib/formatters';

interface ChartDataPoint {
  date: string;
  portfolioValue: number;
  returnPct: number;
  benchmarkValue: number;
  benchmarkReturnPct: number;
  investedCumulative: number;
}

interface Props {
  data: ChartDataPoint[];
  benchmarkLabel: string;
}

interface PerformanceMetrics {
  totalReturn: number;
  benchmarkReturn: number;
  cagr: number;
  volatility: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownDuration: number;
  bestDay: number;
  worstDay: number;
  winRate: number;
  calmarRatio: number;
  sortinoRatio: number;
}

const RISK_FREE_RATE = 0.05; // 5% annualized

function computeMetrics(data: ChartDataPoint[]): PerformanceMetrics | null {
  if (data.length < 2) return null;

  const first = data[0];
  const last = data[data.length - 1];

  // Total return (already rebased in filtered data)
  const totalReturn = last.returnPct - first.returnPct;
  const benchmarkReturn = last.benchmarkReturnPct - first.benchmarkReturnPct;

  // Daily returns from portfolio values, adjusted for cash flows (deposits)
  // On deposit days, portfolioValue jumps by the deposit amount — that's not
  // market return. We subtract the cash flow: (V_t - V_{t-1} - CF_t) / V_{t-1}
  const dailyReturns: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const prevValue = data[i - 1].portfolioValue;
    if (prevValue > 0) {
      const cashFlow = data[i].investedCumulative - data[i - 1].investedCumulative;
      dailyReturns.push(
        (data[i].portfolioValue - prevValue - cashFlow) / prevValue
      );
    }
  }

  if (dailyReturns.length === 0) return null;

  // Period in years (calendar days)
  const msPerDay = 86400000;
  const startDate = new Date(first.date);
  const endDate = new Date(last.date);
  const totalDays = Math.max((endDate.getTime() - startDate.getTime()) / msPerDay, 1);
  const years = totalDays / 365.25;

  // CAGR
  const totalGrowth = last.portfolioValue / first.portfolioValue;
  const cagr = years > 0 ? (Math.pow(totalGrowth, 1 / years) - 1) * 100 : 0;

  // Volatility (annualized std dev of daily returns)
  const tradingDaysPerYear = 252;
  const meanReturn = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / dailyReturns.length;
  const dailyVol = Math.sqrt(variance);
  const volatility = dailyVol * Math.sqrt(tradingDaysPerYear) * 100;

  // Sharpe Ratio
  const dailyRiskFree = RISK_FREE_RATE / tradingDaysPerYear;
  const excessReturns = dailyReturns.map(r => r - dailyRiskFree);
  const meanExcess = excessReturns.reduce((s, r) => s + r, 0) / excessReturns.length;
  const sharpeRatio = dailyVol > 0 ? (meanExcess / dailyVol) * Math.sqrt(tradingDaysPerYear) : 0;

  // Sortino Ratio (uses only downside deviation)
  const downsideReturns = excessReturns.filter(r => r < 0);
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((s, r) => s + r ** 2, 0) / dailyReturns.length
    : 0;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortinoRatio = downsideDev > 0 ? (meanExcess / downsideDev) * Math.sqrt(tradingDaysPerYear) : 0;

  // Max Drawdown & Max Drawdown Duration
  let peak = data[0].portfolioValue;
  let maxDrawdown = 0;
  let maxDrawdownDuration = 0;
  let currentDrawdownStart = 0;

  for (let i = 0; i < data.length; i++) {
    const val = data[i].portfolioValue;
    if (val > peak) {
      peak = val;
      currentDrawdownStart = i;
    }
    const drawdown = (peak - val) / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
    if (drawdown > 0) {
      const duration = i - currentDrawdownStart;
      if (duration > maxDrawdownDuration) {
        maxDrawdownDuration = duration;
      }
    }
  }

  // Calmar Ratio (CAGR / Max Drawdown)
  const calmarRatio = maxDrawdown > 0 ? (cagr / 100) / maxDrawdown : 0;

  // Best / Worst Day
  const bestDay = Math.max(...dailyReturns) * 100;
  const worstDay = Math.min(...dailyReturns) * 100;

  // Win Rate
  const winDays = dailyReturns.filter(r => r > 0).length;
  const winRate = (winDays / dailyReturns.length) * 100;

  return {
    totalReturn,
    benchmarkReturn,
    cagr,
    volatility,
    sharpeRatio,
    maxDrawdown: maxDrawdown * 100,
    maxDrawdownDuration,
    bestDay,
    worstDay,
    winRate,
    calmarRatio,
    sortinoRatio,
  };
}

function StatCard({ label, value, subtext, color }: {
  label: string;
  value: string;
  subtext?: string;
  color?: 'green' | 'red' | 'default';
}) {
  const colorClass = color === 'green'
    ? 'text-green-500'
    : color === 'red'
      ? 'text-red-500'
      : 'text-foreground';

  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold ${colorClass}`}>{value}</p>
      {subtext && <p className="text-xs text-muted-foreground">{subtext}</p>}
    </div>
  );
}

export function PerformanceStats({ data, benchmarkLabel }: Props) {
  const metrics = useMemo(() => computeMetrics(data), [data]);

  if (!metrics) {
    return null;
  }

  const returnColor = (v: number) => v > 0 ? 'green' as const : v < 0 ? 'red' as const : 'default' as const;

  return (
    <Card>
      <CardContent className="pt-4 pb-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-x-6 gap-y-3">
          <StatCard
            label="Stopa zwrotu"
            value={formatPercent(metrics.totalReturn)}
            color={returnColor(metrics.totalReturn)}
          />
          <StatCard
            label={`vs ${benchmarkLabel}`}
            value={formatPercent(metrics.benchmarkReturn)}
            color={returnColor(metrics.benchmarkReturn)}
          />
          <StatCard
            label="CAGR"
            value={formatPercent(metrics.cagr)}
            color={returnColor(metrics.cagr)}
          />
          <StatCard
            label="Volatility"
            value={`${metrics.volatility.toFixed(2)}%`}
          />
          <StatCard
            label="Sharpe Ratio"
            value={formatNumber(metrics.sharpeRatio)}
            subtext="rf = 5%"
          />
          <StatCard
            label="Sortino Ratio"
            value={formatNumber(metrics.sortinoRatio)}
          />
          <StatCard
            label="Max Drawdown"
            value={formatPercent(-metrics.maxDrawdown)}
            color="red"
          />
          <StatCard
            label="Max DD Duration"
            value={`${metrics.maxDrawdownDuration} dni`}
          />
          <StatCard
            label="Calmar Ratio"
            value={formatNumber(metrics.calmarRatio)}
          />
          <StatCard
            label="Najlepszy dzień"
            value={formatPercent(metrics.bestDay)}
            color="green"
          />
          <StatCard
            label="Najgorszy dzień"
            value={formatPercent(metrics.worstDay)}
            color="red"
          />
          <StatCard
            label="Win Rate"
            value={`${formatNumber(metrics.winRate, 1)}%`}
          />
        </div>
      </CardContent>
    </Card>
  );
}
