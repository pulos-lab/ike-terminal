import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { plColor } from '@/components/ui/pl-badge';
import { formatPLN, formatPercent } from '@/lib/formatters';
import { TrendingUp, TrendingDown, DollarSign, Target } from 'lucide-react';

export function MetricsBar() {
  const { data } = useQuery({
    queryKey: QUERY_KEYS.metrics,
    queryFn: api.getMetrics,
  });

  if (!data) return (
    <div className="hidden md:flex border-b px-4 md:px-6 py-3 gap-6 text-sm animate-pulse">
      <div className="h-4 w-32 bg-muted rounded" />
      <div className="h-4 w-32 bg-muted rounded" />
      <div className="h-4 w-24 bg-muted rounded" />
    </div>
  );

  return (
    <div className="hidden md:flex border-b px-4 md:px-6 py-3 flex-wrap items-center gap-x-8 gap-y-1 text-sm">
      <div className="flex items-center gap-2">
        <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Wartość
        </span>
        <span className="font-semibold tabular-nums">{formatPLN(data.currentValue)}</span>
      </div>
      <div className="flex items-center gap-2">
        <Target className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Wpłaty
        </span>
        <span className="font-medium tabular-nums">{formatPLN(data.totalInvested)}</span>
      </div>
      <div className="flex items-center gap-2">
        {data.totalReturn >= 0 ? (
          <TrendingUp className="h-3.5 w-3.5 text-gain" />
        ) : (
          <TrendingDown className="h-3.5 w-3.5 text-loss" />
        )}
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          Zysk
        </span>
        <span className={`font-semibold tabular-nums ${plColor(data.totalReturn)}`}>
          {formatPLN(data.totalReturn)} ({formatPercent(data.totalReturnPct)})
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          XIRR
        </span>
        <span className={`font-semibold tabular-nums ${plColor(data.xirr)}`}>
          {formatPercent(data.xirr)}
        </span>
      </div>
    </div>
  );
}
