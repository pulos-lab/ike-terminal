import { useEffect, useMemo, useState } from 'react';
import { Info } from 'lucide-react';
import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatPercent } from '@/lib/formatters';
import { chainLinkPct } from '@/lib/returns';
import { cn } from '@/lib/utils';

interface ChartDataPoint {
  date: string;
  portfolioValue: number;
  returnPct: number;
  twrPct: number;
  benchmarkValue: number;
  benchmarkReturnPct: number;
  benchmarkTwrPct: number;
  investedCumulative: number;
  cumulativeDepositsPln: number;
  cumulativeWithdrawalsPln: number;
}

interface Props {
  history: ChartDataPoint[];
  benchmarkLabel: string;
  showBenchmark?: boolean;
}

const MONTH_LABELS_PL = [
  'Sty',
  'Lut',
  'Mar',
  'Kwi',
  'Maj',
  'Cze',
  'Lip',
  'Sie',
  'Wrz',
  'Paź',
  'Lis',
  'Gru',
];

interface MonthlyRow {
  label: string;
  portfolio: number | null;
  benchmark: number | null;
}

// Monthly TWR is derived by chain-linking the cumulative TWR index:
// (1 + twrEnd/100) / (1 + twrStart/100) - 1
// This isolates market return from cash flows for each month.
function computeMonthlyReturns(history: ChartDataPoint[], year: number): MonthlyRow[] {
  const byMonth = new Map<number, ChartDataPoint[]>();
  for (const p of history) {
    const [yStr, mStr] = p.date.split('-');
    if (Number(yStr) === year) {
      const m = Number(mStr) - 1;
      const arr = byMonth.get(m);
      if (arr) arr.push(p);
      else byMonth.set(m, [p]);
    }
  }

  const rows: MonthlyRow[] = [];
  for (let m = 0; m < 12; m++) {
    const monthPoints = byMonth.get(m);
    if (!monthPoints || !monthPoints.length) {
      rows.push({ label: MONTH_LABELS_PL[m], portfolio: null, benchmark: null });
      continue;
    }
    const endPoint = monthPoints[monthPoints.length - 1];

    const monthStart = `${year}-${String(m + 1).padStart(2, '0')}-01`;
    let prevPoint: ChartDataPoint | null = null;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].date < monthStart) {
        prevPoint = history[i];
        break;
      }
    }

    const linked = (key: 'twrPct' | 'benchmarkTwrPct'): number => {
      const endVal = endPoint[key];
      if (!prevPoint) return endVal;
      return chainLinkPct(endVal, prevPoint[key]);
    };

    rows.push({
      label: MONTH_LABELS_PL[m],
      portfolio: linked('twrPct'),
      benchmark: linked('benchmarkTwrPct'),
    });
  }

  return rows;
}

function getAvailableYears(history: ChartDataPoint[]): number[] {
  if (!history.length) return [];
  const first = Number(history[0].date.slice(0, 4));
  const last = Number(history[history.length - 1].date.slice(0, 4));
  const years: number[] = [];
  for (let y = last; y >= first; y--) years.push(y);
  return years;
}

function compoundYtd(rows: MonthlyRow[], key: 'portfolio' | 'benchmark'): number | null {
  let cum = 1;
  let count = 0;
  for (const r of rows) {
    const v = r[key];
    if (v !== null) {
      cum *= 1 + v / 100;
      count++;
    }
  }
  return count ? (cum - 1) * 100 : null;
}

interface HeatmapYearRow {
  year: number;
  months: MonthlyRow[];
  annual: number | null;
  annualBenchmark: number | null;
}

/** Tło komórki heatmapy: gain/loss z kryciem skalowanym wielkością zwrotu.
 *  Clamp na ±8% — powyżej kolor jest już pełny, żeby pojedynczy ekstremalny
 *  miesiąc nie spłaszczał wizualnie całej reszty siatki. */
function heatCellBackground(value: number | null): string | undefined {
  if (value === null) return undefined;
  const intensity = Math.min(Math.abs(value) / 8, 1);
  const mixPct = Math.round(10 + intensity * 55);
  const colorVar = value >= 0 ? 'var(--gain)' : 'var(--loss)';
  return `color-mix(in srgb, ${colorVar} ${mixPct}%, transparent)`;
}

function HeatCell({
  value,
  benchmark,
  benchmarkLabel,
  monthLabel,
  year,
  emphasis,
  className,
}: {
  value: number | null;
  benchmark: number | null;
  benchmarkLabel: string;
  monthLabel: string;
  year: number;
  emphasis?: boolean;
  className?: string;
}) {
  const fmt = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  // Natywny title zamiast Radix Tooltip — siatka ma ~100+ komórek,
  // montowanie tylu triggerów jest zbędnym kosztem.
  const title =
    value === null
      ? `${monthLabel} ${year}: brak danych`
      : `${monthLabel} ${year} · Portfel: ${fmt(value)}${
          benchmarkLabel && benchmark !== null ? ` · ${benchmarkLabel}: ${fmt(benchmark)}` : ''
        }`;
  return (
    <td
      title={title}
      className={cn(
        'px-1 py-1.5 text-center tabular-nums rounded-sm',
        value === null && 'text-muted-foreground/50',
        emphasis && 'font-semibold',
        className,
      )}
      style={{ backgroundColor: heatCellBackground(value) }}
    >
      {value === null ? '·' : fmt(value)}
    </td>
  );
}

