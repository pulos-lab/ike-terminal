import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useTheme } from '@/lib/use-theme';

interface Position {
  ticker: string;
  paperName: string;
  currentValuePln: number;
  currency: string;
  weight: number;
  exchange?: string;
  sector?: string;
  supersector?: string;
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
const EMBER_PALETTE_DARK = [
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

// Warm Parchment — żywe, ciepłe tony na jasnym tle
const EMBER_PALETTE_LIGHT = [
  '#d48a08', // amber (żywy, nie za jasny)
  '#c0654a', // rust (ciepły ceglasty)
  '#7da352', // sage (świeży zielony)
  '#9664a0', // plum (fioletowy)
  '#9e9590', // stone (ciepły szary)
  '#c8944a', // ochre (miodowy)
  '#5a9e96', // teal (morski)
  '#b89060', // tawny (karmelowy)
  '#a87da8', // mauve (lawendowy)
  '#7a9e68', // moss (oliwkowy)
];

// Paleta zależy od motywu — isDark przychodzi z useTheme(), żeby useMemo
// przeliczały kolory natychmiast po toggle dark/light (wcześniej czytaliśmy
// klasę DOM wewnątrz memo i kolory aktualizowały się dopiero przy
// niezwiązanym re-renderze).
function getEmberPalette(isDark: boolean) {
  return isDark ? EMBER_PALETTE_DARK : EMBER_PALETTE_LIGHT;
}

const REGION_MAP: Record<string, string> = {
  GPW: 'Polska',
  NC: 'Polska',
  NYSE: 'USA',
  NASDAQ: 'USA',
  TSX: 'Kanada',
  OTHER: 'Inne',
};

function groupBy(
  positions: Position[],
  keyFn: (p: Position) => string,
  colors: string[],
  _total: number,
): SliceData[] {
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

/** Dzielimy długą etykietę środkową (nazwę sektora) na 2 linie, żeby nie
 *  wychodziła poza wewnętrzny otwór donuta. Szukamy spacji najbliższej środka
 *  tekstu; dla jedno-wyrazowych nazw zostawiamy 1 linię. Próg 12 chars
 *  dopasowany empirycznie do innerR × 2 przy fontSize 11. */
function splitCenterLabel(text: string, maxPerLine = 12): [string, string | null] {
  if (text.length <= maxPerLine || !text.includes(' ')) return [text, null];
  const mid = Math.floor(text.length / 2);
  let bestIdx = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ' ') continue;
    if (bestIdx === -1 || Math.abs(i - mid) < Math.abs(bestIdx - mid)) bestIdx = i;
  }
  if (bestIdx === -1) return [text, null];
  return [text.slice(0, bestIdx), text.slice(bestIdx + 1)];
}

// SVG donut chart. Może być sterowany z zewnątrz (onHoverChange, onSliceClick)
// albo całkowicie wewnętrznie — zgodnie z użyciem w poszczególnych donutach.
interface DonutChartProps {
  data: SliceData[];
  size?: number;
  onHoverChange?: (idx: number | null) => void;
  onSliceClick?: (slice: SliceData) => void;
}

function DonutChart({ data, size = 160, onHoverChange, onSliceClick }: DonutChartProps) {
  const [hovered, setHoveredInner] = useState<number | null>(null);
  const setHovered = (idx: number | null) => {
    setHoveredInner(idx);
    onHoverChange?.(idx);
  };
  // Clamp hovered gdy data się skurczy (np. drill-down sektorów → mniej slice'ów)
  // — inaczej data[hovered] może być undefined i cały drzewko się wywala.
  useEffect(() => {
    if (hovered !== null && hovered >= data.length) {
      setHoveredInner(null);
      onHoverChange?.(null);
    }
  }, [data.length, hovered, onHoverChange]);
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size / 2 - 4;
  const innerR = outerR * 0.55;

  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

  // Bezpieczne odczytanie slice'a pod kursorem; undefined gdy hovered
  // out-of-bounds po rerenderze (efekt powyżej synchronicznie zresetuje
  // state, ale obecny render wciąż musi działać defensywnie).
  const hoveredSlice: SliceData | undefined =
    hovered !== null && hovered < data.length ? data[hovered] : undefined;

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
            data-slice-name={slice.name}
            fill={slice.color}
            fillRule={isFullCircle ? 'evenodd' : 'nonzero'}
            stroke="hsl(var(--card))"
            strokeWidth={2}
            opacity={hovered === null || hovered === idx ? 1 : 0.4}
            onMouseEnter={() => setHovered(idx)}
            onMouseLeave={() => setHovered(null)}
            onClick={() => onSliceClick?.(slice)}
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
      {/* Center text on hover — use Tailwind utility classes (fill-foreground /
          fill-muted-foreground) zamiast SVG attribute fill="hsl(var(...))",
          bo niektóre przeglądarki nie interpretują CSS vars w atrybucie SVG
          i fallback do czarnego powoduje znikanie tekstu w dark mode. */}
      {hoveredSlice &&
        (() => {
          const [line1, line2] = splitCenterLabel(hoveredSlice.name);
          // Rozmiar fontu zjedź do 10 gdy wciąż długo (np. "Przemysł elektromaszynowy"
          // wraz po podziale ma 13 chars w jednej linii).
          const maxLineLen = Math.max(line1.length, line2?.length ?? 0);
          const labelFontSize = maxLineLen > 13 ? 10 : 11;
          // Rozmieszczenie: 1 linia → nazwa na cy-6, pct na cy+10.
          // 2 linie → nazwa 1 na cy-12, nazwa 2 na cy+1, pct na cy+15.
          const nameY1 = line2 ? cy - 12 : cy - 6;
          const nameY2 = cy + 1;
          const pctY = line2 ? cy + 15 : cy + 10;
          return (
            <>
              <text
                x={cx}
                y={nameY1}
                textAnchor="middle"
                fontSize={labelFontSize}
                fontWeight={600}
                className="fill-foreground pointer-events-none"
              >
                {line1}
              </text>
              {line2 && (
                <text
                  x={cx}
                  y={nameY2}
                  textAnchor="middle"
                  fontSize={labelFontSize}
                  fontWeight={600}
                  className="fill-foreground pointer-events-none"
                >
                  {line2}
                </text>
              )}
              <text
                x={cx}
                y={pctY}
                textAnchor="middle"
                fontSize={10}
                className="fill-muted-foreground pointer-events-none"
              >
                {hoveredSlice.pct.toFixed(1)}%
              </text>
            </>
          );
        })()}
    </svg>
  );
}

