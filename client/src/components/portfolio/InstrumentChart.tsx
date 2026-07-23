import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import type {
  AppliedSpinOff,
  DividendRecord,
  LiveFxRates,
  StockSplit,
  TransactionWithMeta,
} from 'shared';
import { api } from '@/lib/api-client';
import { toQuotePrice } from './quote-price';
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
  // Pełna historia notowań — dociągana dopiero, gdy user kliknie preset sięgający
  // przed pierwszą transakcję (ALL, albo np. 3Y przy młodszej pozycji).
  const [fullHistory, setFullHistory] = useState(false);

  const {
    data: history,
    isLoading: historyLoading,
    isFetching: historyFetching,
  } = useQuery({
    queryKey: QUERY_KEYS.instrumentHistory(isin, fullHistory),
    queryFn: () => api.getInstrumentHistory(isin, { full: fullHistory }),
    staleTime: 12 * 60 * 60 * 1000, // historia dzienna — bez sensu refetchować częściej
    // Przy przejściu tx→full wykres trzyma stare dane zamiast mrugać spinnerem
    placeholderData: (prev) => prev,
  });

  const { data: txData, isLoading: txLoading } = useQuery({
    queryKey: QUERY_KEYS.transactions,
    queryFn: api.getTransactions,
  });

  // Dywidendy/splity/spin-offy nie bramkują renderu wykresu — markery dochodzą,
  // gdy dane spłyną
  const { data: divData } = useQuery({
    queryKey: QUERY_KEYS.dividends,
    queryFn: api.getDividends,
  });
  const { data: splitsData } = useQuery({
    queryKey: QUERY_KEYS.splits,
    queryFn: api.getSplits,
  });
  const { data: spinOffsData } = useQuery({
    queryKey: QUERY_KEYS.spinOffs,
    queryFn: api.getSpinOffs,
  });
  // Dzisiejsze kursy FX do przeliczeń w tooltipie (Bossa/mBank zagranica księgują
  // w PLN). Ref zamiast dep efektu — odświeżenie kursów nie przebudowuje wykresu.
  const { data: livePrices } = useQuery({
    queryKey: QUERY_KEYS.livePrices,
    queryFn: api.getLivePrices,
    staleTime: 5 * 60 * 1000,
  });
  const fxRef = useRef<LiveFxRates | undefined>(undefined);
  fxRef.current = livePrices?.fx;

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

  // Wypłaty dywidend/kuponów instrumentu, też przypięte do sesji (dywidendy
  // księgują się w dni wypłaty, które bywają poza sesjami notowań)
  const divBySessionDate = useMemo(() => {
    const map = new Map<string, DividendRecord[]>();
    if (!points.length) return map;
    const dates = points.map((p) => p.date);
    for (const div of divData?.dividends ?? []) {
      if (div.isin !== isin) continue;
      const session = snapToSession(dates, div.date.split('T')[0]);
      const list = map.get(session);
      if (list) list.push(div);
      else map.set(session, [div]);
    }
    return map;
  }, [points, divData?.dividends, isin]);

  const instrumentSplits = useMemo(
    () =>
      (splitsData?.splits ?? [])
        .filter((s) => s.isin === isin)
        .sort((a, b) => a.splitDate.localeCompare(b.splitDate)),
    [splitsData?.splits, isin],
  );

  // Spin-offy, w których instrument brał udział (jako rodzic lub dziecko);
  // skipped_broker to też realne zdarzenie (broker sam zaksięgował dziecko),
  // reverted — cofnięte, pomijamy.
  const instrumentSpinOffs = useMemo(
    () =>
      (spinOffsData?.spinOffs ?? []).filter(
        (s) => s.status !== 'reverted' && (s.parentIsin === isin || s.childIsin === isin),
      ),
    [spinOffsData?.spinOffs, isin],
  );

  const splitBySessionDate = useMemo(() => {
    const map = new Map<string, StockSplit>();
    if (!points.length) return map;
    const dates = points.map((p) => p.date);
    for (const s of instrumentSplits) map.set(snapToSession(dates, s.splitDate), s);
    return map;
  }, [points, instrumentSplits]);

  const spinOffBySessionDate = useMemo(() => {
    const map = new Map<string, AppliedSpinOff>();
    if (!points.length) return map;
    const dates = points.map((p) => p.date);
    for (const s of instrumentSpinOffs) map.set(snapToSession(dates, s.exDate), s);
    return map;
  }, [points, instrumentSpinOffs]);

  // Schodkowa linia średniego kosztu w czasie: po każdej transakcji K/S średnia
  // się zmienia; gdy pozycja spada do zera — przerwa (whitespace). Spin-off
  // obniża koszt rodzica o zamrożoną alokację.
  const avgCostData = useMemo(() => {
    if (!points.length || !instrumentTxs.length) return [];
    // Ceny transakcji bywają w innej walucie niż notowania — przeliczenie
    // wymagałoby historycznego FX, więc w takiej sytuacji linii nie rysujemy
    // (statyczna śr. cena z silnika, już poprawnie przeliczona, zostaje).
    // Dwa przypadki: (a) jawna rozbieżność walut; (b) Bossa/mBank zagranica —
    // endpoint transakcji nadpisuje `currency` walutą notowań z ticker_map,
    // ale surowa cena pozostaje w PLN (auto-FX brokera), co zdradza
    // paymentCurrency ≠ currency przy tych źródłach.
    const priceNotInQuote = (t: TransactionWithMeta) =>
      (history?.currency ? t.currency !== history.currency : false) ||
      ((t.source === 'bossa' || t.source === 'mbank') &&
        !!t.paymentCurrency &&
        t.paymentCurrency !== t.currency);
    if (instrumentTxs.some(priceNotInQuote)) return [];
    // Instrument ze splitem: cache price_history.db bywa NIEJEDNOLICIE
    // adjustowany (wiersze sprzed splitu zapisane w dawnej skali, nowe w nowej
    // — pułapka „split-window", por. PR #186), więc żadna korekta po stronie
    // klienta nie jest wiarygodna. Linii nie rysujemy; marker splitu zostaje.
    if (instrumentSplits.length) return [];
    const parentSpinOffs = instrumentSpinOffs
      .filter((s) => s.parentIsin === isin && s.status === 'applied')
      .sort((a, b) => a.exDate.localeCompare(b.exDate));
    let shares = 0;
    let cost = 0;
    let ti = 0;
    let si = 0;
    const out: Array<{ time: string; value?: number }> = [];
    for (const p of points) {
      while (ti < instrumentTxs.length && instrumentTxs[ti].date.split('T')[0] <= p.date) {
        const tx = instrumentTxs[ti++];
        if (tx.side === 'K') {
          shares += tx.quantity;
          cost += tx.quantity * tx.price;
        } else if (shares > 0) {
          cost -= tx.quantity * (cost / shares);
          shares -= tx.quantity;
          if (shares <= 1e-9) {
            shares = 0;
            cost = 0;
          }
        }
      }
      while (si < parentSpinOffs.length && parentSpinOffs[si].exDate <= p.date) {
        cost *= 1 - parentSpinOffs[si].allocationPct;
        si++;
      }
      if (shares > 1e-9 && cost > 0) out.push({ time: p.date, value: cost / shares });
      else out.push({ time: p.date });
    }
    return out;
  }, [points, instrumentTxs, instrumentSplits, instrumentSpinOffs, isin, history?.currency]);

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
    // Preset wykracza przed załadowane dane → dociągnij pełną historię notowań;
    // po jej nadejściu efekt przebuduje wykres i zastosuje rangeRef ponownie.
    if (!fullHistory && points.length) {
      const presetStart = preset !== 'ALL' ? getPresetStartDate(preset) : undefined;
      if (preset === 'ALL' || (presetStart && presetStart < points[0].date)) {
        setFullHistory(true);
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

    const gainColor = isDark ? '#43c384' : '#1f845a';
    const lossColor = isDark ? '#e06a55' : '#c0392b';
    const amberColor = isDark ? '#f59e0b' : '#c27a0a';
    const divColor = isDark ? '#60a5fa' : '#2563eb';
    const eventColor = isDark ? '#c084fc' : '#9333ea';
    const avgCostColor = isDark ? '#a1a1aa' : '#78716c';
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

    // Schodkowa linia średniego kosztu w czasie (przerwy, gdy pozycja = 0)
    let avgCostSeries: ISeriesApi<'Line'> | null = null;
    if (avgCostData.some((d) => d.value != null)) {
      avgCostSeries = chart.addSeries(LineSeries, {
        color: avgCostColor,
        lineWidth: 1,
        lineType: LineType.WithSteps,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        priceFormat: { type: 'custom', formatter: (v: number) => formatNumber(v) },
      });
      avgCostSeries.setData(avgCostData.map((d) => ({ ...d, time: d.time as Time })));
    }

    // Markery K/S + wypłaty dywidend — sortowanie po czasie jest wymagane
    // przez lightweight-charts
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
    // Dywidendy: jedno kółko na linii kursu per dzień sesyjny (kilka wypłat
    // jednego dnia — np. rozbicie brutto/podatek — nie mnoży markerów)
    for (const session of divBySessionDate.keys()) {
      markers.push({
        time: session as Time,
        position: 'inBar',
        shape: 'circle',
        color: divColor,
        size: 0.7,
        text: 'D',
      });
    }
    // Zdarzenia korporacyjne: splity i spin-offy (kwadrat nad świecą)
    for (const [session, split] of splitBySessionDate) {
      markers.push({
        time: session as Time,
        position: 'aboveBar',
        shape: 'square',
        color: eventColor,
        size: 0.7,
        text: `Split ${splitRatioLabel(split.ratio)}`,
      });
    }
    for (const [session, so] of spinOffBySessionDate) {
      markers.push({
        time: session as Time,
        position: 'aboveBar',
        shape: 'square',
        color: eventColor,
        size: 0.7,
        text:
          so.parentIsin === isin ? `Spin-off ${so.childTicker}` : `Spin-off z ${so.parentTicker}`,
      });
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
          // Cena w walucie notowania ("~" = przeliczenie dzisiejszym kursem FX)
          const qp = toQuotePrice(tx, fxRef.current);
          const approx = qp.approx ? '~' : '';
          return `
            <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:2px">
              <span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block"></span>
              ${label}: <strong>${formatQuantity(tx.quantity)} szt. @ ${approx}${formatNumber(qp.price)} ${qp.currency}</strong>
            </div>`;
        })
        .join('');

      const divs = divBySessionDate.get(dateStr) ?? [];
      const divRows = divs
        .map(
          (d) => `
            <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:2px">
              <span style="width:8px;height:8px;border-radius:50%;background:${divColor};display:inline-block"></span>
              ${d.subkind === 'coupon' ? 'Kupon' : 'Dywidenda'}: <strong>${formatNumber(d.amount)} ${d.currency}</strong>
            </div>`,
        )
        .join('');

      const eventRow = (label: string) => `
        <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:2px">
          <span style="width:8px;height:8px;background:${eventColor};display:inline-block"></span>
          ${label}
        </div>`;
      const split = splitBySessionDate.get(dateStr);
      const splitRow = split
        ? eventRow(
            `${split.ratio < 1 ? 'Reverse split' : 'Split'} <strong>${splitRatioLabel(split.ratio)}</strong>`,
          )
        : '';
      const so = spinOffBySessionDate.get(dateStr);
      const spinOffRow = so
        ? eventRow(
            so.parentIsin === isin
              ? `Spin-off: <strong>${so.childTicker}</strong> (−${(so.allocationPct * 100).toFixed(1)}% kosztu)`
              : `Wydzielenie z <strong>${so.parentTicker}</strong>`,
          )
        : '';

      const avg = avgCostSeries ? param.seriesData.get(avgCostSeries) : undefined;
      const avgVal = avg && 'value' in avg ? (avg as { value: number }).value : null;
      const avgRow =
        avgVal !== null
          ? `<div style="font-size:12px;color:${isDark ? '#a8a29e' : '#71717a'}">Śr. koszt: <strong>${formatNumber(avgVal)} ${currency}</strong></div>`
          : '';

      tooltip.innerHTML = `
        <div style="font-size:11px;color:${isDark ? '#a8a29e' : '#71717a'};margin-bottom:4px">${dateStr}</div>
        <div style="font-size:12px">Kurs: <strong>${formatNumber(priceVal)} ${currency}</strong></div>
        ${avgRow}
        ${txRows}
        ${divRows}
        ${splitRow}
        ${spinOffRow}
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
  }, [
    points,
    txBySessionDate,
    divBySessionDate,
    splitBySessionDate,
    spinOffBySessionDate,
    avgCostData,
    isin,
    isDark,
    height,
    avgBuyPrice,
    history?.currency,
  ]);

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
          {fullHistory && historyFetching && (
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

/** „2:1" dla splitu (ratio 2), „1:20" dla reverse splitu (ratio 0.05). */
function splitRatioLabel(ratio: number): string {
  return ratio < 1 ? `1:${Math.round(1 / ratio)}` : `${Math.round(ratio)}:1`;
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
