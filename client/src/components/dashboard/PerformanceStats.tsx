import { useMemo } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPercent, formatNumber } from '@/lib/formatters';
import { cn } from '@/lib/utils';

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
  showBenchmark?: boolean;
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


export function PerformanceStats({ data, benchmarkLabel, showBenchmark = true }: Props) {
  const metrics = useMemo(() => computeMetrics(data), [data]);

  if (!metrics) {
    return null;
  }

  const returnColor = (v: number) => v > 0 ? 'green' as const : v < 0 ? 'red' as const : 'default' as const;
  const hasBenchmark = showBenchmark && metrics.benchmarkReturn !== 0;

  return (
    <TooltipProvider>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
        <StatTile
          label="Stopa zwrotu"
          value={formatPercent(metrics.totalReturn)}
          color={returnColor(metrics.totalReturn)}
        />
        <StatTile
          label={`vs ${benchmarkLabel || 'benchmark'}`}
          value={hasBenchmark ? formatPercent(metrics.benchmarkReturn) : '—'}
          color={hasBenchmark ? returnColor(metrics.benchmarkReturn) : 'default'}
          disabled={!hasBenchmark}
        />
        <StatTile
          label="CAGR"
          value={formatPercent(metrics.cagr)}
          color={returnColor(metrics.cagr)}
          tooltip="Skumulowana roczna stopa wzrostu. Pokazuje, o ile % rocznie rósł portfel przy założeniu równomiernego wzrostu przez cały okres."
        />
        <StatTile
          label="Volatility"
          value={`${metrics.volatility.toFixed(2)}%`}
          tooltip="Zmienność — odchylenie standardowe rocznych zwrotów. Im wyższa, tym większe wahania wartości portfela i ryzyko."
        />
        <StatTile
          label="Sharpe Ratio"
          value={formatNumber(metrics.sharpeRatio)}
          subtext="rf = 5%"
          tooltip="Zwrot ponad stopę wolną od ryzyka (rf = 5%) na jednostkę zmienności. Wartość >1 dobra, >2 bardzo dobra. Uwzględnia wszystkie wahania — zarówno wzrosty, jak i spadki."
        />
        <StatTile
          label="Sortino Ratio"
          value={formatNumber(metrics.sortinoRatio)}
          tooltip="Miara efektywności inwestycji oparta na stopie zwrotu skorygowanej o ryzyko spadkowe (downside deviation). W odróżnieniu od wskaźnika Sharpe, uwzględnia wyłącznie zmienność ujemnych odchyleń od docelowej stopy zwrotu, dokładniej odzwierciedlając realne ryzyko straty. Wartości > 1 uznaje się za dobre, > 2 — za bardzo dobre."
        />
        <StatTile
          label="Max Drawdown"
          value={formatPercent(-metrics.maxDrawdown)}
          color="red"
        />
        <StatTile
          label="Max DD Duration"
          value={`${metrics.maxDrawdownDuration} dni`}
        />
        <StatTile
          label="Calmar Ratio"
          value={formatNumber(metrics.calmarRatio)}
          tooltip="Roczny zwrot podzielony przez maksymalne obsunięcie (Max Drawdown). Mierzy, ile zysku portfel generuje w stosunku do najgorszego możliwego scenariusza straty."
        />
        <StatTile
          label="Najlepszy dzień"
          value={formatPercent(metrics.bestDay)}
          color="green"
        />
        <StatTile
          label="Najgorszy dzień"
          value={formatPercent(metrics.worstDay)}
          color="red"
        />
        <StatTile
          label="Win Rate"
          value={`${formatNumber(metrics.winRate, 1)}%`}
        />
      </div>
    </TooltipProvider>
  );
}

interface StatTileProps {
  label: string;
  value: string;
  color?: 'default' | 'green' | 'red';
  tooltip?: string;
  subtext?: string;
  disabled?: boolean;
}

function StatTile({ label, value, color = 'default', tooltip, subtext, disabled }: StatTileProps) {
  const colorClass =
    color === 'green' ? 'text-green-500' : color === 'red' ? 'text-red-500' : 'text-foreground';

  const content = (
    <div
      className={cn(
        'rounded-xl bg-card border border-border px-3 py-2.5',
        disabled && 'opacity-50',
      )}
    >
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 flex items-center gap-1">
        {label}
        {tooltip && <Info className="h-3 w-3 text-muted-foreground/60" />}
      </p>
      <p className={cn('text-base font-bold tabular-nums tracking-tight', colorClass)}>
        {value}
      </p>
      {subtext && (
        <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{subtext}</p>
      )}
    </div>
  );

  if (!tooltip) return content;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent className="max-w-[320px] text-xs leading-relaxed">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