function ChartLegend({ data }: { data: SliceData[] }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-2">
      {data.map((item, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <div
            className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
            style={{ backgroundColor: item.color }}
          />
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

/** Panel "Sektory" — donut z drill-downem (nadsektor → podsektory) oraz listą
 *  spółek pod wykresem, synchronizowaną z hoverem. */
function SectorsChart({
  positions,
  totalValuePln,
}: {
  positions: Position[];
  totalValuePln: number;
}) {
  const [drillSupersector, setDrillSupersector] = useState<string | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const { isDark } = useTheme();

  // Dane donuta: poziom 1 — wszystkie nadsektory; poziom 2 — podsektory wybranego
  // nadsektora (membership liczony po p.supersector === drillSupersector).
  const sectorData = useMemo(() => {
    if (drillSupersector === null) {
      return groupBy(
        positions,
        (p) => p.supersector || 'Inne',
        getEmberPalette(isDark),
        totalValuePln,
      );
    }
    const filtered = positions.filter((p) => (p.supersector || 'Inne') === drillSupersector);
    return groupBy(
      filtered,
      (p) => p.sector || 'Pozostałe',
      getEmberPalette(isDark),
      totalValuePln,
    );
  }, [positions, totalValuePln, drillSupersector, isDark]);

  // Spółki dopasowane do aktualnego kontekstu (hover lub drill-down).
  // Priorytet: hover > drill-down > nic.
  const visibleMembers = useMemo(() => {
    const hoveredSliceName = hoveredIdx !== null ? sectorData[hoveredIdx]?.name : null;
    if (hoveredSliceName) {
      // Hover: filtruj po aktualnym kluczu (nadsektor lub podsektor w zależności od poziomu).
      if (drillSupersector === null) {
        return positions.filter((p) => (p.supersector || 'Inne') === hoveredSliceName);
      }
      return positions.filter(
        (p) =>
          (p.supersector || 'Inne') === drillSupersector &&
          (p.sector || 'Pozostałe') === hoveredSliceName,
      );
    }
    if (drillSupersector !== null) {
      return positions.filter((p) => (p.supersector || 'Inne') === drillSupersector);
    }
    return [];
  }, [positions, sectorData, hoveredIdx, drillSupersector]);

  const membersSorted = useMemo(
    () => [...visibleMembers].sort((a, b) => b.currentValuePln - a.currentValuePln),
    [visibleMembers],
  );

  const listHeader = (() => {
    const hoveredName = hoveredIdx !== null ? sectorData[hoveredIdx]?.name : null;
    if (hoveredName) {
      return drillSupersector ? `${drillSupersector}: ${hoveredName}` : hoveredName;
    }
    if (drillSupersector) return drillSupersector;
    return 'Najedź na sektor, aby zobaczyć spółki';
  })();

  return (
    <Card>
      <CardHeader className="pb-1">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">Sektory</CardTitle>
          {drillSupersector && (
            <button
              type="button"
              onClick={() => {
                setDrillSupersector(null);
                setHoveredIdx(null);
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ← Wszystkie sektory
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pb-4">
        <DonutChart
          data={sectorData}
          onHoverChange={setHoveredIdx}
          onSliceClick={(slice) => {
            if (drillSupersector === null && slice.name !== 'Inne') {
              setDrillSupersector(slice.name);
              setHoveredIdx(null);
            }
          }}
        />
        <ChartLegend data={sectorData} />
        <div className="mt-3 border-t pt-2">
          <div className="text-xs font-medium text-muted-foreground mb-1.5">{listHeader}</div>
          {membersSorted.length > 0 ? (
            <ul className="space-y-0.5 max-h-40 overflow-y-auto pr-1">
              {membersSorted.map((p) => {
                const pct = totalValuePln > 0 ? (p.currentValuePln / totalValuePln) * 100 : 0;
                return (
                  <li
                    key={p.ticker + p.paperName}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="font-medium truncate max-w-[40%]" title={p.paperName}>
                      {p.ticker}
                    </span>
                    <span className="text-muted-foreground truncate flex-1" title={p.paperName}>
                      {p.paperName}
                    </span>
                    <span className="tabular-nums text-foreground">{pct.toFixed(1)}%</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="text-xs text-muted-foreground italic">
              {drillSupersector
                ? 'Brak spółek w tym sektorze.'
                : 'Kliknij w slice aby zobaczyć podsektory.'}
            </div>
          )}
        </div>
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
  const { isDark } = useTheme();
  const metrics = useMemo(() => {
    if (!positions.length) return null;

    const hhi = positions.reduce((s, p) => s + (p.weight / 100) ** 2, 0) * 10000;

    const sorted = [...positions].sort((a, b) => b.weight - a.weight);
    const top1 = sorted[0];
    const top5Weight = sorted.slice(0, 5).reduce((s, p) => s + p.weight, 0);

    // Liczymy liczbę unikalnych nadsektorów (Sektory u góry KPI = 8 jeżeli
    // portfel pokrywa wszystkie). Jeżeli nadsektor brak — fallback na "Inne".
    const supers = new Set(positions.map((p) => p.supersector || 'Inne'));
    const regions = new Set(positions.map((p) => REGION_MAP[p.exchange || ''] || 'Inne'));

    return {
      count: positions.length,
      hhi: Math.round(hhi),
      top1Ticker: top1.ticker,
      top1Weight: top1.weight.toFixed(1),
      top5Weight: top5Weight.toFixed(1),
      sectorCount: supers.size,
      regionCount: regions.size,
    };
  }, [positions]);

  const regionData = useMemo(
    () =>
      groupBy(
        positions,
        (p) => REGION_MAP[p.exchange || ''] || 'Inne',
        getEmberPalette(isDark),
        totalValuePln,
      ),
    [positions, totalValuePln, isDark],
  );

  const currencyData = useMemo(
    () => groupBy(positions, (p) => p.currency, getEmberPalette(isDark), totalValuePln),
    [positions, totalValuePln, isDark],
  );

  const topPositionsData = useMemo(() => {
    const palette = getEmberPalette(isDark);
    const sorted = [...positions].sort((a, b) => b.currentValuePln - a.currentValuePln);
    const top5: SliceData[] = sorted.slice(0, 5).map((p, i) => ({
      name: p.ticker,
      value: p.currentValuePln,
      pct: totalValuePln > 0 ? (p.currentValuePln / totalValuePln) * 100 : 0,
      color: palette[i],
    }));
    const restValue = sorted.slice(5).reduce((s, p) => s + p.currentValuePln, 0);
    if (restValue > 0) {
      top5.push({
        name: 'Pozostałe',
        value: restValue,
        pct: totalValuePln > 0 ? (restValue / totalValuePln) * 100 : 0,
        color: palette[5],
      });
    }
    return top5;
  }, [positions, totalValuePln, isDark]);

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
            <StatCard
              label="HHI"
              value={String(metrics.hhi)}
              sub={
                metrics.hhi < 1500
                  ? 'Zdywersyfikowany'
                  : metrics.hhi < 2500
                    ? 'Umiarkowany'
                    : 'Skoncentrowany'
              }
            />
            <StatCard label="Top 1" value={`${metrics.top1Weight}%`} sub={metrics.top1Ticker} />
            <StatCard label="Top 5" value={`${metrics.top5Weight}%`} sub="łącznie" />
          </div>
        </CardContent>
      </Card>

      {/* Pie charts 2x2 grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <DiversificationChart title="Regiony" data={regionData} />
        <DiversificationChart title="Waluty" data={currencyData} />
        <SectorsChart positions={positions} totalValuePln={totalValuePln} />
        <DiversificationChart title="Top pozycje" data={topPositionsData} />
      </div>
    </div>
  );
}
