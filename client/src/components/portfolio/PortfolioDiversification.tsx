import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface Position {
  ticker: string;
  paperName: string;
  currentValuePln: number;
  currency: string;
  weight: number;
  exchange?: string;
  sector?: string;
}

interface Props {
  positions: Position[];
  totalValuePln: number;
}

interface SliceData {
  name: string;
  value: number;
  pct: number;
  color: string;
}

// Ember palette — warm tones harmonizujące z amber #f59e0b
// amber → rust → sage → plum → stone → ochre
const EMBER_PALETTE = [
  '#f59e0b', // amber (primary)
  '#c46a4e', // rust
  '#a3b96c', // sage
  '#8b5a8f', // plum
  '#a8a29e', // stone
  '#d4a574', // ochre
  '#6b8e8a', // slate teal
  '#b08968', // tawny
  '#9a7b9a', // mauve
  '#87a27a', // moss
];

const REGION_COLORS = EMBER_PALETTE;
const CURRENCY_COLORS = EMBER_PALETTE;
const SECTOR_COLORS = EMBER_PALETTE;
const TOP_COLORS = EMBER_PALETTE;

const REGION_MAP: Record<string, string> = {
  GPW: 'Polska',
  NC: 'Polska',
  NYSE: 'USA',
  NASDAQ: 'USA',
  TSX: 'Kanada',
  OTHER: 'Inne',
};

function groupBy(positions: Position[], keyFn: (p: Position) => string, colors: string[], _total: number): SliceData[] {
  const map = new Map<string, number>();
  for (const pos of positions) {
    const key = keyFn(pos);
    map.set(key, (map.get(key) || 0) + pos.currentValuePln);
  }
  // Percent każdego slice'a względem SUMY SLICES (suma positions), żeby pie chart summował się do 100%.
  // Wcześniejsze `value/totalValuePln` dawało mniejsze liczby gdy total zawierał cash, co powodowało
  // że legendy nie sumowały się do 100% i pojedyncze slice'y wyglądały na niepełne.
  const sliceTotal = Array.from(map.values()).reduce((s, v) => s + v, 0);
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, value], i) => ({
      name,
      value,
      pct: sliceTotal > 0 ? (value / sliceTotal) * 100 : 0,
      color: colors[i % colors.length],
    }));
}

