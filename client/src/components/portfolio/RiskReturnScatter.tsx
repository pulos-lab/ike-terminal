import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import {
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatNumber, formatPercent } from '@/lib/formatters';
import type { Position } from 'shared';

interface Props {
  positions: Position[];
}

interface ScatterPoint {
  ticker: string;
  paperName: string;
  x: number; // volatilityPct
  y: number; // returnPct
  z: number; // weight
  currency: string;
  /** Punkt odniesienia (portfel/benchmark) — bez udziału, romb zamiast kropki. */
  isRef?: boolean;
  refKey?: string;
}

function PointTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ScatterPoint }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="font-semibold mb-1">
        {p.ticker}
        {p.paperName && (
          <span className="ml-2 font-normal text-muted-foreground">{p.paperName}</span>
        )}
      </p>
      <p className="tabular-nums">
        <span className="text-muted-foreground">Zwrot 12M: </span>
        <span className={p.y >= 0 ? 'text-gain' : 'text-loss'}>{formatPercent(p.y)}</span>
        <span className="text-muted-foreground"> ({p.currency})</span>
      </p>
      <p className="tabular-nums">
        <span className="text-muted-foreground">Zmienność: </span>
        {formatNumber(p.x)}%
      </p>
      {!p.isRef && (
        <p className="tabular-nums">
          <span className="text-muted-foreground">Udział: </span>
          {formatNumber(p.z, 1)}%
        </p>
      )}
    </div>
  );
}

/**
 * Kolory punktów odniesienia: portfel amber (jak jego linia na dashboardzie),
 * indeksy niebieskie — obie barwy są poza paletą gain/loss kropek pozycji,
 * więc odniesienia czytają się na pierwszy rzut oka mimo tego samego kształtu.
 */
function refColor(key: string): string {
  return key === 'portfolio' ? 'var(--primary)' : 'var(--info)';
}

/**
 * Osie nieliniowe: pojedynczy outlier (np. spółka z +160% przy 290% zmienności)
 * na skali liniowej zgniata resztę punktów w rogu. X = skala √ (zmienność ≥ 0),
 * Y = symlog (liniowa przy zerze, logarytmiczna na ogonach — działa z ujemnymi
 * zwrotami). Wartości pozostają prawdziwe, zmienia się tylko geometria osi,
 * więc gęsty środek dostaje większość powierzchni.
 */
const X_TICK_CANDIDATES = [0, 10, 20, 40, 80, 160, 320];
const Y_TICK_CANDIDATES = [-320, -160, -80, -40, -20, 0, 20, 40, 80, 160, 320];

function pickTicks(candidates: number[], maxAbs: number): number[] {
  return candidates.filter((t) => Math.abs(t) <= maxAbs * 1.35);
}

/**
 * Karta „Ryzyko vs zwrot" — każda pozycja jako kropka: X = annualizowana
 * zmienność, Y = zwrot ceny za ~12M (w walucie notowania — czysty risk
 * instrumentu, bez FX), wielkość = udział w portfelu. Metryki liczy backend
 * z cache historii cen; pozycje bez wystarczającej historii wypisane pod
 * wykresem zamiast cichego zniknięcia.
 */
