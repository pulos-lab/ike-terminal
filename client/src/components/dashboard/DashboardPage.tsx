import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info, Settings } from 'lucide-react';
import { api } from '@/lib/api-client';
import { filterAndRebaseHistory, getPresetStartDate } from '@/lib/returns';
import { usePortfolio } from '@/lib/portfolio-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { PortfolioChart } from './PortfolioChart';
import { PerformanceStats } from './PerformanceStats';
import { HeroKPI } from './HeroKPI';
import { MonthlyReturnsChart } from './MonthlyReturnsChart';
import { ShareDialog } from './ShareDialog';
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

function ChartLegend({
  portfolioPct,
  benchmarkPct,
  benchmarkLabel,
}: {
  portfolioPct: number;
  benchmarkPct: number | null;
  benchmarkLabel: string;
}) {
  const pfmt = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  return (
    <div className="flex items-center gap-3 text-xs tabular-nums">
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-3 h-0.5 rounded-full bg-primary" />
        <span className="text-muted-foreground">{pfmt(portfolioPct)} portfel</span>
      </span>
      {benchmarkPct !== null && (
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-3 h-[2px]"
            style={{
              background:
                'repeating-linear-gradient(90deg, currentColor 0 3px, transparent 3px 6px)',
              color: 'var(--muted-foreground)',
            }}
          />
          <span className="text-muted-foreground">
            {pfmt(benchmarkPct)} {benchmarkLabel}
          </span>
        </span>
      )}
    </div>
  );
}