// SVG donut chart
function DonutChart({ data, size = 160 }: { data: SliceData[]; size?: number }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - 4;
  const innerR = outerR * 0.55;

  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

  // Build arc paths. SVG arc z start == end (pełne koło, np. pojedynczy slice 100%) degeneruje,
  // dlatego clampujemy angle do Math.PI * 2 - 0.001 i — jeśli slice jest faktycznie pełnym kołem —
  // składamy go z dwóch półłuków.
  let cumAngle = -Math.PI / 2; // start from top
  const EPSILON = 0.0001;
  const TWO_PI = Math.PI * 2;
  const arcs = data.map((slice, i) => {
    const rawAngle = (slice.value / total) * TWO_PI;
    const angle = Math.min(rawAngle, TWO_PI - EPSILON);
    const startAngle = cumAngle;
    const endAngle = cumAngle + angle;
    cumAngle = endAngle;

    const isFullCircle = rawAngle >= TWO_PI - EPSILON;
    const largeArc = angle > Math.PI ? 1 : 0;

    const x1Outer = cx + outerR * Math.cos(startAngle);
    const y1Outer = cy + outerR * Math.sin(startAngle);
    const x2Outer = cx + outerR * Math.cos(endAngle);
    const y2Outer = cy + outerR * Math.sin(endAngle);

    const x1Inner = cx + innerR * Math.cos(endAngle);
    const y1Inner = cy + innerR * Math.sin(endAngle);
    const x2Inner = cx + innerR * Math.cos(startAngle);
    const y2Inner = cy + innerR * Math.sin(startAngle);

    // Dla 100% używamy dwóch półłuków (outer i inner circles) zamiast path z start==end
    const d = isFullCircle
      ? [
          `M ${cx} ${cy - outerR}`,
          `A ${outerR} ${outerR} 0 1 1 ${cx} ${cy + outerR}`,
          `A ${outerR} ${outerR} 0 1 1 ${cx} ${cy - outerR}`,
          `M ${cx} ${cy - innerR}`,
          `A ${innerR} ${innerR} 0 1 0 ${cx} ${cy + innerR}`,
          `A ${innerR} ${innerR} 0 1 0 ${cx} ${cy - innerR}`,
          'Z',
        ].join(' ')
      : [
          `M ${x1Outer} ${y1Outer}`,
          `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2Outer} ${y2Outer}`,
          `L ${x1Inner} ${y1Inner}`,
          `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x2Inner} ${y2Inner}`,
          'Z',
        ].join(' ');

    // Label position at middle of arc
    const midAngle = startAngle + angle / 2;
    const labelR = innerR + (outerR - innerR) / 2;
    const lx = cx + labelR * Math.cos(midAngle);
    const ly = cy + labelR * Math.sin(midAngle);

    return { d, midAngle, lx, ly, slice, idx: i, angle, isFullCircle };
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mx-auto">
      {arcs.map(({ d, lx, ly, slice, idx, angle, isFullCircle }) => (
        <g key={idx}>
          <path
            d={d}
            fill={slice.color}
            fillRule={isFullCircle ? 'evenodd' : 'nonzero'}
            stroke="hsl(var(--card))"
            strokeWidth={2}
            opacity={hovered === null || hovered === idx ? 1 : 0.4}
            onMouseEnter={() => setHovered(idx)}
            onMouseLeave={() => setHovered(null)}
            className="transition-opacity duration-150 cursor-pointer"
          />
          {angle > 0.35 && (
            <text
              x={lx}
              y={ly}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={11}
              fontWeight={600}
              className="fill-foreground pointer-events-none"
            >
              {slice.pct.toFixed(0)}%
            </text>
          )}
        </g>
      ))}
      {/* Center text on hover */}
      {hovered !== null && (
        <>
          <text x={cx} y={cy - 6} textAnchor="middle" fill="hsl(var(--foreground))" fontSize={11} fontWeight={600}>
            {data[hovered].name}
          </text>
          <text x={cx} y={cy + 10} textAnchor="middle" fill="hsl(var(--muted-foreground))" fontSize={10}>
            {data[hovered].pct.toFixed(1)}%
          </text>
        </>
      )}
    </svg>
  );
}

function ChartLegend({ data }: { data: SliceData[] }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-2">
      {data.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: item.color }} />
          <span>{item.name}</span>
          <span className="font-medium text-foreground">{item.pct.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

function DiversificationChart({ title, data }: { title: string; data: SliceData[] }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        <DonutChart data={data} />
        <ChartLegend data={data} />
      </CardContent>
    </Card>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3 text-center">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="text-lg font-bold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

export function PortfolioDiversification({ positions, totalValuePln }: Props) {
  const metrics = useMemo(() => {
    if (!positions.length) return null;

    const hhi = positions.reduce((s, p) => s + (p.weight / 100) ** 2, 0) * 10000;

    const sorted = [...positions].sort((a, b) => b.weight - a.weight);
    const top1 = sorted[0];
    const top5Weight = sorted.slice(0, 5).reduce((s, p) => s + p.weight, 0);

    const sectors = new Set(positions.map(p => p.sector).filter(Boolean));
    const regions = new Set(positions.map(p => REGION_MAP[p.exchange || ''] || 'Inne'));

    return {
      count: positions.length,
      hhi: Math.round(hhi),
      top1Ticker: top1.ticker,
      top1Weight: top1.weight.toFixed(1),
      top5Weight: top5Weight.toFixed(1),
      sectorCount: sectors.size,
      regionCount: regions.size,
    };
  }, [positions]);

  const regionData = useMemo(
    () => groupBy(positions, p => REGION_MAP[p.exchange || ''] || 'Inne', REGION_COLORS, totalValuePln),
    [positions, totalValuePln]
  );

  const currencyData = useMemo(
    () => groupBy(positions, p => p.currency, CURRENCY_COLORS, totalValuePln),
    [positions, totalValuePln]
  );

  const sectorData = useMemo(
    () => groupBy(positions, p => p.sector || 'Inne', SECTOR_COLORS, totalValuePln),
    [positions, totalValuePln]
  );

  const topPositionsData = useMemo(() => {
    const sorted = [...positions].sort((a, b) => b.currentValuePln - a.currentValuePln);
    const top5: SliceData[] = sorted.slice(0, 5).map((p, i) => ({
      name: p.ticker,
      value: p.currentValuePln,
      pct: totalValuePln > 0 ? (p.currentValuePln / totalValuePln) * 100 : 0,
      color: TOP_COLORS[i],
    }));
    const restValue = sorted.slice(5).reduce((s, p) => s + p.currentValuePln, 0);
    if (restValue > 0) {
      top5.push({
        name: 'Pozostałe',
        value: restValue,
        pct: totalValuePln > 0 ? (restValue / totalValuePln) * 100 : 0,
        color: TOP_COLORS[5],
      });
    }
    return top5;
  }, [positions, totalValuePln]);

  if (!metrics) return null;

  return (
    <div className="space-y-4">
      {/* Portfolio parameters */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Parametry portfela</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            <StatCard label="Pozycje" value={String(metrics.count)} />
            <StatCard label="Sektory" value={String(metrics.sectorCount)} />
            <StatCard label="Rynki" value={String(metrics.regionCount)} />
            <StatCard label="HHI" value={String(metrics.hhi)} sub={metrics.hhi < 1500 ? 'Zdywersyfikowany' : metrics.hhi < 2500 ? 'Umiarkowany' : 'Skoncentrowany'} />
            <StatCard label="Top 1" value={`${metrics.top1Weight}%`} sub={metrics.top1Ticker} />
            <StatCard label="Top 5" value={`${metrics.top5Weight}%`} sub="łącznie" />
          </div>
        </CardContent>
      </Card>

      {/* Pie charts 2x2 grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DiversificationChart title="Regiony" data={regionData} />
        <DiversificationChart title="Waluty" data={currencyData} />
        <DiversificationChart title="Sektory" data={sectorData} />
        <DiversificationChart title="Top pozycje" data={topPositionsData} />
      </div>
    </div>
  );
}
