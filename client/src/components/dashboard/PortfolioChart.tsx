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
}

export function PortfolioChart({ data, benchmarkLabel, mode = 'mwr' }: Props) {
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
        textColor: isDark ? '#a1a1aa' : '#71717a',
        fontFamily: 'Inter, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: isDark ? '#27272a' : '#f4f4f5' },
        horzLines: { color: isDark ? '#27272a' : '#f4f4f5' },
      },
      rightPriceScale: {
        borderColor: isDark ? '#27272a' : '#e4e4e7',
      },
      timeScale: {
        borderColor: isDark ? '#27272a' : '#e4e4e7',
        timeVisible: false,
      },
      crosshair: {
        horzLine: { labelBackgroundColor: isDark ? '#27272a' : '#18181b' },
        vertLine: { labelBackgroundColor: isDark ? '#27272a' : '#18181b' },
      },
    });

    chartRef.current = chart;

    const isTwr = mode === 'twr';
    const portfolioSeries = chart.addSeries(LineSeries, {
      color: '#22c55e',
      lineWidth: 2,
      title: isTwr ? 'Portfel TWR %' : 'Portfel %',
      priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(2)}%` },
    });

    const benchmarkSeries = chart.addSeries(LineSeries, {
      color: '#71717a',
      lineWidth: 1,
      lineStyle: 2,
      title: `${benchmarkLabel} ${isTwr ? 'TWR ' : ''}%`,
      priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(2)}%` },
    });

    const portfolioData = data.map(d => ({
      time: d.date as string,
      value: isTwr ? d.twrPct : d.returnPct,
    }));
    const benchmarkData = data.map(d => ({
      time: d.date as string,
      value: isTwr ? d.benchmarkTwrPct : d.benchmarkReturnPct,
    }));

    portfolioSeries.setData(portfolioData as any);
    benchmarkSeries.setData(benchmarkData as any);

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
  }, [data, benchmarkLabel, mode]);

  return <div ref={containerRef} className="w-full" />;
}
