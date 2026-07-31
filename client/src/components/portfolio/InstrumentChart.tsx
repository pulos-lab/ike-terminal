import { useCallback, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SeriesMarker, Time } from 'lightweight-charts';
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
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { PriceMarkerChart, snapToSession } from '@/components/shared/PriceMarkerChart';
import { formatNumber, formatQuantity } from '@/lib/formatters';

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
 *
 * Mechanika wykresu (seria, markery, tooltip, presety, clamping) mieszka we
 * wspólnym `PriceMarkerChart` — tu tylko dane instrumentu i treść
 * markerów/tooltipa.
 */
export function InstrumentChart({
  isin,
  height = 400,
  avgBuyPrice,
  showRangePresets = false,
}: InstrumentChartProps) {
  const { isDark } = useTheme();
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
  // w PLN). Ref zamiast dep — odświeżenie kursów nie przebudowuje wykresu.
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

  const gainColor = isDark ? '#43c384' : '#1f845a';
  const lossColor = isDark ? '#e06a55' : '#c0392b';
  const divColor = isDark ? '#60a5fa' : '#2563eb';
  const eventColor = isDark ? '#c084fc' : '#9333ea';

  // Markery K/S + wypłaty dywidend + zdarzenia korporacyjne
  const markers = useMemo(() => {
    const out: SeriesMarker<Time>[] = [];
    for (const [session, txs] of txBySessionDate) {
      for (const tx of txs) {
        const isBuy = tx.side === 'K';
        out.push({
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
      out.push({
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
      out.push({
        time: session as Time,
        position: 'aboveBar',
        shape: 'square',
        color: eventColor,
        size: 0.7,
        text: `Split ${splitRatioLabel(split.ratio)}`,
      });
    }
    for (const [session, so] of spinOffBySessionDate) {
      out.push({
        time: session as Time,
        position: 'aboveBar',
        shape: 'square',
        color: eventColor,
        size: 0.7,
        text:
          so.parentIsin === isin ? `Spin-off ${so.childTicker}` : `Spin-off z ${so.parentTicker}`,
      });
    }
    return out;
  }, [
    txBySessionDate,
    divBySessionDate,
    splitBySessionDate,
    spinOffBySessionDate,
    isin,
    gainColor,
    lossColor,
    divColor,
    eventColor,
  ]);

  // Wiersze tooltipa dla dnia sesyjnego: transakcje + dywidendy + zdarzenia
  const tooltipRowsFor = useCallback(
    (dateStr: string) => {
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

      return `${txRows}${divRows}${splitRow}${spinOffRow}`;
    },
    [
      txBySessionDate,
      divBySessionDate,
      splitBySessionDate,
      spinOffBySessionDate,
      isin,
      gainColor,
      lossColor,
      divColor,
      eventColor,
    ],
  );

  const stepSeries = useMemo(
    () =>
      avgCostData.some((d) => d.value != null)
        ? { data: avgCostData, tooltipLabel: 'Śr. koszt' }
        : undefined,
    [avgCostData],
  );

  const priceLine = useMemo(
    () =>
      avgBuyPrice != null && avgBuyPrice > 0
        ? { price: avgBuyPrice, title: 'śr. cena' }
        : undefined,
    [avgBuyPrice],
  );

  const handleNeedFullHistory = useCallback(() => setFullHistory(true), []);

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
    <PriceMarkerChart
      points={points}
      currency={history?.currency ?? ''}
      markers={markers}
      tooltipRowsFor={tooltipRowsFor}
      stepSeries={stepSeries}
      priceLine={priceLine}
      height={height}
      showRangePresets={showRangePresets}
      isFetchingFull={fullHistory && historyFetching}
      onNeedFullHistory={fullHistory ? undefined : handleNeedFullHistory}
      ariaLabel={`Wykres kursu ${history?.ticker ?? ''} z zaznaczonymi transakcjami kupna i sprzedaży`}
    />
  );
}

/** „2:1" dla splitu (ratio 2), „1:20" dla reverse splitu (ratio 0.05). */
function splitRatioLabel(ratio: number): string {
  return ratio < 1 ? `1:${Math.round(1 / ratio)}` : `${Math.round(ratio)}:1`;
}
