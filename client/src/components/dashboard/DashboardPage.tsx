import { useState, useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { AlertTriangle, Calendar, Info, RefreshCw, Settings, X } from 'lucide-react';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { BENCHMARKS } from '@/lib/benchmarks';
import { filterAndRebaseHistory, getPresetStartDate } from '@/lib/returns';
import { usePortfolio } from '@/lib/portfolio-context';
import { useLocalStorage } from '@/lib/use-local-storage';
import { useTheme } from '@/lib/use-theme';
import {
  compareSeriesColor,
  ACTIVE_SERIES_COLOR,
  COMBINED_SERIES_COLOR,
} from '@/lib/chart-palette';
import { COMBINED_SERIES_ID, type CompareSeries } from '@/lib/compare-series';
import { buildCombinedHistory, combinedBaseCurrencyConflict } from '@/lib/combined-series';
import { cn } from '@/lib/utils';
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
import { ComparisonChart, type BenchmarkLine } from './ComparisonChart';
import { ComparePortfolioPicker } from './ComparePortfolioPicker';
import { CombinedStatsSection, type CombinedPortfolioSummary } from './CombinedStatsSection';
import { PerformanceStats } from './PerformanceStats';
import { HeroKPI } from './HeroKPI';
import { DrawdownChart } from './DrawdownChart';
import { MonthlyReturnsChart } from './MonthlyReturnsChart';
import { ShareDialog } from './ShareDialog';
import { LoadingSpinner } from '@/components/ui/loading-spinner';

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
  const { activeName, activeId, portfolios } = usePortfolio();
  const { isDark } = useTheme();
  // Benchmark i tryb wykresu to trwałe preferencje (przeżywają zmianę zakładki
  // i reload); localStorage może zawierać wartość spoza obecnej listy — klamra
  // sprowadza ją do domyślnej zamiast wysyłać nieznany klucz do API.
  const [storedBenchmark, setBenchmark] = useLocalStorage('dashboard-benchmark', 'sp500');
  const benchmark = BENCHMARKS.some((b) => b.value === storedBenchmark) ? storedBenchmark : 'sp500';
  const [timeRange, setTimeRange] = useState<string>('ALL');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [storedChartMode, setChartMode] = useLocalStorage<'mwr' | 'twr'>(
    'dashboard-chart-mode',
    'mwr',
  );
  const chartMode = storedChartMode === 'twr' ? 'twr' : 'mwr';

  // Tryb porównania: id INNYCH portfeli dokładanych na wykres (aktywny zawsze w grze).
  const [compareIds, setCompareIds] = useState<string[]>([]);
  // Seria „Łącznie" (portfele policzone jak jeden rachunek) — domyślnie widoczna,
  // wyłączana z popovera porównania albo X-em na chipie.
  const [showCombined, setShowCombined] = useState(true);
  // Nowy aktywny mógł być wśród zaznaczonych „innych" — po przełączeniu czyścimy
  // wybór. Wzorzec „adjust state during render" zamiast setState w efekcie
  // (bez dodatkowego renderu z nieaktualnym zaznaczeniem).
  const [lastActiveId, setLastActiveId] = useState(activeId);
  if (lastActiveId !== activeId) {
    setLastActiveId(activeId);
    setCompareIds([]);
    setShowCombined(true);
  }
  // Ghost-id guard: portfel usunięty w międzyczasie znika z zaznaczenia.
  const validCompareIds = useMemo(
    () => compareIds.filter((id) => id !== activeId && portfolios.some((p) => p.id === id)),
    [compareIds, activeId, portfolios],
  );
  const compareMode = validCompareIds.length > 0;

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

  // N równoległych zapytań o historię INNYCH portfeli (aktywny zostaje na
  // zapytaniu wyżej — bez duplikacji). Klucz 'portfolios/compare-history'
  // celowo przeżywa resetPortfolioScopedQueries przy przełączeniu portfela.
  const compareResults = useQueries({
    queries: validCompareIds.map((id) => ({
      queryKey: QUERY_KEYS.compareHistory(id, benchmark),
      queryFn: () => api.postHistory({ benchmark }, id),
      staleTime: 15 * 60 * 1000,
    })),
  });

  // Stabilna tożsamość serii: useQueries zwraca nową tablicę co render, a
  // tożsamość `compareSeries` steruje pełną przebudową wykresu w ComparisonChart —
  // memo po dataUpdatedAt zapobiega przebudowie przy każdym re-renderze strony.
  const compareDataKey = compareResults.map((r) => r.dataUpdatedAt).join('|');
  const compareSelectionKey = validCompareIds.join('|');
  const compareSeries: CompareSeries[] = useMemo(
    () =>
      compareMode
        ? [
            {
              portfolioId: activeId,
              name: activeName,
              color: isDark ? ACTIVE_SERIES_COLOR.dark : ACTIVE_SERIES_COLOR.light,
              points: filteredHistory,
            },
            ...validCompareIds.map((id, i) => ({
              portfolioId: id,
              name: portfolios.find((p) => p.id === id)?.name ?? id,
              color: compareSeriesColor(i, isDark),
              points: filterAndRebaseHistory(
                compareResults[i]?.data?.history ?? [],
                startDate,
                endDate,
              ),
            })),
          ]
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      compareMode,
      compareSelectionKey,
      compareDataKey,
      filteredHistory,
      portfolios,
      activeId,
      activeName,
      isDark,
      startDate,
      endDate,
    ],
  );
  // Dane „Łącznie" wymagają KOMPLETU odpowiedzi (agregujemy kwoty, nie procenty)
  // i wspólnej waluty bazowej — sumowanie PLN z USD dawałoby bezsensowne liczby.
  const compareLoaded = compareMode && !!data && compareResults.every((r) => !!r.data);
  const currencyConflict = useMemo(
    () =>
      compareLoaded
        ? combinedBaseCurrencyConflict([
            data.baseCurrency,
            ...compareResults.map((r) => r.data!.baseCurrency),
          ])
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compareLoaded, compareDataKey, compareSelectionKey],
  );

  // Historia połączonych portfeli (jak jeden rachunek) liczona na PEŁNYCH
  // seriach — filtr zakresu i rebase dopiero na wyniku, jak przy innych seriach.
  const combinedHistory = useMemo(
    () =>
      compareLoaded && !currencyConflict
        ? buildCombinedHistory([data.history, ...compareResults.map((r) => r.data!.history)])
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compareLoaded, currencyConflict, compareDataKey, compareSelectionKey],
  );
  const combinedFiltered = useMemo(
    () => filterAndRebaseHistory(combinedHistory, startDate, endDate),
    [combinedHistory, startDate, endDate],
  );
  const combinedColor = isDark ? COMBINED_SERIES_COLOR.dark : COMBINED_SERIES_COLOR.light;
  const showCombinedSeries = showCombined && !currencyConflict && combinedFiltered.length >= 2;

  // Serie z <2 punktami po filtrze nie mają czego rysować (kafle pokażą "—").
  // „Łącznie" idzie WYŁĄCZNIE na wykres — kafle porównawcze i drawdown zostają
  // per portfel (agregat w rankingu „najlepszy" nie ma sensu); jego statystyki
  // żyją w CombinedStatsSection na dole strony.
  const chartSeries = useMemo(() => {
    const base = compareSeries.filter((s) => s.points.length >= 2);
    if (showCombinedSeries) {
      base.push({
        portfolioId: COMBINED_SERIES_ID,
        name: 'Łącznie',
        color: combinedColor,
        points: combinedFiltered,
        lineWidth: 3,
      });
    }
    return base;
  }, [compareSeries, showCombinedSeries, combinedFiltered, combinedColor]);

  // Wiersze sekcji „Statystyki łączne" — agregaty z już pobranych odpowiedzi.
  const combinedSummaries: CombinedPortfolioSummary[] = useMemo(
    () =>
      compareLoaded
        ? [
            {
              portfolioId: activeId,
              name: activeName,
              color: isDark ? ACTIVE_SERIES_COLOR.dark : ACTIVE_SERIES_COLOR.light,
              baseCurrency: data.baseCurrency,
              metrics: data.metrics,
            },
            ...validCompareIds.map((id, i) => ({
              portfolioId: id,
              name: portfolios.find((p) => p.id === id)?.name ?? id,
              color: compareSeriesColor(i, isDark),
              baseCurrency: compareResults[i].data!.baseCurrency,
              metrics: compareResults[i].data!.metrics,
            })),
          ]
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compareLoaded, compareDataKey, compareSelectionKey, portfolios, activeId, activeName, isDark],
  );

  // Portfele startujące w różnych momentach zakresu: każda linia zaczyna od 0%
  // od własnego pierwszego punktu — przy >7 dniach różnicy pokazujemy notkę.
  const startDatesDiffer = useMemo(() => {
    const starts = chartSeries.map((s) => s.points[0]?.date).filter(Boolean);
    if (starts.length < 2) return false;
    const min = starts.reduce((a, b) => (a < b ? a : b));
    const max = starts.reduce((a, b) => (a > b ? a : b));
    return (new Date(max).getTime() - new Date(min).getTime()) / 86400000 > 7;
  }, [chartSeries]);

  // Instrumenty bez historii notowań (delisted itp.) — silnik wycenia ich okresy
  // z cen transakcji. Notka pod wykresem, chowana per portfel i ZESTAW
  // instrumentów: pojawienie się nowego nieznanego papieru pokazuje ją ponownie.
  const unpriced = data?.unpricedInstruments ?? [];
  const unpricedKey = unpriced
    .map((u) => u.isin)
    .sort()
    .join(',');
  const [dismissedUnpricedKey, setDismissedUnpricedKey] = useLocalStorage(
    `dashboard-unpriced-dismissed-${activeId}`,
    '',
  );
  const unpricedNotice = useMemo(() => {
    if (unpriced.length === 0 || dismissedUnpricedKey === unpricedKey) return null;
    const label = (u: (typeof unpriced)[number]) => {
      const from = u.firstHeld.slice(0, 4);
      const to = u.lastHeld?.slice(0, 4);
      const period = to ? (to === from ? from : `${from}–${to}`) : `od ${from}`;
      return `${u.name} (${period})`;
    };
    const shown = unpriced.slice(0, 3).map(label).join(', ');
    const more = unpriced.length - 3;
    return (
      `Wycena częściowo przybliżona — brak historii notowań dla: ${shown}` +
      `${more > 0 ? ` i ${more} więcej` : ''}. ` +
      `Okresy bez notowań wyceniono po cenach z Twoich transakcji.`
    );
  }, [unpriced, unpricedKey, dismissedUnpricedKey]);
  const dismissUnpricedNotice = () => setDismissedUnpricedKey(unpricedKey);

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

  // Linia benchmarku w trybie porównania — semantyka dashboardu bez zmian:
  // serie benchmarku AKTYWNEGO portfela (TWR = czysty zwrot cenowy indeksu,
  // MWR = symulacja DCA wpłat aktywnego). Guard na same zera = nieudany fetch.
  const compareBenchmark: BenchmarkLine | null = useMemo(() => {
    if (!compareMode || !showBenchmark) return null;
    const field =
      chartMode === 'twr' ? ('benchmarkTwrPct' as const) : ('benchmarkReturnPct' as const);
    if (!filteredHistory.some((p) => p[field] !== 0)) return null;
    return {
      label: benchmarkLabel,
      points: filteredHistory.map((p) => ({ date: p.date, value: p[field] })),
    };
  }, [compareMode, showBenchmark, chartMode, filteredHistory, benchmarkLabel]);

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
                    {compareMode && chartMode === 'mwr'
                      ? `Benchmark DCA symuluje wpłaty/wypłaty aktywnego portfela (${activeName}) — dla pozostałych portfeli służy tylko jako punkt odniesienia.`
                      : 'Porównanie z indeksem — pokazuje jak poradziłby sobie portfel indeksowy przy tych samych wpłatach/wypłatach (strategia DCA)'}
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

              {/* Akcje: porównanie + share + mobilne ustawienia (desktop: koniec paska) */}
              <div className="ml-auto flex shrink-0 items-center gap-1 md:order-6 md:ml-0">
                {/* Porównanie portfeli — sens tylko przy ≥2 portfelach */}
                {portfolios.length > 1 && (
                  <ComparePortfolioPicker
                    portfolios={portfolios}
                    activeId={activeId}
                    selectedOtherIds={compareIds}
                    onChange={setCompareIds}
                    showCombined={showCombined}
                    onShowCombinedChange={setShowCombined}
                    combinedDisabledReason={
                      currencyConflict ? `Różne waluty bazowe: ${currencyConflict}` : null
                    }
                  />
                )}

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
        <CardContent className={compareMode ? 'space-y-3' : undefined}>
          {/* Chipy-legenda trybu porównania: kolor serii + nazwa + % zakresu */}
          {compareMode && (
            <div className="flex flex-wrap items-center gap-1.5">
              {compareSeries.map((s, i) => {
                const q = i === 0 ? null : compareResults[i - 1];
                const lastPct = s.points.length
                  ? s.points[s.points.length - 1][chartMode === 'twr' ? 'twrPct' : 'returnPct']
                  : null;
                return (
                  <SeriesChip
                    key={s.portfolioId}
                    name={s.name}
                    color={s.color}
                    pct={lastPct}
                    loading={i === 0 ? isLoading : (q?.isLoading ?? false)}
                    error={i === 0 ? false : (q?.isError ?? false)}
                    onRetry={() => q?.refetch()}
                    onRemove={
                      i === 0
                        ? undefined
                        : () => setCompareIds((ids) => ids.filter((id) => id !== s.portfolioId))
                    }
                  />
                );
              })}
              {showCombinedSeries && (
                <SeriesChip
                  name="Łącznie"
                  color={combinedColor}
                  pct={
                    combinedFiltered[combinedFiltered.length - 1][
                      chartMode === 'twr' ? 'twrPct' : 'returnPct'
                    ]
                  }
                  loading={false}
                  error={false}
                  onRetry={() => {}}
                  onRemove={() => setShowCombined(false)}
                />
              )}
            </div>
          )}

          {isLoading ? (
            <LoadingSpinner />
          ) : compareMode ? (
            chartSeries.length ? (
              <ComparisonChart series={chartSeries} mode={chartMode} benchmark={compareBenchmark} />
            ) : (
              <div className="flex items-center justify-center h-80 text-muted-foreground">
                Brak danych w wybranym zakresie dat.
              </div>
            )
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

          {compareMode && startDatesDiffer && (
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              Portfele mają różne daty startu w tym zakresie — każda linia startuje od 0% od
              własnego pierwszego punktu.
            </p>
          )}

          {!compareMode && unpricedNotice && (
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Info className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="flex-1">{unpricedNotice}</span>
              <button
                type="button"
                className="shrink-0 hover:text-foreground transition-colors"
                aria-label="Ukryj informację o przybliżonej wycenie"
                onClick={dismissUnpricedNotice}
              >
                <X className="h-3 w-3" />
              </button>
            </p>
          )}
        </CardContent>
      </Card>

      {/* W trybie porównania warunek rozluźniony: statystyki/drawdown renderują się,
          gdy KTÓRAKOLWIEK seria ma dane (nawet jeśli aktywny jest „krótki" w zakresie). */}
      {!isLoading &&
        (compareMode
          ? compareSeries.some((s) => s.points.length > 1)
          : filteredHistory.length > 1) && (
          <PerformanceStats
            data={filteredHistory}
            benchmarkLabel={benchmarkLabel}
            showBenchmark={showBenchmark}
            riskFreeRatePct={data?.riskFreeRatePct}
            compareSeries={compareMode ? compareSeries : undefined}
          />
        )}

      {/* Heatmapa dotyczy jednego portfela — w trybie porównania schodzi ze sceny. */}
      {!isLoading && !compareMode && data?.history && data.history.length > 1 && (
        <MonthlyReturnsChart
          history={data.history}
          benchmarkLabel={benchmarkLabel}
          showBenchmark={showBenchmark}
        />
      )}

      {!isLoading &&
        (compareMode
          ? compareSeries.some((s) => s.points.length > 1)
          : filteredHistory.length > 1) && (
          <DrawdownChart
            data={filteredHistory}
            benchmarkLabel={benchmarkLabel}
            showBenchmark={showBenchmark}
            compareSeries={compareMode ? compareSeries : undefined}
          />
        )}

      {/* Statystyki łączne — agregaty per portfel + metryki „jak jeden rachunek";
          sekcja niezależna od przełącznika linii „Łącznie" na wykresie. */}
      {compareMode && !isLoading && compareLoaded && (
        <CombinedStatsSection
          summaries={combinedSummaries}
          currencyConflict={currencyConflict}
          combinedPoints={combinedFiltered}
          benchmarkLabel={benchmarkLabel}
          showBenchmark={showBenchmark}
          riskFreeRatePct={data?.riskFreeRatePct}
        />
      )}
    </div>
  );
}

function SeriesChip({
  name,
  color,
  pct,
  loading,
  error,
  onRetry,
  onRemove,
}: {
  name: string;
  color: string;
  pct: number | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  /** Brak = chip aktywnego portfela (nie da się go usunąć z porównania). */
  onRemove?: () => void;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border bg-card px-2 py-0.5 text-xs',
        error && 'border-loss/50',
      )}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="max-w-[140px] truncate font-medium">{name}</span>
      {error ? (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1 text-loss hover:underline"
          aria-label={`Błąd pobierania danych portfela ${name} — spróbuj ponownie`}
        >
          <AlertTriangle className="h-3 w-3" />
          błąd
          <RefreshCw className="h-3 w-3" />
        </button>
      ) : loading ? (
        <span className="h-3 w-10 animate-pulse rounded bg-muted" />
      ) : pct !== null ? (
        <span
          className={cn(
            'tabular-nums',
            pct > 0 ? 'text-gain' : pct < 0 ? 'text-loss' : 'text-muted-foreground',
          )}
        >
          {pct >= 0 ? '+' : ''}
          {pct.toFixed(1)}%
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
      {onRemove && (
        <button
          onClick={onRemove}
          className="ml-0.5 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={`Usuń ${name} z porównania`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
