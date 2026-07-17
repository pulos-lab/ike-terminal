import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { BENCHMARKS, type BenchmarkKey } from 'shared';
import { publicApi } from '@/lib/api-client';
import { filterAndRebaseHistory, getPresetStartDate } from '@/lib/returns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Logo } from '@/components/ui/Logo';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { PortfolioChart } from '@/components/dashboard/PortfolioChart';
import { PerformanceStats } from '@/components/dashboard/PerformanceStats';
import { DrawdownChart } from '@/components/dashboard/DrawdownChart';
import { MonthlyReturnsChart } from '@/components/dashboard/MonthlyReturnsChart';
import { PublicPositionsTable } from './PublicPositionsTable';

const PRESET_RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', 'ALL'] as const;

/**
 * Publiczny widok udostępnionego portfela (/share/:token) — bez logowania,
 * poza AuthGuard/PortfolioProvider. Reużywa komponenty wykresów dashboardu
 * (są props-only); benchmark jest zablokowany na wybranym przez właściciela.
 */
export function SharePublicPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [timeRange, setTimeRange] = useState<string>('ALL');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [chartMode, setChartMode] = useState<'mwr' | 'twr'>('mwr');

  // Belt-and-braces noindex (prod ustawia też X-Robots-Tag na /share/*)
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  const metaQuery = useQuery({
    queryKey: ['public-share', token, 'meta'],
    queryFn: () => publicApi.getShareMeta(token),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  const historyQuery = useQuery({
    queryKey: ['public-share', token, 'history'],
    queryFn: () => publicApi.getShareHistory(token),
    staleTime: 60 * 60 * 1000,
    enabled: !!metaQuery.data,
    retry: false,
  });

  const showPositions = metaQuery.data?.scope === 'chart_positions';
  const positionsQuery = useQuery({
    queryKey: ['public-share', token, 'positions'],
    queryFn: () => publicApi.getSharePositions(token),
    staleTime: 60 * 60 * 1000,
    enabled: showPositions,
    retry: false,
  });

  const isCustom = timeRange === 'CUSTOM';
  const startDate = isCustom ? customFrom || undefined : getPresetStartDate(timeRange);
  const endDate = isCustom ? customTo || undefined : undefined;

  const filteredHistory = useMemo(
    () => filterAndRebaseHistory(historyQuery.data?.history ?? [], startDate, endDate),
    [historyQuery.data, startDate, endDate],
  );

  function selectCustom() {
    setTimeRange('CUSTOM');
    if (!customFrom && historyQuery.data?.history?.length) {
      setCustomFrom(historyQuery.data.history[0].date);
    }
    if (!customTo) {
      setCustomTo(new Date().toISOString().split('T')[0]);
    }
  }

  // Jednolity ekran błędu — serwer zwraca 404 dla każdego nieaktywnego linku
  if (metaQuery.isError || historyQuery.isError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center">
        <Logo size="lg" />
        <h1 className="text-lg font-semibold">Ten link jest nieprawidłowy lub wygasł</h1>
        <p className="text-sm text-muted-foreground max-w-md">
          Właściciel portfela mógł unieważnić udostępnienie albo link stracił ważność. Poproś o nowy
          link.
        </p>
        <Button asChild variant="outline">
          <Link to="/">Przejdź do strony głównej</Link>
        </Button>
      </div>
    );
  }

  if (metaQuery.isLoading || historyQuery.isLoading || !metaQuery.data) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  const meta = metaQuery.data;
  const benchmarkLabel = BENCHMARKS[meta.benchmark as BenchmarkKey]?.label ?? meta.benchmark;
  const showBenchmark = meta.benchmark !== 'none';
  const fullHistory = historyQuery.data?.history ?? [];

  return (
    <div className="min-h-screen bg-background">
      {/* Minimalny shell — bez nawigacji aplikacji */}
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-4 md:px-6 h-14 flex items-center justify-between gap-3">
          <Link to="/" className="shrink-0">
            <Logo size="sm" />
          </Link>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold truncate">{meta.portfolioName}</span>
            <span className="inline-flex items-center gap-1 shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Eye className="h-3 w-3" />
              Widok udostępniony
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 md:px-6 py-4 space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-col md:flex-row md:flex-wrap md:items-center md:justify-between gap-x-4 gap-y-2">
              <CardTitle className="text-sm font-semibold">
                {meta.portfolioName}
                {showBenchmark ? ` vs ${benchmarkLabel}` : ''}
              </CardTitle>

              <div className="flex items-center gap-1 overflow-x-auto -mx-6 px-6 md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                {PRESET_RANGES.map((r) => (
                  <button
                    key={r}
                    className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                      timeRange === r
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    onClick={() => setTimeRange(r)}
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

            <div className="flex flex-wrap items-center gap-2 mt-2">
              <div className="flex items-center bg-muted rounded-md p-0.5">
                <button
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    chartMode === 'mwr' ? 'bg-background text-foreground' : 'text-muted-foreground'
                  }`}
                  onClick={() => setChartMode('mwr')}
                >
                  MWR
                </button>
                <button
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    chartMode === 'twr' ? 'bg-background text-foreground' : 'text-muted-foreground'
                  }`}
                  onClick={() => setChartMode('twr')}
                >
                  TWR
                </button>
              </div>
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
          </CardHeader>
          <CardContent>
            {filteredHistory.length ? (
              <PortfolioChart
                data={filteredHistory}
                benchmarkLabel={benchmarkLabel}
                mode={chartMode}
                showBenchmark={showBenchmark}
              />
            ) : (
              <div className="flex items-center justify-center h-80 text-muted-foreground">
                Brak danych w wybranym zakresie.
              </div>
            )}
          </CardContent>
        </Card>

        {filteredHistory.length > 1 && (
          <PerformanceStats
            data={filteredHistory}
            benchmarkLabel={benchmarkLabel}
            showBenchmark={showBenchmark}
          />
        )}

        {fullHistory.length > 1 && (
          <MonthlyReturnsChart
            history={fullHistory}
            benchmarkLabel={benchmarkLabel}
            showBenchmark={showBenchmark}
          />
        )}

        {filteredHistory.length > 1 && (
          <DrawdownChart
            data={filteredHistory}
            benchmarkLabel={benchmarkLabel}
            showBenchmark={showBenchmark}
          />
        )}

        {showPositions &&
          (positionsQuery.isLoading ? (
            <LoadingSpinner />
          ) : positionsQuery.data ? (
            <PublicPositionsTable data={positionsQuery.data} showAmounts={meta.showAmounts} />
          ) : null)}

        <footer className="py-6 text-center text-xs text-muted-foreground">
          Widok tylko do odczytu · dane odświeżane raz dziennie ·{' '}
          <Link to="/" className="underline hover:text-foreground">
            TIX Terminal
          </Link>
        </footer>
      </main>
    </div>
  );
}
