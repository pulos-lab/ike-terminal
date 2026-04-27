import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { formatCurrency, formatPercent, formatNumber } from '@/lib/formatters';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface HeroKPIProps {
  history?: Array<{ date: string; returnPct: number }>;
}

export function HeroKPI({ history }: HeroKPIProps) {
  const { data } = useQuery({
    queryKey: QUERY_KEYS.metrics,
    queryFn: api.getMetrics,
  });

  if (!data) {
    return (
      <div className="relative overflow-hidden rounded-2xl bg-card border border-border p-5 animate-pulse">
        <div className="h-3 w-32 bg-muted rounded mb-3" />
        <div className="h-9 w-48 bg-muted rounded mb-2" />
        <div className="h-4 w-40 bg-muted rounded" />
      </div>
    );
  }

  const isPositive = data.totalReturn >= 0;
  const DeltaIcon = isPositive ? TrendingUp : TrendingDown;

  // Simple sparkline from history returnPct values (normalized)
  const sparkPath = buildSparkPath(history ?? []);

  return (
    <div className="relative overflow-hidden rounded-2xl bg-card border border-border p-5">
      {/* Amber radial halo */}
      <div
        className="absolute -top-1/2 -right-[20%] w-[280px] h-[280px] pointer-events-none"
        style={{
          background: 'radial-gradient(circle, rgba(245,158,11,0.18) 0%, transparent 65%)',
        }}
      />

      <div className="relative">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          Wartość portfela · dziś
        </p>
        <p className="text-[2rem] font-bold tracking-tight leading-none tabular-nums mb-1.5">
          {formatNumber(data.currentValue, 0)}
          <span className="ml-2 text-base font-medium text-muted-foreground">
            {data.baseCurrency || 'PLN'}
          </span>
        </p>
        <div
          className={cn(
            'flex items-center gap-2 text-sm font-semibold',
            isPositive ? 'text-gain' : 'text-loss',
          )}
        >
          <DeltaIcon className="h-4 w-4" />
          <span className="tabular-nums">
            {formatCurrency(data.totalReturn, data.baseCurrency || 'PLN')}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="tabular-nums">{formatPercent(data.totalReturnPct)}</span>
        </div>
      </div>

      {sparkPath && (
        <svg
          className="absolute right-3 bottom-3 w-[110px] h-[42px] pointer-events-none"
          viewBox="0 0 110 42"
          preserveAspectRatio="none"
        >
          <defs>
            <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={`${sparkPath} L 110 42 L 0 42 Z`} fill="url(#sparkFill)" />
          <path
            d={sparkPath}
            fill="none"
            stroke="var(--primary)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      )}
    </div>
  );
}

function buildSparkPath(history: Array<{ date: string; returnPct: number }>): string | null {
  if (history.length < 2) return null;
  // Take last ~30 points for the sparkline
  const slice = history.slice(-30);
  const values = slice.map((d) => d.returnPct);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 110;
  const h = 42;
  const step = w / (slice.length - 1);
  return slice
    .map((d, i) => {
      const x = i * step;
      const y = h - ((d.returnPct - min) / range) * h;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}