export function RiskReturnScatter({ positions }: Props) {
  const tickers = useMemo(
    () =>
      positions
        .filter((p) => p.category !== 'option' && p.shares > 0)
        .map((p) => p.ticker)
        .sort(),
    [positions],
  );

  const { data } = useQuery({
    queryKey: [...QUERY_KEYS.riskReturn, tickers.join('|')],
    queryFn: () => api.postRiskReturn(tickers),
    enabled: tickers.length > 0,
    staleTime: 60 * 60 * 1000,
  });

  const points = useMemo<ScatterPoint[]>(() => {
    if (!data) return [];
    const byTicker = new Map(positions.map((p) => [p.ticker, p]));
    return data.metrics.flatMap((m) => {
      const pos = byTicker.get(m.ticker);
      if (!pos) return [];
      return [
        {
          ticker: pos.ticker,
          paperName: pos.paperName,
          x: m.volatilityPct,
          y: m.returnPct,
          z: pos.weight,
          currency: pos.currency,
        },
      ];
    });
  }, [data, positions]);

  // Punkty odniesienia (portfel + WIG + S&P 500) — romby o stałym rozmiarze.
  const refPoints = useMemo<ScatterPoint[]>(
    () =>
      (data?.references ?? []).map((r) => ({
        ticker: r.label,
        paperName: '',
        x: r.volatilityPct,
        y: r.returnPct,
        z: 1,
        currency: r.currency,
        isRef: true,
        refKey: r.key,
      })),
    [data],
  );

  const allPoints = [...points, ...refPoints];
  const xTicks = pickTicks(X_TICK_CANDIDATES, Math.max(30, ...allPoints.map((p) => p.x)));
  const yTicks = pickTicks(Y_TICK_CANDIDATES, Math.max(20, ...allPoints.map((p) => Math.abs(p.y))));

  if (!data || points.length < 2) return null;

  return (
    <Card>
      <CardHeader className="pb-1">
        <TooltipProvider>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            Ryzyko vs zwrot (12 mies.)
            <UITooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 cursor-help text-muted-foreground/60 hover:text-muted-foreground transition-colors" />
              </TooltipTrigger>
              <TooltipContent className="max-w-[340px] text-xs">
                Każda kropka to pozycja: oś X — annualizowana zmienność dziennych zwrotów, oś Y —
                zwrot ceny za ostatnie ~12 miesięcy (w walucie notowania, bez wpływu FX), wielkość
                kropki — udział w portfelu. Punkty odniesienia mają własne kolory: Portfel (amber,
                TWR) oraz indeksy WIG i S&P 500 (niebieskie) — pozycje powyżej indeksu biją go przy
                danym ryzyku. Osie są nieliniowe (√ / symlog), żeby pojedynczy outlier nie zgniatał
                reszty punktów. Uwaga: WIG jest indeksem dochodowym (z dywidendami) w PLN, S&P 500
                cenowym w USD.
              </TooltipContent>
            </UITooltip>
          </CardTitle>
        </TooltipProvider>
      </CardHeader>
      <CardContent className="pb-4">
        <ResponsiveContainer width="100%" height={300}>
          <ScatterChart
            margin={{ top: 16, right: 16, bottom: 4, left: 0 }}
            accessibilityLayer
            aria-label="Wykres punktowy ryzyko-zwrot pozycji portfela"
          >
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis
              type="number"
              dataKey="x"
              name="Zmienność"
              scale="sqrt"
              domain={[0, 'dataMax']}
              ticks={xTicks}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              axisLine={{ stroke: 'var(--border)' }}
              tickLine={false}
              label={{
                value: 'Zmienność (ann., skala √)',
                position: 'insideBottomRight',
                offset: -2,
                fontSize: 10,
                fill: 'var(--muted-foreground)',
              }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name="Zwrot 12M"
              scale="symlog"
              domain={['dataMin', 'dataMax']}
              ticks={yTicks}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <ZAxis type="number" dataKey="z" range={[60, 400]} name="Udział" />
            {/* Stały rozmiar punktów odniesienia (nie mają „udziału") — u górnej
                granicy kropek pozycji, żeby czytały się jako kotwice wykresu. */}
            <ZAxis type="number" dataKey="z" range={[360, 360]} zAxisId="ref" />
            <ReferenceLine y={0} stroke="var(--muted-foreground)" strokeDasharray="4 4" />
            <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<PointTooltip />} />
            <Scatter data={points} isAnimationActive={false}>
              {points.map((p) => (
                <Cell
                  key={p.ticker}
                  fill={p.y >= 0 ? 'var(--gain)' : 'var(--loss)'}
                  fillOpacity={0.75}
                />
              ))}
              <LabelList
                dataKey="ticker"
                position="top"
                className="fill-muted-foreground"
                fontSize={9}
              />
            </Scatter>
            {refPoints.length > 0 && (
              <Scatter data={refPoints} zAxisId="ref" shape="circle" isAnimationActive={false}>
                {refPoints.map((p) => (
                  <Cell
                    key={p.refKey}
                    fill={refColor(p.refKey ?? '')}
                    fillOpacity={0.95}
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
                ))}
                {/* Podpisy nad ikoną — dokładnie jak przy pozycjach; wyróżnia je
                    tylko pogrubienie i pełny kontrast. */}
                <LabelList
                  dataKey="ticker"
                  position="top"
                  className="fill-foreground"
                  fontSize={10}
                  fontWeight={600}
                />
              </Scatter>
            )}
          </ScatterChart>
        </ResponsiveContainer>
        {data.skipped.length > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Poza wykresem (za krótka historia cen): {data.skipped.join(', ')}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
