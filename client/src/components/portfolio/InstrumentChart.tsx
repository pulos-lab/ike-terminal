import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  createChart,
  createSeriesMarkers,
  AreaSeries,
  LineStyle,
  type IChartApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import type { TransactionWithMeta } from 'shared';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { useTheme } from '@/lib/use-theme';
import { getPresetStartDate } from '@/lib/returns';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { formatNumber, formatQuantity } from '@/lib/formatters';

/** Te same etykiety co zakres wykresu dashboardu/share — spójna konwencja. */
const PRESET_RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', 'ALL'] as const;

interface InstrumentChartProps {
  isin: string;
  height?: number;
  /** Pozioma linia śr. ceny nabycia (wartość z pozycji — już po korektach splitów). */
  avgBuyPrice?: number;
  /** Pasek presetów zakresu (1M…ALL) nad wykresem — widok główny (strona instrumentu). */
  showRangePresets?: boolean;
}

/**
 * Wykres kursu jednego instrumentu z markerami transakcji: strzałka w górę pod
 * świecą = kupno (K), strzałka w dół nad świecą = sprzedaż (S). Tooltip na
 * crosshair pokazuje kurs + szczegóły transakcji z danego dnia.
 *
 * Markery są przypinane do najbliższej sesji ≥ daty transakcji (transakcja
 * z dnia bez notowania — np. instrument zagraniczny a święto lokalne — nie
 * może wypaść z wykresu, bo lightweight-charts ignoruje czas spoza serii).
 */
