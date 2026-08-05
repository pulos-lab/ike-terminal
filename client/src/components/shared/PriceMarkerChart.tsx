import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  AreaSeries,
  LineSeries,
  LineStyle,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { Loader2 } from 'lucide-react';
import { useTheme } from '@/lib/use-theme';
import { getPresetStartDate } from '@/lib/returns';
import { formatNumber } from '@/lib/formatters';

/** Te same etykiety co zakres wykresu dashboardu/share — spójna konwencja. */
const PRESET_RANGES = ['1M', '3M', '6M', 'YTD', '1Y', '3Y', 'ALL'] as const;

export interface PriceMarkerChartProps {
  points: Array<{ date: string; close: number }>;
  /** Waluta kwotowania — etykieta przy kursie w tooltipie. */
  currency: string;
  /** Markery serii (posortowanie po czasie robi komponent). */
  markers: SeriesMarker<Time>[];
  /**
   * Dodatkowe wiersze HTML tooltipa pod „Kurs:" dla danego dnia sesyjnego
   * (transakcje/dywidendy/wymiany itd. — treść należy do rodzica).
   */
  tooltipRowsFor?: (sessionDate: string) => string;
  /**
   * Schodkowa linia (śr. koszt/kurs nabycia w czasie); przerwy przez punkty bez
   * `value` (whitespace). Wiersz tooltipa z wartością linii dorabia komponent.
   */
  stepSeries?: { data: Array<{ time: string; value?: number }>; tooltipLabel: string };
  /** Pozioma przerywana linia (np. statyczna śr. cena z silnika). */
  priceLine?: { price: number; title: string };
  height?: number;
  /** Pasek presetów zakresu (1M…ALL) nad wykresem. */
  showRangePresets?: boolean;
  /** Spinner przy presetach — rodzic dociąga pełną historię. */
  isFetchingFull?: boolean;
  /**
   * Preset sięga przed pierwszy załadowany punkt (albo ALL) → rodzic może
   * dociągnąć pełną historię; po jej nadejściu wykres przebuduje się sam.
   */
  onNeedFullHistory?: () => void;
  ariaLabel: string;
}

/**
 * Bazowy wykres kursu (Lightweight Charts) z markerami zdarzeń: AreaSeries +
 * markery + tooltip na crosshair + presety zakresu + clamping. Treść markerów
 * i tooltipa należy do rodzica (InstrumentChart: K/S/dywidendy/splity;
 * FxRateChart: wymiany walut) — tu jest wyłącznie mechanika LWC.
 */
export function PriceMarkerChart({
  points,
  currency,
  markers,
  tooltipRowsFor,
  stepSeries,
  priceLine,
  height = 400,
  showRangePresets = false,
  isFetchingFull = false,
  onNeedFullHistory,
  ariaLabel,
}: PriceMarkerChartProps) {
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
    // Preset wykracza przed załadowane dane → rodzic może dociągnąć pełną
    // historię; po jej nadejściu efekt przebuduje wykres i zastosuje rangeRef.
    if (onNeedFullHistory && points.length) {
      const presetStart = preset !== 'ALL' ? getPresetStartDate(preset) : undefined;
      if (preset === 'ALL' || (presetStart && presetStart < points[0].date)) {
        onNeedFullHistory();
      }
    }
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

    const amberColor = isDark ? '#f59e0b' : '#c27a0a';
    const stepColor = isDark ? '#a1a1aa' : '#78716c';

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

    if (priceLine && priceLine.price > 0) {
      priceSeries.createPriceLine({
        price: priceLine.price,
        color: isDark ? '#71717a' : '#787068',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: priceLine.title,
      });
    }

    // Schodkowa linia (przerwy, gdy brak wartości)
    let stepLineSeries: ISeriesApi<'Line'> | null = null;
    if (stepSeries && stepSeries.data.some((d) => d.value != null)) {
      stepLineSeries = chart.addSeries(LineSeries, {
        color: stepColor,
        lineWidth: 1,
        lineType: LineType.WithSteps,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceFormat: { type: 'custom', formatter: (v: number) => formatNumber(v) },
      });
      stepLineSeries.setData(stepSeries.data.map((d) => ({ ...d, time: d.time as Time })));
    }

    // Sortowanie markerów po czasie jest wymagane przez lightweight-charts
    const sortedMarkers = [...markers].sort((a, b) => String(a.time).localeCompare(String(b.time)));
    createSeriesMarkers(priceSeries, sortedMarkers);

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

    // Tooltip: kurs + wiersze rodzica dla danego dnia sesyjnego
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

      const step = stepLineSeries ? param.seriesData.get(stepLineSeries) : undefined;
      const stepVal = step && 'value' in step ? (step as { value: number }).value : null;
      const stepRow =
        stepVal !== null && stepSeries
          ? `<div style="font-size:12px;color:${isDark ? '#a8a29e' : '#71717a'}">${stepSeries.tooltipLabel}: <strong>${formatNumber(stepVal)} ${currency}</strong></div>`
          : '';

      tooltip.innerHTML = `
        <div style="font-size:11px;color:${isDark ? '#a8a29e' : '#71717a'};margin-bottom:4px">${dateStr}</div>
        <div style="font-size:12px">Kurs: <strong>${formatNumber(priceVal)} ${currency}</strong></div>
        ${stepRow}
        ${tooltipRowsFor?.(dateStr) ?? ''}
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    points,
    markers,
    tooltipRowsFor,
    stepSeries,
    priceLine?.price,
    priceLine?.title,
    isDark,
    height,
    currency,
  ]);

  return (
    <div>
      {showRangePresets && (
        <div className="mb-2 ml-auto flex w-fit items-center gap-0.5 rounded-md bg-muted p-0.5">
          {isFetchingFull && (
            <Loader2
              className="mx-1 h-3 w-3 animate-spin text-muted-foreground"
              aria-label="Dociąganie pełnej historii notowań"
            />
          )}
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
      <div style={{ position: 'relative' }} ref={containerRef} role="img" aria-label={ariaLabel}>
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
 * zdarzenie późniejsze niż ostatnie notowanie → ostatnia sesja. Zdarzenia
 * (transakcje, wymiany walut) bywają w dni bez notowania — lightweight-charts
 * ignoruje czas spoza serii, więc bez snapowania marker znika z wykresu.
 */
export function snapToSession(sortedDates: string[], eventDate: string): string {
  let lo = 0;
  let hi = sortedDates.length - 1;
  if (eventDate > sortedDates[hi]) return sortedDates[hi];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedDates[mid] < eventDate) lo = mid + 1;
    else hi = mid;
  }
  return sortedDates[lo];
}