export function DashboardPage() {
  const { activeName } = usePortfolio();
  const [benchmark, setBenchmark] = useState('sp500');
  const [timeRange, setTimeRange] = useState<string>('ALL');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [chartMode, setChartMode] = useState<'mwr' | 'twr'>('mwr');

  const isCustom = timeRange === 'CUSTOM';

  const startDate = isCustom ? customFrom || undefined : getPresetStartDate(timeRange);
  const endDate = isCustom ? customTo || undefined : undefined;

  // Always fetch full history (server ignores startDate), cache per benchmark only
  const { data, isLoading } = useQuery({
    queryKey: ['portfolio', 'history', benchmark],
    queryFn: () => api.postHistory({ benchmark }),
    staleTime: 60 * 60 * 1000,
  });

  // Filter by date range and rebase so first visible point = 0%
  const filteredHistory = useMemo(
    () => filterAndRebaseHistory(data?.history ?? [], startDate, endDate),
    [data, startDate, endDate],
  );

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

  const benchmarkLabel = BENCHMARKS.find((b) => b.value === benchmark)?.label || '';
  const showBenchmark = benchmark !== 'none';

  return (
    <div className="space-y-4">
      {/* Mobile-only hero KPI (desktop uses MetricsBar) */}
      <div className="md:hidden">
        <HeroKPI history={filteredHistory} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <TooltipProvider>
            {/* Tytuł + legend (mobile: pełna szerokość; desktop: tytuł-lewo, range-prawo) */}
            <div className="flex flex-col md:flex-row md:flex-wrap md:items-center md:justify-between gap-x-4 gap-y-2">
              <div className="flex items-center justify-between gap-2 md:flex-1 md:min-w-0 md:justify-start">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 min-w-0">
                  <CardTitle className="text-sm font-semibold">
                    {activeName}
                    {showBenchmark ? ` vs ${benchmarkLabel}` : ''}
                  </CardTitle>
                  {filteredHistory.length > 1 && (
                    <ChartLegend
                      portfolioPct={
                        chartMode === 'twr'
                          ? filteredHistory[filteredHistory.length - 1].twrPct
                          : filteredHistory[filteredHistory.length - 1].returnPct
                      }
                      benchmarkPct={
                        showBenchmark
                          ? chartMode === 'twr'
                            ? filteredHistory[filteredHistory.length - 1].benchmarkTwrPct
                            : filteredHistory[filteredHistory.length - 1].benchmarkReturnPct
                          : null
                      }
                      benchmarkLabel={benchmarkLabel}
                    />
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {/* Udostępnij portfel — oba breakpointy */}
                  <ShareDialog currentBenchmark={benchmark} />

                  {/* Mobile-only: ⚙ Ustawienia (MWR/TWR + benchmark) */}
                  <Sheet>
                    <SheetTrigger asChild>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="md:hidden text-muted-foreground shrink-0"
                        aria-label="Ustawienia wykresu"
                      >
                        <Settings className="h-4 w-4" />
                      </Button>
                    </SheetTrigger>
                    <SheetContent side="bottom" className="rounded-t-xl max-h-[85vh] overflow-auto">
                      <SheetHeader className="pb-2">
                        <SheetTitle>Ustawienia wykresu</SheetTitle>
                      </SheetHeader>
                      <div className="flex flex-col gap-4 px-4 pb-6">
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                            Sposób liczenia
                          </span>
                          <div className="grid grid-cols-2 rounded-md border overflow-hidden">
                            <Button
                              size="sm"
                              variant={chartMode === 'mwr' ? 'secondary' : 'ghost'}
                              className="h-9 text-xs rounded-none"
                              onClick={() => setChartMode('mwr')}
                            >
                              MWR
                            </Button>
                            <Button
                              size="sm"
                              variant={chartMode === 'twr' ? 'secondary' : 'ghost'}
                              className="h-9 text-xs rounded-none border-l"
                              onClick={() => setChartMode('twr')}
                            >
                              TWR
                            </Button>
                          </div>
                          <p className="text-[11px] text-muted-foreground">
                            {chartMode === 'mwr'
                              ? 'Money-Weighted Return — uwzględnia wpłaty/wypłaty, pokazuje realną stopę zwrotu inwestora.'
                              : 'Time-Weighted Return — eliminuje wpływ wpłat/wypłat, pokazuje czystą efektywność strategii.'}
                          </p>
                        </div>

                        <div className="flex flex-col gap-1.5">
                          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                            Benchmark
                          </span>
                          <Select value={benchmark} onValueChange={setBenchmark}>
                            <SelectTrigger className="h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {BENCHMARKS.map((b) => (
                                <SelectItem key={b.value} value={b.value}>
                                  {b.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-[11px] text-muted-foreground">
                            Porównanie z indeksem — pokazuje jak poradziłby sobie portfel indeksowy
                            przy tych samych wpłatach/wypłatach (DCA).
                          </p>
                        </div>
                      </div>
                    </SheetContent>
                  </Sheet>
                </div>
              </div>

              {/* Zakres czasu — desktop obok tytułu, mobile w osobnym rzędzie z scroll */}
              <div className="flex items-center gap-1 overflow-x-auto md:overflow-visible -mx-6 px-6 md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                {PRESET_RANGES.map((r) => (
                  <button
                    key={r}
                    className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                      timeRange === r
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => selectPreset(r)}
                  >
                    {r}
                  </button>
                ))}
                <button
                  className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                    isCustom
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  onClick={selectCustom}
                >
                  Custom
                </button>
              </div>
            </div>

            {/* Mobile-only: custom date inputs poniżej range gdy isCustom */}
            {isCustom && (
              <div className="md:hidden flex items-center gap-1.5 mt-2">
                <Input
                  type="date"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  className="h-7 text-xs flex-1"
                />
                <span className="text-xs text-muted-foreground">—</span>
                <Input
                  type="date"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  className="h-7 text-xs flex-1"
                />
              </div>
            )}

            {/* MWR/TWR + benchmark + info — DESKTOP ONLY */}
            <div className="hidden md:flex flex-wrap items-center gap-2 mt-2">
              <div className="flex items-center bg-muted rounded-md p-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                        chartMode === 'mwr'
                          ? 'bg-background text-foreground'
                          : 'text-muted-foreground'
                      }`}
                      onClick={() => setChartMode('mwr')}
                    >
                      MWR
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-xs">
                    Money-Weighted Return — uwzględnia wpłaty/wypłaty, pokazuje realną stopę zwrotu
                    inwestora
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                        chartMode === 'twr'
                          ? 'bg-background text-foreground'
                          : 'text-muted-foreground'
                      }`}
                      onClick={() => setChartMode('twr')}
                    >
                      TWR
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[260px] text-xs">
                    Time-Weighted Return — eliminuje wpływ wpłat/wypłat, pokazuje czystą efektywność
                    strategii
                  </TooltipContent>
                </Tooltip>
              </div>
              <Select value={benchmark} onValueChange={setBenchmark}>
                <SelectTrigger className="h-7 text-xs w-32 bg-muted border-transparent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BENCHMARKS.map((b) => (
                    <SelectItem key={b.value} value={b.value}>
                      {b.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 cursor-help text-muted-foreground/60 hover:text-muted-foreground transition-colors" />
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px] text-xs">
                  Porównanie z indeksem — pokazuje jak poradziłby sobie portfel indeksowy przy tych
                  samych wpłatach/wypłatach (strategia DCA)
                </TooltipContent>
              </Tooltip>
              {isCustom && (
                <div className="flex items-center gap-1.5 ml-auto">
                  <Input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="h-7 w-[130px] text-xs"
                  />
                  <span className="text-xs text-muted-foreground">—</span>
                  <Input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="h-7 w-[130px] text-xs"
                  />
                </div>
              )}
            </div>
          </TooltipProvider>
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
        <PerformanceStats
          data={filteredHistory}
          benchmarkLabel={benchmarkLabel}
          showBenchmark={showBenchmark}
        />
      )}

      {!isLoading && data?.history && data.history.length > 1 && (
        <MonthlyReturnsChart
          history={data.history}
          benchmarkLabel={benchmarkLabel}
          showBenchmark={showBenchmark}
        />
      )}
    </div>
  );
}
