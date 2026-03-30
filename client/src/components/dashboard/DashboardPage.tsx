import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { PortfolioChart } from './PortfolioChart';
import { PerformanceStats } from './PerformanceStats';
import { LoadingSpinner } from '@/components/ui/loading-spinner';

const BENCHMARKS = [
  { value: 'none', label: 'Brak' },
  { value: 'sp500', label: 'S&P 500' },
  { value: 'nasdaq', label: 'NASDAQ' },
  { value: 'wig', label: 'WIG' },
  { value: 'wig20', label: 'WIG20' },
  { value: 'mwig40', label: 'mWIG40' },
  { value: 'swig80', label: 'sWIG80' },
];

const PRESET_RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', 'ALL'] as const;

function getPresetStartDate(range: string): string | undefined {
  const now = new Date();
  if (range === 'ALL') return undefined;
  if (range === 'YTD') return `${now.getFullYear()}-01-01`;
  const days: Record<string, number> = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, '3Y': 1095 };
  const d = new Date(now.getTime() - (days[range] || 0) * 86400000);
  return d.toISOString().split('T')[0];
}

export function DashboardPage() {
  const [benchmark, setBenchmark] = useState('sp500');
  const [timeRange, setTimeRange] = useState<string>('ALL');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [chartMode, setChartMode] = useState<'mwr' | 'twr'>('mwr');

  const isCustom = timeRange === 'CUSTOM';

  const startDate = isCustom ? (customFrom || undefined) : getPresetStartDate(timeRange);
  const endDate = isCustom ? (customTo || undefined) : undefined;

  // Always fetch full history (server ignores startDate), cache per benchmark only
  const { data, isLoading } = useQuery({
    queryKey: ['portfolio', 'history', benchmark],
    queryFn: () => api.postHistory({ benchmark }),
    staleTime: 60 * 60 * 1000,
  });

  // Filter by date range and rebase so first visible point = 0%
  const filteredHistory = useMemo(() => {
    if (!data?.history?.length) return [];
    const history = data.history;

    // Filter to requested date range
    let filtered = history;
    if (startDate) {
      filtered = filtered.filter((p: any) => p.date >= startDate);
    }
    if (endDate) {
      filtered = filtered.filter((p: any) => p.date <= endDate);
    }

    if (!filtered.length) return [];
    if (!startDate && !endDate) return filtered; // ALL — no rebase needed

    // Rebase: subtract first point's return so chart starts at 0%
    const baseReturn = filtered[0].returnPct;
    const baseBenchReturn = filtered[0].benchmarkReturnPct;
    const baseTwr = filtered[0].twrPct;
    const baseBenchTwr = filtered[0].benchmarkTwrPct;

    return filtered.map((p: any) => ({
      ...p,
      returnPct: p.returnPct - baseReturn,
      benchmarkReturnPct: p.benchmarkReturnPct - baseBenchReturn,
      twrPct: p.twrPct - baseTwr,
      benchmarkTwrPct: p.benchmarkTwrPct - baseBenchTwr,
    }));
  }, [data, startDate, endDate]);

  function selectPreset(range: string) {
    setTimeRange(range);
  }

  function selectCustom() {
    setTimeRange('CUSTOM');
    if (!customFrom && data?.history?.length) {
      setCustomFrom(data.history[0].date);
    }
    if (!customTo) {
      setCustomTo(new Date().toISOString().split('T')[0]);
    }
  }

  const benchmarkLabel = BENCHMARKS.find(b => b.value === benchmark)?.label || '';
  const showBenchmark = benchmark !== 'none';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg border p-0.5">
            {PRESET_RANGES.map((r) => (
              <Button
                key={r}
                variant={timeRange === r ? 'default' : 'ghost'}
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => selectPreset(r)}
              >
                {r}
              </Button>
            ))}
            <Button
              variant={isCustom ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={selectCustom}
            >
              Custom
            </Button>
          </div>
          {isCustom && (
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                className="h-8 w-[140px] text-xs"
              />
              <span className="text-xs text-muted-foreground">—</span>
              <Input
                type="date"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                className="h-8 w-[140px] text-xs"
              />
            </div>
          )}
          <TooltipProvider>
            <div className="flex gap-1 rounded-lg border p-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={chartMode === 'mwr' ? 'default' : 'ghost'}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setChartMode('mwr')}
                  >
                    MWR
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-xs">
                  Money-Weighted Return — uwzględnia wpłaty/wypłaty, pokazuje realną stopę zwrotu inwestora
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={chartMode === 'twr' ? 'default' : 'ghost'}
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setChartMode('twr')}
                  >
                    TWR
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-[260px] text-xs">
                  Time-Weighted Return — eliminuje wpływ wpłat/wypłat, pokazuje czystą efektywność strategii
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-1">
              <Select value={benchmark} onValueChange={setBenchmark}>
                <SelectTrigger className="w-36 h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BENCHMARKS.map((b) => (
                    <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-4 w-4 cursor-help text-muted-foreground/60 hover:text-muted-foreground transition-colors" />
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px] text-xs">
                  Porównanie z indeksem — pokazuje jak poradziłby sobie portfel indeksowy przy tych samych wpłatach/wypłatach (strategia DCA)
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {chartMode === 'twr' ? 'TWR' : 'MWR'} portfela{showBenchmark ? ` vs ${benchmarkLabel}` : ''}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSpinner />
          ) : filteredHistory.length ? (
            <PortfolioChart
              data={filteredHistory}
              benchmarkLabel={benchmarkLabel}
              mode={chartMode}
              showBenchmark={showBenchmark}
            />
          ) : (
            <div className="flex items-center justify-center h-80 text-muted-foreground">
              Brak danych. Zaimportuj historię transakcji lub dodaj ręcznie transakcje.
            </div>
          )}
        </CardContent>
      </Card>

      {!isLoading && filteredHistory.length > 1 && (
        <PerformanceStats data={filteredHistory} benchmarkLabel={benchmarkLabel} showBenchmark={showBenchmark} />
      )}
    </div>
  );
}
