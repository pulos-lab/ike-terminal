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
        <span className="ml-2 font-normal text-muted-foreground">{p.paperName}</span>
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
      <p className="tabular-nums">
        <span className="text-muted-foreground">Udział: </span>
        {formatNumber(p.z, 1)}%
      </p>
    </div>
  );
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
              <TooltipContent className="max-w-[320px] text-xs">
                Każda kropka to pozycja: oś X — annualizowana zmienność dziennych zwrotów, oś Y —
                zwrot ceny za ostatnie ~12 miesięcy (w walucie notowania, bez wpływu FX), wielkość
                kropki — udział w portfelu. Lewy górny róg = wysoki zwrot przy niskim ryzyku; prawy
                dolny = wysokie ryzyko bez nagrody.
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
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              axisLine={{ stroke: 'var(--border)' }}
              tickLine={false}
              label={{
                value: 'Zmienność (ann.)',
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
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickFormatter={(v: number) => `${v.toFixed(0)}%`}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <ZAxis type="number" dataKey="z" range={[60, 400]} name="Udział" />
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
