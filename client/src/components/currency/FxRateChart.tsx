import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SeriesMarker, Time } from 'lightweight-charts';
import type { FxChartPair } from 'shared';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { useTheme } from '@/lib/use-theme';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { PriceMarkerChart, snapToSession } from '@/components/shared/PriceMarkerChart';
import { formatNumber, formatDate } from '@/lib/formatters';
import {
  FX_CHART_PAIRS,
  FX_PAIR_META,
  aggregateByDay,
  buildAvgRateLedger,
  exchangeRate,
  markerSize,
  type FxDayAggregate,
} from './fx-chart-data';

/**
 * Wykres kursu pary walutowej z markerami wymian — odpowiednik wykresu
 * instrumentu z markerami K/S: strzałka w górę = nabycie waluty bazowej
 * (np. PLN→USD na USD/PLN), w dół = jej sprzedaż. Schodkowa linia = średni
 * kroczący kurs nabycia (tylko z wymian tej pary). Wymiany z jednego dnia
 * i kierunku są sklejane w jeden marker (resztówki IBKR), tooltip pokazuje
 * pojedyncze wymiany.
 */
export function FxRateChart({ height = 320 }: { height?: number }) {
  const { isDark } = useTheme();
  const [pair, setPair] = useState<FxChartPair>('USDPLN');
  // Pełna historia kursu — dociągana po presecie sięgającym przed załadowane dane
  const [fullHistory, setFullHistory] = useState(false);

  const {
    data: history,
    isLoading: historyLoading,
    isFetching: historyFetching,
  } = useQuery({
    queryKey: QUERY_KEYS.fxPairHistory(pair, fullHistory),
    queryFn: () => api.getFxPairHistory(pair, { full: fullHistory }),
    staleTime: 12 * 60 * 60 * 1000, // seria dzienna
    placeholderData: (prev) => prev,
  });

  const { data: fxData } = useQuery({
    queryKey: QUERY_KEYS.fxHistory,
    queryFn: api.getFxHistory,
  });

  const points = useMemo(
    () => [...(history?.points ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    [history?.points],
  );

  // Agregaty wymian pary (dzień+kierunek) i ich przypięcie do sesji notowań
  const aggregates = useMemo(
    () => aggregateByDay(fxData?.exchanges ?? [], pair),
    [fxData?.exchanges, pair],
  );

  const aggBySessionDate = useMemo(() => {
    const map = new Map<string, FxDayAggregate[]>();
    if (!points.length) return map;
    const dates = points.map((p) => p.date);
    for (const agg of aggregates) {
      const session = snapToSession(dates, agg.date);
      const list = map.get(session);
      if (list) list.push(agg);
      else map.set(session, [agg]);
    }
    return map;
  }, [points, aggregates]);

  const gainColor = isDark ? '#43c384' : '#1f845a';
  const lossColor = isDark ? '#e06a55' : '#c0392b';

  const markers = useMemo(() => {
    const out: SeriesMarker<Time>[] = [];
    const maxAmount = Math.max(0, ...aggregates.map((a) => a.amountBase));
    const { base } = FX_PAIR_META[pair];
    for (const [session, aggs] of aggBySessionDate) {
      for (const agg of aggs) {
        const isBuy = agg.direction === 'buy';
        // Resztówki (IBKR zamiata np. 0,36 EUR osobnym wierszem) — strzałka
        // zostaje, ale etykieta „S 0 EUR" to szum; szczegóły są w tooltipie.
        const labeled = agg.amountBase >= maxAmount * 0.05;
        out.push({
          time: session as Time,
          position: isBuy ? 'belowBar' : 'aboveBar',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          color: isBuy ? gainColor : lossColor,
          size: markerSize(agg.amountBase, maxAmount),
          ...(labeled
            ? { text: `${isBuy ? 'K' : 'S'} ${formatNumber(agg.amountBase, 0)} ${base}` }
            : {}),
        });
      }
    }
    return out;
  }, [aggBySessionDate, aggregates, pair, gainColor, lossColor]);

  // Tooltip: pojedyncze (niezagregowane) wymiany z danego dnia sesyjnego
  const tooltipRowsFor = useCallback(
    (dateStr: string) => {
      const aggs = aggBySessionDate.get(dateStr) ?? [];
      const { base, quote } = FX_PAIR_META[pair];
      return aggs
        .flatMap((agg) => agg.exchanges)
        .map((ex) => {
          const isBuy = ex.currencyTo === base;
          const color = isBuy ? gainColor : lossColor;
          const label = isBuy ? `Kupno ${base}` : `Sprzedaż ${base}`;
          const amt = isBuy ? ex.amountTo : ex.amountFrom;
          const rate = exchangeRate(ex, pair);
          const dayNote =
            ex.date.split('T')[0] !== dateStr
              ? ` <span style="opacity:0.6">(${formatDate(ex.date)})</span>`
              : '';
          return `
            <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:2px">
              <span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block"></span>
              ${label}: <strong>${formatNumber(amt)} ${base} @ ${rate !== null ? formatNumber(rate, 4) : '—'} ${quote}</strong>${dayNote}
            </div>`;
        })
        .join('');
    },
    [aggBySessionDate, pair, gainColor, lossColor],
  );

  // Schodkowa linia średniego kursu nabycia waluty bazowej
  const stepSeries = useMemo(() => {
    if (!points.length) return undefined;
    const data = buildAvgRateLedger(
      aggregates,
      points.map((p) => p.date),
    );
    return data.some((d) => d.value != null)
      ? { data, tooltipLabel: `Śr. kurs nabycia ${FX_PAIR_META[pair].base}` }
      : undefined;
  }, [points, aggregates, pair]);

  const handlePairChange = (next: FxChartPair) => {
    setPair(next);
    setFullHistory(false); // zakres nowej pary znów od jej wymian
  };

  const handleNeedFullHistory = useCallback(() => setFullHistory(true), []);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex w-fit items-center gap-0.5 rounded-md bg-muted p-0.5">
          {FX_CHART_PAIRS.map((p) => (
            <button
              key={p}
              className={`shrink-0 rounded-md px-2 py-0.5 text-xs font-medium transition-colors ${
                pair === p
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => handlePairChange(p)}
            >
              {FX_PAIR_META[p].label}
            </button>
          ))}
        </div>
      </div>
      {historyLoading ? (
        <div style={{ height }} className="flex items-center justify-center">
          <LoadingSpinner />
        </div>
      ) : !points.length ? (
        <div style={{ height }} className="flex items-center justify-center">
          <EmptyState message={`Brak historii kursu ${FX_PAIR_META[pair].label}.`} />
        </div>
      ) : (
        <PriceMarkerChart
          points={points}
          currency={history?.currency ?? FX_PAIR_META[pair].quote}
          markers={markers}
          tooltipRowsFor={tooltipRowsFor}
          stepSeries={stepSeries}
          height={height}
          showRangePresets
          isFetchingFull={fullHistory && historyFetching}
          onNeedFullHistory={fullHistory ? undefined : handleNeedFullHistory}
          ariaLabel={`Wykres kursu ${FX_PAIR_META[pair].label} z zaznaczonymi wymianami walut`}
        />
      )}
    </div>
  );
}
