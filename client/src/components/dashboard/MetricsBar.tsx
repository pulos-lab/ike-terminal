import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { formatPLN, formatPercent } from '@/lib/formatters';
import { TrendingUp, TrendingDown, DollarSign, Target } from 'lucide-react';

export function MetricsBar() {
  const { data } = useQuery({
    queryKey: ['portfolio', 'metrics'],
    queryFn: api.getMetrics,
  });

  if (!data) return (
    <div className="border-b px-4 md:px-6 py-3 flex gap-6 text-sm animate-pulse">
      <div className="h-4 w-32 bg-muted rounded" />
      <div className="h-4 w-32 bg-muted rounded" />
      <div className="h-4 w-24 bg-muted rounded" />
    </div>
  );

  const isPositive = data.totalReturn >= 0;

  return (
    <div className="border-b px-4 md:px-6 py-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
      <div className="flex items-center gap-1.5">
        <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">Wartość:</span>
        <span className="font-semibold">{formatPLN(data.currentValue)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Target className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">Wpłaty:</span>
        <span className="font-medium">{formatPLN(data.totalInvested)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        {isPositive ? (
          <TrendingUp className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <TrendingDown className="h-3.5 w-3.5 text-red-500" />
        )}
        <span className="text-muted-foreground">Zysk:</span>
        <span className={`font-semibold ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
          {formatPLN(data.totalReturn)} ({formatPercent(data.totalReturnPct)})
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">XIRR:</span>
        <span className={`font-semibold ${data.xirr >= 0 ? 'text-green-500' : 'text-red-500'}`}>
          {formatPercent(data.xirr)}
        </span>
      </div>
    </div>
  );
}