export function InstrumentChart({
  isin,
  height = 400,
  avgBuyPrice,
  showRangePresets = false,
}: InstrumentChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { isDark } = useTheme();
  // Aktywny preset zakresu; '' = zakres ręczny (po zoomie/przesunięciu myszą).
  // Ref-mirror, żeby efekt budujący wykres czytał aktualny preset bez bycia
  // od niego zależnym (zmiana presetu NIE przebudowuje wykresu).
  const [range, setRange] = useState<string>('ALL');
  const rangeRef = useRef(range);
  const applyingPresetRef = useRef(false);

  const { data: history, isLoading: historyLoading } = useQuery({
    queryKey: QUERY_KEYS.instrumentHistory(isin),
    queryFn: () => api.getInstrumentHistory(isin),
    staleTime: 12 * 60 * 60 * 1000, // historia dzienna — bez sensu refetchować częściej
  });

  const { data: txData, isLoading: txLoading } = useQuery({
    queryKey: QUERY_KEYS.transactions,
    queryFn: api.getTransactions,
  });

  const points = useMemo(
    () => [...(history?.points ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [history?.points],
  );

  const instrumentTxs = useMemo(
    () =>
      (txData?.transactions ?? [])
        .filter((t) => t.isin === isin)
        .sort((a, b) => a.date.localeCompare(b.date)),
    [txData?.transactions, isin],
  );

  // Transakcje pogrupowane po dacie sesji (po przypięciu do najbliższego notowania)
  const txBySessionDate = useMemo(() => {
    const map = new Map<string, TransactionWithMeta[]>();
    if (!points.length) return map;
    const dates = points.map((p) => p.date);
    for (const tx of instrumentTxs) {
      const txDate = tx.date.split('T')[0];
      const session = snapToSession(dates, txDate);
      const list = map.get(session);
      if (list) list.push(tx);
      else map.set(session, [tx]);
    }
    return map;
  }, [points, instrumentTxs]);

  // Ustawia widoczny zakres wg presetu. Preset starszy niż dane (albo ALL) →
  // fitContent. Flagą applyingPresetRef zarządzają call-site'y (build/klik),
  // żeby subskrypcja zakresu nie zdjęła podświetlenia po zmianie programowej.
  const applyRangePreset = (chart: IChartApi, preset: string) => {
    if (!points.length) return;
    const firstDate = points[0].date;
    const lastDate = points[points.length - 1].date;
    const presetStart = preset && preset !== 'ALL' ? getPresetStartDate(preset) : undefined;
    if (!presetStart || presetStart <= firstDate || presetStart >= lastDate) {
      chart.timeScale().fitContent();
    } else {
      chart.timeScale().setVisibleRange({ from: presetStart as Time, to: lastDate as Time });
    }
  };

  const handlePresetClick = (preset: string) => {
    setRange(preset);
    rangeRef.current = preset;
    const chart = chartRef.current;
    if (!chart) return;
    applyingPresetRef.current = true;
    applyRangePreset(chart, preset);
    setTimeout(() => {
      applyingPresetRef.current = false;
    }, 100);
  };

  useEffect(() => {
    if (!containerRef.current || !points.length) return;

    if (chartRef.current) {
      chartRef.current.remove();
    }

    // Budowa wykresu odpala zdarzenia zakresu (fitContent, pierwszy resize) —
    // przez chwilę traktujemy je jak programowe, żeby nie skasować presetu.
    applyingPresetRef.current = true;

    const gainColor = isDark ? '#43c384' : '#1f845a';
    const lossColor = isDark ? '#e06a55' : '#c0392b';
    const amberColor = isDark ? '#f59e0b' : '#c27a0a';
    const currency = history?.currency ?? '';

    const chart = createChart(containerRef.current, {
      height,
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

    const priceSeries = chart.addSeries(AreaSeries, {
      lineColor: amberColor,
      topColor: isDark ? 'rgba(245,158,11,0.18)' : 'rgba(194,122,10,0.12)',
      bottomColor: isDark ? 'rgba(245,158,11,0.02)' : 'rgba(194,122,10,0.01)',
      lineWidth: 2,
      lastValueVisible: true,
      priceLineVisible: true,
      priceFormat: { type: 'custom', formatter: (v: number) => formatNumber(v) },
    });

    priceSeries.setData(points.map((p) => ({ time: p.date as Time, value: p.close })));

    if (avgBuyPrice != null && avgBuyPrice > 0) {
      priceSeries.createPriceLine({
        price: avgBuyPrice,
        color: isDark ? '#71717a' : '#787068',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'śr. cena',
      });
    }

    // Markery K/S — sortowanie po czasie jest wymagane przez lightweight-charts
    const markers: SeriesMarker<Time>[] = [];
    for (const [session, txs] of txBySessionDate) {
      for (const tx of txs) {
        const isBuy = tx.side === 'K';
        markers.push({
          time: session as Time,
          position: isBuy ? 'belowBar' : 'aboveBar',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          color: isBuy ? gainColor : lossColor,
          text: `${tx.side} ${formatQuantity(tx.quantity)}`,
        });
      }
    }
    markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    createSeriesMarkers(priceSeries, markers);

    applyRangePreset(chart, rangeRef.current);

    // Ograniczenie zakresu — nie wyjeżdżamy poza dane (z małym buforem)
    const maxIdx = points.length - 1;
    const buffer = Math.ceil(points.length * 0.03);
    let clamping = false;
    chart.timeScale().subscribeVisibleLogicalRangeChange((logical) => {
      if (!logical || clamping) return;
      // Ręczny zoom/pan unieważnia podświetlenie presetu (zakres już nie odpowiada etykiecie)
      if (!applyingPresetRef.current && rangeRef.current) {
        rangeRef.current = '';
        setRange('');
      }
      const from = Math.max(logical.from, -buffer);
      const to = Math.min(logical.to, maxIdx + buffer);
      if (from !== logical.from || to !== logical.to) {
        clamping = true;
        chart.timeScale().setVisibleLogicalRange({ from, to });
        clamping = false;
      }
    });

    // Tooltip: kurs + transakcje z danego dnia sesyjnego
    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;

      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0) {
        tooltip.style.display = 'none';
        return;
      }

      const price = param.seriesData.get(priceSeries);
      const priceVal = price && 'value' in price ? (price as { value: number }).value : null;
      if (priceVal === null) {
        tooltip.style.display = 'none';
        return;
      }

      const dateStr = String(param.time);
      const txs = txBySessionDate.get(dateStr) ?? [];
      const txRows = txs
        .map((tx) => {
          const isBuy = tx.side === 'K';
          const color = isBuy ? gainColor : lossColor;
          const label = isBuy ? 'Kupno' : 'Sprzedaż';
          return `
            <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:2px">
              <span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block"></span>
              ${label}: <strong>${formatQuantity(tx.quantity)} szt. @ ${formatNumber(tx.price)} ${tx.currency}</strong>
            </div>`;
        })
        .join('');

      tooltip.innerHTML = `
        <div style="font-size:11px;color:${isDark ? '#a8a29e' : '#71717a'};margin-bottom:4px">${dateStr}</div>
        <div style="font-size:12px">Kurs: <strong>${formatNumber(priceVal)} ${currency}</strong></div>
        ${txRows}
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

    // Zwolnienie flagi po ustabilizowaniu layoutu (pierwszy resize/fitContent)
    const armTimer = setTimeout(() => {
      applyingPresetRef.current = false;
    }, 300);

    return () => {
      clearTimeout(armTimer);
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [points, txBySessionDate, isDark, height, avgBuyPrice, history?.currency]);

  if (historyLoading || txLoading) {
    return (
      <div style={{ height }} className="flex items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  if (!points.length) {
    return (
      <div style={{ height }} className="flex items-center justify-center">
        <EmptyState message="Brak historii notowań dla tego instrumentu." />
      </div>
    );
  }

  return (
    <div>
      {showRangePresets && (
        <div className="mb-2 ml-auto flex w-fit items-center gap-0.5 rounded-md bg-muted p-0.5">
          {PRESET_RANGES.map((r) => (
            <button
              key={r}
              className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                range === r
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => handlePresetClick(r)}
            >
              {r}
            </button>
          ))}
        </div>
      )}
      <div
        style={{ position: 'relative' }}
        ref={containerRef}
        role="img"
        aria-label={`Wykres kursu ${history?.ticker ?? ''} z zaznaczonymi transakcjami kupna i sprzedaży`}
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
          }}
        />
      </div>
    </div>
  );
}

/**
 * Najbliższa sesja ≥ podanej daty (binary search po posortowanych datach);
 * transakcja późniejsza niż ostatnie notowanie → ostatnia sesja.
 */
function snapToSession(sortedDates: string[], txDate: string): string {
  let lo = 0;
  let hi = sortedDates.length - 1;
  if (txDate > sortedDates[hi]) return sortedDates[hi];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDates[mid] < txDate) lo = mid + 1;
    else hi = mid;
  }
  return sortedDates[lo];
}