/** Widok „Mapa" — siatka lata × miesiące (heatmapa) + kolumna zwrotu rocznego. */
function MonthlyHeatmap({
  rows,
  benchmarkLabel,
}: {
  rows: HeatmapYearRow[];
  benchmarkLabel: string;
}) {
  return (
    <div className="overflow-x-auto -mx-6 px-6">
      <table className="w-full min-w-[640px] border-separate border-spacing-0.5 text-[11px]">
        <thead>
          <tr className="text-muted-foreground">
            <th className="px-1 py-1 text-left font-semibold">Rok</th>
            {MONTH_LABELS_PL.map((m) => (
              <th key={m} className="px-1 py-1 text-center font-semibold">
                {m}
              </th>
            ))}
            <th className="px-1 py-1 text-center font-semibold border-l border-border">Rok</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ year, months, annual, annualBenchmark }) => (
            <tr key={year}>
              <td className="px-1 py-1.5 font-semibold tabular-nums text-muted-foreground">
                {year}
              </td>
              {months.map((m) => (
                <HeatCell
                  key={m.label}
                  value={m.portfolio}
                  benchmark={m.benchmark}
                  benchmarkLabel={benchmarkLabel}
                  monthLabel={m.label}
                  year={year}
                />
              ))}
              <HeatCell
                value={annual}
                benchmark={annualBenchmark}
                benchmarkLabel={benchmarkLabel}
                monthLabel="Cały rok"
                year={year}
                emphasis
                className="border-l border-border"
              />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface TooltipPayloadItem {
  dataKey: string;
  value: number | null;
  payload: MonthlyRow;
}

function ChartTooltip({
  active,
  payload,
  benchmarkLabel,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  benchmarkLabel: string;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const portfolio = row.portfolio;
  const benchmark = row.benchmark;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="font-semibold mb-1">{row.label}</p>
      <p className="tabular-nums">
        <span className="text-muted-foreground">Portfel: </span>
        <span
          className={
            portfolio === null
              ? 'text-muted-foreground'
              : portfolio >= 0
                ? 'text-gain'
                : 'text-loss'
          }
        >
          {portfolio === null ? '—' : formatPercent(portfolio)}
        </span>
      </p>
      {benchmarkLabel && (
        <p className="tabular-nums">
          <span className="text-muted-foreground">{benchmarkLabel}: </span>
          <span
            className={
              benchmark === null
                ? 'text-muted-foreground'
                : benchmark >= 0
                  ? 'text-gain'
                  : 'text-loss'
            }
          >
            {benchmark === null ? '—' : formatPercent(benchmark)}
          </span>
        </p>
      )}
    </div>
  );
}

export function MonthlyReturnsChart({ history, benchmarkLabel, showBenchmark = false }: Props) {
  const years = useMemo(() => getAvailableYears(history), [history]);
  const [year, setYear] = useState<number>(() => years[0] ?? new Date().getFullYear());
  const [view, setView] = useState<'bars' | 'heatmap'>('bars');

  // Re-anchor selected year if portfolio/history changes such that it's no longer in range.
  useEffect(() => {
    if (years.length && !years.includes(year)) {
      setYear(years[0]);
    }
  }, [years, year]);

  const monthly = useMemo(() => computeMonthlyReturns(history, year), [history, year]);

  const ytdPortfolio = useMemo(() => compoundYtd(monthly, 'portfolio'), [monthly]);
  const ytdBenchmark = useMemo(() => compoundYtd(monthly, 'benchmark'), [monthly]);

  // Widok „Mapa": wszystkie lata naraz + zwrot roczny (chain-link miesięcy).
  const heatmapRows = useMemo<HeatmapYearRow[]>(
    () =>
      years.map((y) => {
        const months = computeMonthlyReturns(history, y);
        return {
          year: y,
          months,
          annual: compoundYtd(months, 'portfolio'),
          annualBenchmark: compoundYtd(months, 'benchmark'),
        };
      }),
    [history, years],
  );

  if (!history.length || !years.length) return null;

  const positive = monthly.filter((r) => r.portfolio !== null && r.portfolio > 0).length;
  const negative = monthly.filter((r) => r.portfolio !== null && r.portfolio < 0).length;
  const hasAnyData = monthly.some((r) => r.portfolio !== null);

  return (
    <Card>
      <CardHeader className="pb-2">
        <TooltipProvider>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <CardTitle className="text-sm font-semibold">Zwrot miesiąc po miesiącu</CardTitle>
              <UITooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 cursor-help text-muted-foreground/60 hover:text-muted-foreground transition-colors" />
                </TooltipTrigger>
                <TooltipContent className="max-w-[280px] text-xs">
                  Time-Weighted Return dla każdego miesiąca — eliminuje wpływ wpłat/wypłat, pokazuje
                  czysty rynkowy zwrot portfela w danym miesiącu.
                </TooltipContent>
              </UITooltip>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              {view === 'bars' && hasAnyData && (
                <div className="flex items-center gap-3 text-xs tabular-nums">
                  <span className="text-muted-foreground">
                    YTD:{' '}
                    <span
                      className={cn(
                        'font-semibold',
                        ytdPortfolio === null
                          ? 'text-muted-foreground'
                          : ytdPortfolio >= 0
                            ? 'text-gain'
                            : 'text-loss',
                      )}
                    >
                      {ytdPortfolio === null ? '—' : formatPercent(ytdPortfolio)}
                    </span>
                  </span>
                  {showBenchmark && ytdBenchmark !== null && (
                    <span className="text-muted-foreground">
                      {benchmarkLabel}:{' '}
                      <span
                        className={cn(
                          'font-semibold',
                          ytdBenchmark >= 0 ? 'text-gain' : 'text-loss',
                        )}
                      >
                        {formatPercent(ytdBenchmark)}
                      </span>
                    </span>
                  )}
                  <span className="text-muted-foreground">
                    <span className="text-gain font-semibold">{positive}</span>
                    {' / '}
                    <span className="text-loss font-semibold">{negative}</span>
                  </span>
                </div>
              )}

              {view === 'bars' && (
                <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
                  <SelectTrigger size="sm" className="h-8 text-xs w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {years.map((y) => (
                      <SelectItem key={y} value={String(y)}>
                        {y}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* Przełącznik widoku — segment jak MWR/TWR na wykresie głównym */}
              <div className="flex items-center rounded-md bg-muted p-0.5">
                <button
                  className={cn(
                    'px-2 py-0.5 rounded text-xs font-medium transition-colors',
                    view === 'bars' ? 'bg-background text-foreground' : 'text-muted-foreground',
                  )}
                  onClick={() => setView('bars')}
                >
                  Słupki
                </button>
                <button
                  className={cn(
                    'px-2 py-0.5 rounded text-xs font-medium transition-colors',
                    view === 'heatmap' ? 'bg-background text-foreground' : 'text-muted-foreground',
                  )}
                  onClick={() => setView('heatmap')}
                >
                  Mapa
                </button>
              </div>
            </div>
          </div>
        </TooltipProvider>
      </CardHeader>

      <CardContent>
        {view === 'heatmap' ? (
          <MonthlyHeatmap rows={heatmapRows} benchmarkLabel={showBenchmark ? benchmarkLabel : ''} />
        ) : hasAnyData ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart
              data={monthly}
              margin={{ top: 16, right: 8, bottom: 0, left: 0 }}
              accessibilityLayer
              aria-label="Miesięczne stopy zwrotu portfela"
            >
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                axisLine={{ stroke: 'var(--border)' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                width={44}
              />
              <ReferenceLine y={0} stroke="var(--border)" />
              <Tooltip
                cursor={{ fill: 'var(--primary)', fillOpacity: 0.06 }}
                content={<ChartTooltip benchmarkLabel={showBenchmark ? benchmarkLabel : ''} />}
              />
              <Bar dataKey="portfolio" radius={[4, 4, 0, 0]} maxBarSize={48}>
                {monthly.map((row, idx) => (
                  <Cell
                    key={idx}
                    fill={
                      row.portfolio === null
                        ? 'var(--muted)'
                        : row.portfolio >= 0
                          ? 'var(--gain)'
                          : 'var(--loss)'
                    }
                    fillOpacity={row.portfolio === null ? 0.3 : 1}
                  />
                ))}
                <LabelList
                  dataKey="portfolio"
                  position="top"
                  className="fill-foreground"
                  fontSize={10}
                  formatter={(v) => {
                    if (v === null || v === undefined) return '';
                    const n = typeof v === 'number' ? v : Number(v);
                    if (!Number.isFinite(n)) return '';
                    return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
                  }}
                />
              </Bar>
              {showBenchmark && (
                <Bar dataKey="benchmark" radius={[4, 4, 0, 0]} maxBarSize={48} fillOpacity={0.45}>
                  {monthly.map((row, idx) => (
                    <Cell
                      key={`b-${idx}`}
                      fill={
                        row.benchmark === null
                          ? 'var(--muted)'
                          : row.benchmark >= 0
                            ? 'var(--gain)'
                            : 'var(--loss)'
                      }
                      stroke="var(--muted-foreground)"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                    />
                  ))}
                </Bar>
              )}
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
            Brak danych dla wybranego roku.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
