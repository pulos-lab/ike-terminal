import { useEffect, useRef, useState } from 'react';
import { createChart, AreaSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { formatCurrency } from '@/lib/formatters';
import { Maximize2 } from 'lucide-react';

interface CashFlowChartProps {
  data: { date: string; netCashFlow: number; portfolioValue: number }[];
  currency: string;
  showPortfolio: boolean;
  showCashFlow: boolean;
}

export function CashFlowChart({ data, currency, showPortfolio, showCashFlow }: CashFlowChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const portfolioSeriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const cashFlowSeriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !data.length) return;

    if (chartRef.current) {
      chartRef.current.remove();
    }

    const isDark = document.documentElement.classList.contains('dark');

    const fmt = (v: number) => {
      if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M ${currency}`;
      if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}k ${currency}`;
      return `${v.toFixed(0)} ${currency}`;
    };

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
        lockVisibleTimeRangeOnResize: true,
      },
      crosshair: {
        horzLine: { labelBackgroundColor: isDark ? '#27272a' : '#18181b' },
        vertLine: { labelBackgroundColor: isDark ? '#27272a' : '#18181b' },
      },
    });

    chartRef.current = chart;

    const amberColor = isDark ? '#f59e0b' : '#f59e0b';
    const stoneColor = isDark ? '#a8a29e' : '#787068';

    const portfolioSeries = chart.addSeries(AreaSeries, {
      lineColor: amberColor,
      topColor: isDark ? 'rgba(245,158,11,0.18)' : 'rgba(245,158,11,0.12)',
      bottomColor: isDark ? 'rgba(245,158,11,0.02)' : 'rgba(245,158,11,0.01)',
      lineWidth: 2,
      title: '',
      lastValueVisible: false,
      priceLineVisible: false,
      priceFormat: { type: 'custom', formatter: fmt },
    });

    portfolioSeriesRef.current = portfolioSeries;

    portfolioSeries.setData(
      data.map(d => ({ time: d.date as string, value: d.portfolioValue })) as any,
    );

    const cashFlowSeries = chart.addSeries(AreaSeries, {
      lineColor: isDark ? '#a8a29e' : '#5a534e',
      topColor: isDark ? 'rgba(168,162,158,0.15)' : 'rgba(90,83,78,0.14)',
      bottomColor: isDark ? 'rgba(168,162,158,0.02)' : 'rgba(90,83,78,0.02)',
      lineWidth: 2,
      lineStyle: 3,
      lastValueVisible: false,
      priceLineVisible: false,
      title: '',
      priceFormat: { type: 'custom', formatter: fmt },
    });

    cashFlowSeriesRef.current = cashFlowSeries;

    cashFlowSeries.setData(
      data.map(d => ({ time: d.date as string, value: d.netCashFlow })) as any,
    );

    chart.timeScale().fitContent();

    // Ograniczenie zakresu + detekcja zoomu
    const maxIdx = data.length - 1;
    const buffer = Math.ceil(data.length * 0.03);
    let clamping = false;
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range || clamping) return;

      // Detekcja zoomu — porównanie z pełnym zakresem
      const isFullRange = range.from <= 0 && range.to >= maxIdx;
      setZoomed(!isFullRange);

      const from = Math.max(range.from, -buffer);
      const to = Math.min(range.to, maxIdx + buffer);
      if (from !== range.from || to !== range.to) {
        clamping = true;
        chart.timeScale().setVisibleLogicalRange({ from, to });
        clamping = false;
      }
    });

    // Tooltip na crosshair
    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;

      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        tooltip.style.display = 'none';
        return;
      }

      const pv = param.seriesData.get(portfolioSeries);
      const cf = param.seriesData.get(cashFlowSeries);
      const pvVal = pv && 'value' in pv ? (pv as any).value : null;
      const cfVal = cf && 'value' in cf ? (cf as any).value : null;

      if (pvVal === null && cfVal === null) {
        tooltip.style.display = 'none';
        return;
      }

      const dateStr = String(param.time);
      tooltip.innerHTML = `
        <div style="font-size:11px;color:${isDark ? '#a8a29e' : '#71717a'};margin-bottom:4px">${dateStr}</div>
        <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:2px">
          <span style="width:8px;height:8px;border-radius:50%;background:${amberColor};display:inline-block"></span>
          Portfel: <strong>${pvVal !== null ? formatCurrency(pvVal, currency) : '—'}</strong>
        </div>
        <div style="display:flex;align-items:center;gap:6px;font-size:12px">
          <span style="width:8px;height:8px;border-radius:50%;background:${stoneColor};display:inline-block"></span>
          Wpłaty netto: <strong>${cfVal !== null ? formatCurrency(cfVal, currency) : '—'}</strong>
        </div>
      `;

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
  }, [data, currency]);

  // Toggle widoczności serii bez przebudowy wykresu
  useEffect(() => {
    portfolioSeriesRef.current?.applyOptions({ visible: showPortfolio });
    cashFlowSeriesRef.current?.applyOptions({ visible: showCashFlow });
  }, [showPortfolio, showCashFlow]);

  const isDark = document.documentElement.classList.contains('dark');

  return (
    <div style={{ position: 'relative' }} ref={containerRef}>
      {zoomed && (
        <button
          onClick={() => {
            chartRef.current?.timeScale().fitContent();
            setZoomed(false);
          }}
          className="absolute bottom-2 right-2 z-10 p-1.5 rounded-md bg-card border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          title="Resetuj skalę"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      )}
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
        }}
      />
    </div>
  );
}
