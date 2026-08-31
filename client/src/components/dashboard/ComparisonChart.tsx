import { useEffect, useRef } from 'react';
import { createChart, LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { CompareSeries } from '@/lib/compare-series';
import { BENCHMARK_COLOR } from '@/lib/chart-palette';
import { useTheme } from '@/lib/use-theme';
import { CHART_MIN_BAR_SPACING } from '@/lib/chart-options';

export interface BenchmarkLine {
  label: string;
  points: { date: string; value: number }[];
}

interface Props {
  series: CompareSeries[];
  mode: 'mwr' | 'twr';
  benchmark: BenchmarkLine | null;
}

/** Nazwy portfeli są danymi użytkownika, a tooltip składamy przez innerHTML. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function ComparisonChart({ series, mode, benchmark }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // Reaktywny motyw — wykres przebudowuje się przy toggle dark/light
  // (isDark jest w deps efektu), jak w PortfolioChart/CashFlowChart.
  const { isDark } = useTheme();

  useEffect(() => {
    if (!containerRef.current || !series.length) return;

    if (chartRef.current) {
      chartRef.current.remove();
    }

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
        minBarSpacing: CHART_MIN_BAR_SPACING,
      },
      crosshair: {
        horzLine: { labelBackgroundColor: isDark ? '#27272a' : '#1c1917' },
        vertLine: { labelBackgroundColor: isDark ? '#27272a' : '#1c1917' },
      },
    });

    chartRef.current = chart;

    const isTwr = mode === 'twr';
    const pctFormat = {
      type: 'custom' as const,
      formatter: (v: number) => `${v.toFixed(2)}%`,
    };

    // Kolejność dodawania = kolejność wierszy tooltipa (portfele, potem benchmark).
    const tooltipRows: { handle: ISeriesApi<'Line'>; name: string; color: string }[] = [];

    for (const s of series) {
      const handle = chart.addSeries(LineSeries, {
        color: s.color,
        lineWidth: s.lineWidth ?? 2,
        // Legendą są chipy nad wykresem — wbudowane etykiety LWC przy 5 seriach
        // zaśmiecałyby oś cen.
        title: '',
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: pctFormat,
      });
      handle.setData(
        s.points.map((p) => ({ time: p.date, value: isTwr ? p.twrPct : p.returnPct })) as never[],
      );
      tooltipRows.push({ handle, name: s.name, color: s.color });
    }

    if (benchmark) {
      const benchColor = isDark ? BENCHMARK_COLOR.dark : BENCHMARK_COLOR.light;
      const handle = chart.addSeries(LineSeries, {
        color: benchColor,
        lineWidth: 1,
        lineStyle: 2,
        title: '',
        lastValueVisible: false,
        priceLineVisible: false,
        priceFormat: pctFormat,
      });
      handle.setData(benchmark.points.map((p) => ({ time: p.date, value: p.value })) as never[]);
      tooltipRows.push({ handle, name: benchmark.label, color: benchColor });
    }

    chart.timeScale().fitContent();

    // Ograniczenie zakresu — nie wyjeżdżamy poza dane (z małym buforem);
    // oś czasu wyznacza najdłuższa seria.
    const maxLen = Math.max(...series.map((s) => s.points.length), benchmark?.points.length ?? 0);
    const maxIdx = maxLen - 1;
    const buffer = Math.ceil(maxLen * 0.03);
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

    // Wspólny tooltip crosshair (wzorzec z CashFlowChart) — jeden wiersz per seria.
    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;

      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        tooltip.style.display = 'none';
        return;
      }

      const pfmt = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
      const rows: string[] = [];
      for (const r of tooltipRows) {
        const d = param.seriesData.get(r.handle);
        const value = d && 'value' in d ? (d as { value: number }).value : null;
        if (value === null) continue;
        rows.push(`
          <div style="display:flex;align-items:center;gap:8px;font-size:12px;margin-top:3px">
            <span style="width:8px;height:8px;border-radius:50%;background:${r.color};display:inline-block;flex-shrink:0"></span>
            <span style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(r.name)}</span>
            <strong style="margin-left:auto;font-variant-numeric:tabular-nums">${pfmt(value)}</strong>
          </div>`);
      }

      if (!rows.length) {
        tooltip.style.display = 'none';
        return;
      }

      tooltip.innerHTML =
        `<div style="font-size:11px;color:${isDark ? '#a8a29e' : '#71717a'};margin-bottom:2px">${String(param.time)}</div>` +
        rows.join('');

      tooltip.style.display = 'block';

      const chartRect = containerRef.current!.getBoundingClientRect();
      const tooltipWidth = tooltip.offsetWidth;
      const tooltipHeight = tooltip.offsetHeight;

      let left = param.point.x + 16;
      if (left + tooltipWidth > chartRect.width) {
        left = param.point.x - tooltipWidth - 16;
      }
      let top = param.point.y - tooltipHeight / 2;
      top = Math.max(0, Math.min(top, chartRect.height - tooltipHeight));

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
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
  }, [series, benchmark, mode, isDark]);

  // Canvas lightweight-charts jest niewidoczny dla czytników ekranu — rola img
  // z opisem to jedyna sensowna reprezentacja.
  return (
    <div
      style={{ position: 'relative' }}
      ref={containerRef}
      role="img"
      aria-label={`Wykres porównania ${mode === 'twr' ? 'TWR' : 'MWR'} portfeli: ${series
        .map((s) => s.name)
        .join(', ')}${benchmark ? ` vs ${benchmark.label}` : ''}`}
    >
      <div
        ref={tooltipRef}
        style={{
          display: 'none',
          position: 'absolute',
          zIndex: 10,
          pointerEvents: 'none',
          padding: '8px 12px',
          borderRadius: '8px',
          background: isDark ? '#1c1917' : '#fefdfb',
          border: `1px solid ${isDark ? '#27272a' : '#e4e4e7'}`,
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          whiteSpace: 'nowrap',
          color: isDark ? '#fafaf9' : '#1c1917',
          minWidth: '180px',
        }}
      />
    </div>
  );
}
