import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import {
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
  usePlotArea,
  useXAxisScale,
  useYAxisScale,
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

// ─── Etykiety z rozstrzyganiem kolizji ───────────────────────────────────────
// Domyślny LabelList position="top" nie wie o innych etykietach: w klastrze
// (np. Portfel/S&P 500/VWCE przy podobnej zmienności) napisy nachodziły na
// siebie, a przy krawędziach wykresu były ucinane. Zamiast per-punktowych
// LabelList jedna warstwa liczy WSZYSTKIE podpisy naraz (hooki skal recharts 3)
// — deterministycznie, w kolejności: odniesienia, potem pozycje wg udziału.

interface PlacedBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function overlaps(a: PlacedBox, b: PlacedBox): boolean {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

interface LabelSpec {
  text: string;
  cx: number;
  cy: number;
  r: number;
  fontSize: number;
  className: string;
  fontWeight?: number;
}

interface PlacedLabel extends LabelSpec {
  tx: number;
  ty: number;
  anchor: 'middle' | 'start' | 'end';
}

/** Greedy: nad → pod → z prawej → z lewej; kolizja ze wszystkimi już ułożonymi + krawędziami pola wykresu. */
function layoutLabels(
  specs: LabelSpec[],
  plot: { x: number; y: number; width: number; height: number },
): PlacedLabel[] {
  const placed: PlacedBox[] = [];
  const out: PlacedLabel[] = [];
  const gap = 3;

  for (const s of specs) {
    const w = s.text.length * s.fontSize * 0.62;
    const h = s.fontSize + 2;
    const candidates: Array<{ bx: number; by: number; anchor: PlacedLabel['anchor'] }> = [
      { bx: s.cx - w / 2, by: s.cy - s.r - gap - h, anchor: 'middle' },
      { bx: s.cx - w / 2, by: s.cy + s.r + gap, anchor: 'middle' },
      { bx: s.cx + s.r + gap, by: s.cy - h / 2, anchor: 'start' },
      { bx: s.cx - s.r - gap - w, by: s.cy - h / 2, anchor: 'end' },
      // Awaryjnie: schodkowanie w dół pod punktem (gęsty klaster)
      { bx: s.cx - w / 2, by: s.cy + s.r + gap + h + 2, anchor: 'middle' },
      { bx: s.cx - w / 2, by: s.cy + s.r + gap + 2 * (h + 2), anchor: 'middle' },
    ];

    let pick = candidates[0];
    let pickBox: PlacedBox | null = null;
    for (const c of candidates) {
      // Dociągnięcie do pola wykresu w poziomie (etykiety skrajnych punktów
      // były ucinane); pion tylko walidujemy — lepiej spaść na kolejnego
      // kandydata niż zasłonić punkt.
      const bx = Math.min(Math.max(c.bx, plot.x), plot.x + plot.width - w);
      const box: PlacedBox = { x1: bx - 2, y1: c.by - 1, x2: bx + w + 2, y2: c.by + h + 1 };
      if (box.y1 < plot.y - 14 || box.y2 > plot.y + plot.height + 14) continue;
      pick = { ...c, bx };
      pickBox = box;
      if (!placed.some((b) => overlaps(b, box))) break;
    }
    const finalBox = pickBox ?? {
      x1: pick.bx - 2,
      y1: pick.by - 1,
      x2: pick.bx + w + 2,
      y2: pick.by + h + 1,
    };
    placed.push(finalBox);
    out.push({
      ...s,
      anchor: pick.anchor,
      tx:
        pick.anchor === 'middle'
          ? pick.bx + w / 2
          : pick.anchor === 'start'
            ? pick.bx
            : pick.bx + w,
      ty: pick.by + s.fontSize - 1,
    });
  }
  return out;
}

/**
 * Warstwa podpisów renderowana bezpośrednio w ScatterChart (recharts 3 pozwala
 * na dowolne dzieci): skale osi z hooków → piksele, jeden przebieg layoutu dla
 * odniesień i pozycji razem. Rozmiar kropki odtwarzamy z rangu ZAxis (pole px²).
 */
function RiskReturnLabels({
  points,
  refPoints,
}: {
  points: ScatterPoint[];
  refPoints: ScatterPoint[];
}) {
  const xScale = useXAxisScale();
  const yScale = useYAxisScale();
  const plot = usePlotArea();
  if (!xScale || !yScale || !plot) return null;

  const zs = points.map((p) => p.z);
  const zMin = Math.min(...zs);
  const zMax = Math.max(...zs);
  const areaOf = (z: number) => 60 + (340 * (z - zMin)) / (zMax - zMin || 1);

  // Odniesienia najpierw (kotwice wykresu — mają pierwszeństwo wyboru miejsca),
  // potem pozycje od największego udziału.
  const specs: LabelSpec[] = [
    ...refPoints.map((p) => ({
      text: p.ticker,
      cx: xScale(p.x) ?? 0,
      cy: yScale(p.y) ?? 0,
      r: Math.sqrt(360 / Math.PI),
      fontSize: 10,
      className: 'fill-foreground',
      fontWeight: 600,
    })),
    ...[...points]
      .sort((a, b) => b.z - a.z)
      .map((p) => ({
        text: p.ticker,
        cx: xScale(p.x) ?? 0,
        cy: yScale(p.y) ?? 0,
        r: Math.sqrt(areaOf(p.z) / Math.PI),
        fontSize: 9,
        className: 'fill-muted-foreground',
      })),
  ];

  return (
    <g pointerEvents="none">
      {layoutLabels(specs, plot).map((l) => (
        <text
          key={l.text}
          x={l.tx}
          y={l.ty}
          textAnchor={l.anchor}
          fontSize={l.fontSize}
          fontWeight={l.fontWeight}
          className={l.className}
        >
          {l.text}
        </text>
      ))}
    </g>
  );
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
              </Scatter>
            )}
            {/* Podpisy punktów — wspólna warstwa z layoutem kolizyjnym, nad kropkami */}
            <RiskReturnLabels points={points} refPoints={refPoints} />
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
