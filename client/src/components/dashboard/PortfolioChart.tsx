import { useEffect, useRef } from 'react';
import { createChart, LineSeries, type IChartApi } from 'lightweight-charts';

interface ChartDataPoint {
  date: string;
  portfolioValue: number;
  returnPct: number;
  twrPct: number;
  benchmarkValue: number;
  benchmarkReturnPct: number;
  benchmarkTwrPct: number;
  investedCumulative: number;
}

interface Props {
  data: ChartDataPoint[];
  benchmarkLabel: string;
  mode?: 'mwr' | 'twr';
  showBenchmark?: boolean;
}

export function PortfolioChart({ data, benchmarkLabel, mode = 'mwr', showBenchmark = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!containerRef.current || !data.length) return;

    if (chartRef.current) {
      chartRef.current.remove();
    }

    const isDark = document.documentElement.classList.contains('dark');

    const chart = createChart(containerRef.current, {
      height: 400,
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

    const isTwr = mode === 'twr';
    const portfolioSeries = chart.addSeries(LineSeries, {
      color: isDark ? '#f59e0b' : '#c27a0a',
      lineWidth: 2,
      title: isTwr ? 'Portfel TWR %' : 'Portfel %',
      priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(2)}%` },
    });

    const portfolioData = data.map(d => ({
      time: d.date as string,
      value: isTwr ? d.twrPct : d.returnPct,
    }));
    portfolioSeries.setData(portfolioData as any);

    // Show benchmark only when enabled and data is available (not all zeros from failed fetch)
    const benchmarkField = isTwr ? 'benchmarkTwrPct' : 'benchmarkReturnPct';
    const hasBenchmarkData = showBenchmark && data.some(d => d[benchmarkField] !== 0);

    if (hasBenchmarkData) {
      const benchmarkSeries = chart.addSeries(LineSeries, {
        color: isDark ? '#71717a' : '#787068',
        lineWidth: 1,
        lineStyle: 2,
        title: `${benchmarkLabel} ${isTwr ? 'TWR ' : ''}%`,
        priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(2)}%` },
      });
      const benchmarkData = data.map(d => ({
        time: d.date as string,
        value: isTwr ? d.benchmarkTwrPct : d.benchmarkReturnPct,
      }));
      benchmarkSeries.setData(benchmarkData as any);
    }

    chart.timeScale().fitContent();

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
  }, [data, benchmarkLabel, mode, showBenchmark]);

  return <div ref={containerRef} className="w-full" />;
}
