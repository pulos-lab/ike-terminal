import { useEffect, useMemo, useRef } from 'react';
import { createChart, BaselineSeries, LineSeries, type IChartApi } from 'lightweight-charts';
import { Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatPercent } from '@/lib/formatters';
import { computeDrawdownSeries } from '@/lib/returns';
import { useTheme } from '@/lib/use-theme';

interface ChartDataPoint {
  date: string;
  twrPct: number;
  benchmarkTwrPct: number;
}

interface Props {
  data: ChartDataPoint[];
  benchmarkLabel: string;
  showBenchmark?: boolean;
}

/**
 * Karta „Obsunięcie kapitału" — underwater chart: % poniżej dotychczasowego
 * szczytu w czasie. Zawsze na indeksie TWR (niezależnie od przełącznika
 * MWR/TWR wykresu głównego) — z tego samego powodu, dla którego Max Drawdown
 * w PerformanceStats liczy się z TWR: wpłata tuż przed korektą nie może
 * zawyżać obsunięcia.
 */
export function DrawdownChart({ data, benchmarkLabel, showBenchmark = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const { isDark } = useTheme();

  const drawdowns = useMemo(() => computeDrawdownSeries(data.map((d) => d.twrPct)), [data]);
  const currentDd = drawdowns.length ? drawdowns[drawdowns.length - 1] : 0;
  const maxDd = drawdowns.length ? Math.min(...drawdowns) : 0;

  useEffect(() => {
    if (!containerRef.current || !data.length) return;

    if (chartRef.current) {
      chartRef.current.remove();
    }

    const chart = createChart(containerRef.current, {
      height: 240,
      layout: {
        background: { color: 'transparent' },
        textColor: isDark ? '#a1a1aa' : '#787068',
        fontFamily: 'Inter, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: isDark ? '#27272a' : '#ede9df' },
        horzLines: { color: isDark ? '#27272a' : '#ede9df' },
      },
      rightPriceScale: {
        borderColor: isDark ? '#27272a' : '#ddd5c8',
      },
      timeScale: {
        borderColor: isDark ? '#27272a' : '#ddd5c8',
        timeVisible: false,
      },
      crosshair: {
        horzLine: { labelBackgroundColor: isDark ? '#27272a' : '#1c1917' },
        vertLine: { labelBackgroundColor: isDark ? '#27272a' : '#1c1917' },
      },
    });

    chartRef.current = chart;

    // Wartości ≤ 0 z baseline na zerze → cała seria renderuje się „pod wodą"
    // kolorami bottom* (wypełnienie między 0 a linią) — kolory top* nie wystąpią.
    const lossColor = isDark ? '#d96c5f' : '#c0392b'; // --loss (canvas nie czyta CSS vars)
    const portfolioSeries = chart.addSeries(BaselineSeries, {
      baseValue: { type: 'price', price: 0 },
      bottomLineColor: lossColor,
      bottomFillColor1: `${lossColor}12`,
      bottomFillColor2: `${lossColor}59`,
      topLineColor: lossColor,
      topFillColor1: 'transparent',
      topFillColor2: 'transparent',
      lineWidth: 2,
      title: 'Portfel DD',
      priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(2)}%` },
    });
    portfolioSeries.setData(
      data.map((d, i) => ({ time: d.date as string, value: drawdowns[i] })) as any,
    );

    // Benchmark tylko gdy włączony i ma dane (same zera = nieudany fetch) — jak w PortfolioChart
    const hasBenchmarkData = showBenchmark && data.some((d) => d.benchmarkTwrPct !== 0);
    if (hasBenchmarkData) {
      const benchmarkDrawdowns = computeDrawdownSeries(data.map((d) => d.benchmarkTwrPct));
      const benchmarkSeries = chart.addSeries(LineSeries, {
        color: isDark ? '#71717a' : '#787068',
        lineWidth: 1,
        lineStyle: 2,
        title: `${benchmarkLabel} DD`,
        priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(2)}%` },
      });
      benchmarkSeries.setData(
        data.map((d, i) => ({ time: d.date as string, value: benchmarkDrawdowns[i] })) as any,
      );
    }

    chart.timeScale().fitContent();

    // Ograniczenie zakresu — nie wyjeżdżamy poza dane (z małym buforem)
    const maxIdx = data.length - 1;
    const buffer = Math.ceil(data.length * 0.03);
    let clamping = false;
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || clamping) return;
      const from = Math.max(range.from, -buffer);
      const to = Math.min(range.to, maxIdx + buffer);
      if (from !== range.from || to !== range.to) {
        clamping = true;
        chart.timeScale().setVisibleLogicalRange({ from, to });
        clamping = false;
      }
    });

    const observer = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [data, drawdowns, benchmarkLabel, showBenchmark, isDark]);

  if (data.length < 2) return null;

  return (
    <Card className="gap-3">
      <CardHeader className="pb-0">
        <TooltipProvider>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex items-center gap-2 min-w-0">
              <CardTitle className="text-sm font-semibold">Obsunięcie kapitału</CardTitle>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 cursor-help text-muted-foreground/60 hover:text-muted-foreground transition-colors" />
                </TooltipTrigger>
                <TooltipContent className="max-w-[300px] text-xs">
                  Drawdown — o ile % portfel jest poniżej swojego dotychczasowego szczytu w wybranym
                  zakresie. Liczony z TWR (bez wpływu wpłat/wypłat). Zero = nowy szczyt; najgłębsza
                  dolina = Max Drawdown.
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-3 text-xs tabular-nums">
              <span className="text-muted-foreground">
                Obecnie:{' '}
                <span className={currentDd < 0 ? 'font-semibold text-loss' : 'font-semibold'}>
                  {formatPercent(currentDd)}
                </span>
              </span>
              <span className="text-muted-foreground">
                Max:{' '}
                <span className={maxDd < 0 ? 'font-semibold text-loss' : 'font-semibold'}>
                  {formatPercent(maxDd)}
                </span>
              </span>
            </div>
          </div>
        </TooltipProvider>
      </CardHeader>
      <CardContent>
        {/* Canvas lightweight-charts jest niewidoczny dla czytników ekranu — rola img z opisem */}
        <div
          ref={containerRef}
          className="w-full"
          role="img"
          aria-label={`Wykres obsunięcia kapitału portfela${showBenchmark ? ` vs ${benchmarkLabel}` : ''}`}
        />
      </CardContent>
    </Card>
  );
}
