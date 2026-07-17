import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Calendar, Info, Settings } from 'lucide-react';
import { api } from '@/lib/api-client';
import { filterAndRebaseHistory, getPresetStartDate } from '@/lib/returns';
import { usePortfolio } from '@/lib/portfolio-context';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldError } from '@/components/ui/field-error';
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
import { DrawdownChart } from './DrawdownChart';
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
    <div className="pointer-events-none absolute left-2 top-2 z-10 flex items-center gap-3 rounded-md border bg-background/80 px-2.5 py-1 text-xs tabular-nums">
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-3 h-0.5 rounded-full bg-primary" />
        <span className="text-muted-foreground">portfel</span>
        <span className="font-medium text-primary">{pfmt(portfolioPct)}</span>
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
          <span className="text-muted-foreground">{benchmarkLabel}</span>
          <span className="font-medium">{pfmt(benchmarkPct)}</span>
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

  // Odwrócony zakres (koniec przed początkiem) dawałby pusty wykres bez wyjaśnienia —
  // pokazujemy komunikat i nie filtrujemy do czasu poprawienia dat.
  const customRangeError =
    isCustom && customFrom && customTo && customTo < customFrom
      ? 'Data końcowa przed początkową'
      : undefined;

  const startDate = isCustom
    ? customRangeError
      ? undefined
      : customFrom || undefined
    : getPresetStartDate(timeRange);
  const endDate = isCustom && !customRangeError ? customTo || undefined : undefined;

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

      <Card className="gap-3">
        <CardHeader className="gap-0 pb-0">
          <TooltipProvider>
            {/* Toolbar: tytuł+benchmark (lewo) | MWR/TWR + zakres + akcje (desktop: jedna linia) */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b pb-2.5">
              {/* Co oglądam: tytuł z wbudowanym wyborem benchmarku */}
              <div className="flex min-w-0 items-center gap-1.5">
                <CardTitle className="truncate text-sm font-semibold">{activeName} vs</CardTitle>
                <Select value={benchmark} onValueChange={setBenchmark}>
                  <SelectTrigger
                    className={`h-auto gap-1 rounded-none border-0 border-b border-dotted border-muted-foreground/40 bg-transparent p-0 pb-0.5 text-sm font-semibold whitespace-nowrap shadow-none transition-colors hover:border-muted-foreground focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent data-[size=default]:h-auto [&_svg:not([class*='size-'])]:size-3.5 ${
                      showBenchmark ? '' : 'text-muted-foreground'
                    }`}
                  >
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
                    <Info className="hidden h-3.5 w-3.5 cursor-help text-muted-foreground/60 transition-colors hover:text-muted-foreground md:block" />
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[280px] text-xs">
                    Porównanie z indeksem — pokazuje jak poradziłby sobie portfel indeksowy przy
                    tych samych wpłatach/wypłatach (strategia DCA)
                  </TooltipContent>
                </Tooltip>
              </div>

              {/* Custom (desktop): pola dat inline po lewej — presety zostają klikalne */}
              {isCustom && (
                <div className="hidden md:block">
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="date"
                      value={customFrom}
                      onChange={(e) => setCustomFrom(e.target.value)}
                      className="h-7 w-[130px] text-xs"
                      aria-invalid={!!customRangeError}
                    />
                    <span className="text-xs text-muted-foreground">—</span>
                    <Input
                      type="date"
                      value={customTo}
                      onChange={(e) => setCustomTo(e.target.value)}
                      className="h-7 w-[130px] text-xs"
                      aria-invalid={!!customRangeError}
                    />
                  </div>
                  <FieldError error={customRangeError} />
                </div>
              )}

              {/* Akcje: share + mobilne ustawienia (desktop: koniec paska) */}
              <div className="ml-auto flex shrink-0 items-center gap-1 md:order-6 md:ml-0">
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

              {/* Sposób liczenia: MWR/TWR — desktop (mobile w arkuszu ustawień) */}
              <div className="hidden items-center rounded-md bg-muted p-0.5 md:order-3 md:ml-auto md:flex">
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

              {/* Zakres czasu — mobile: rząd ze scrollem; desktop: segment w pasku */}
              <div className="order-4 -mx-6 flex w-full items-center gap-1 overflow-x-auto px-6 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] md:mx-0 md:w-auto md:gap-0.5 md:overflow-visible md:rounded-md md:bg-muted md:p-0.5 md:px-0.5">
                {PRESET_RANGES.map((r) => (
                  <button
                    key={r}
                    className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors md:py-0.5 ${
                      timeRange === r
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => selectPreset(r)}
                  >
                    {r}
                  </button>
                ))}
                <span className="mx-0.5 hidden h-3.5 w-px bg-border md:block" />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors md:py-0.5 ${
                        isCustom
                          ? 'bg-primary/15 text-primary'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      onClick={selectCustom}
                      aria-label="Własny zakres dat"
                    >
                      <span className="md:hidden">Custom</span>
                      <Calendar className="hidden h-3.5 w-3.5 md:block" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">Własny zakres dat</TooltipContent>
                </Tooltip>
              </div>

              {/* Separator przed akcjami — desktop */}
              <span className="hidden h-4 w-px bg-border md:order-5 md:block" />
            </div>

            {/* Custom (mobile): pola dat pod paskiem */}
            {isCustom && (
              <div className="mt-2 md:hidden">
                <div className="flex items-center gap-1.5">
                  <Input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="h-7 flex-1 text-xs"
                    aria-invalid={!!customRangeError}
                  />
                  <span className="text-xs text-muted-foreground">—</span>
                  <Input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className="h-7 flex-1 text-xs"
                    aria-invalid={!!customRangeError}
                  />
                </div>
                <FieldError error={customRangeError} />
              </div>
            )}
          </TooltipProvider>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSpinner />
          ) : filteredHistory.length ? (
            <div className="relative">
              {/* Legenda na płótnie wykresu (jak w TradingView) — nie blokuje crosshaira */}
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
              <PortfolioChart
                data={filteredHistory}
                benchmarkLabel={benchmarkLabel}
                mode={chartMode}
                showBenchmark={showBenchmark}
              />
            </div>
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

      {!isLoading && filteredHistory.length > 1 && (
        <DrawdownChart
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
