import { useMemo, useState, type ComponentProps } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Badge } from '@/components/ui/badge';
import { errorToast } from '@/lib/error-toast';
import { QUERY_KEYS, invalidateDividends } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { CcyChip } from '@/components/ui/ccy-chip';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { AddDividendDialog } from './AddDividendDialog';
import {
  formatNumber,
  formatDate,
  formatPercent,
  formatPLN,
  formatQuantity,
  formatCurrency,
} from '@/lib/formatters';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import {
  Tooltip as UITooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  groupDividendsByMonthAndCurrency,
  groupDividendsByYearAndCurrency,
} from '@/lib/dividends-yearly';
import { computeYieldOnCost } from '@/lib/yield-on-cost';
import { cn } from '@/lib/utils';
import { Loader2, Info, Plus, Pencil, Trash2, RefreshCw, Calendar, Clock } from 'lucide-react';
import { toast } from 'sonner';
import { ExpandableCard, ExpandableCardSubRow } from '@/components/ui/expandable-card';
import { useToggleSet } from '@/hooks/useToggleSet';
import { useSortableData } from '@/hooks/useSortableData';
import type { DividendRecord, UpcomingDividend } from 'shared';
import { formatDividendDescription } from '@/lib/dividend-description';

type BadgeVariant = ComponentProps<typeof Badge>['variant'];

/** Badge "Kupon" — odróżnia kupon obligacji (subkind='coupon') od dywidendy spółki. */
function CouponBadge({ subkind }: { subkind?: string }) {
  if (subkind !== 'coupon') return null;
  return <Badge variant="info">Kupon</Badge>;
}

const SOURCE_LABELS: Record<string, { label: string; variant: BadgeVariant }> = {
  'auto-yahoo': { label: 'Auto', variant: 'info' },
  manual: { label: 'Ręczne', variant: 'muted' },
  bossa: { label: 'Bossa', variant: 'warning' },
  mbank: { label: 'mBank', variant: 'warning' },
  degiro: { label: 'DEGIRO', variant: 'warning' },
  xtb: { label: 'XTB', variant: 'warning' },
};

function SourceBadge({ source }: { source: string }) {
  const info = SOURCE_LABELS[source] || { label: source, variant: 'muted' as BadgeVariant };
  return <Badge variant={info.variant}>{info.label}</Badge>;
}

function StatusBadge({ exDate, payDate }: { exDate: string; payDate: string | null }) {
  const today = new Date().toISOString().split('T')[0];
  if (exDate > today) {
    return <Badge variant="warning">Nadchodzi</Badge>;
  }
  if (payDate && payDate >= today) {
    return <Badge variant="info">Oczekuje wypłaty</Badge>;
  }
  return null;
}

// Status uchwały z kalendarza GPW (stockwatch/biznesradar) — tylko dla wpisów,
// które go mają (źródło 'gpw-calendar'); Yahoo nie dostarcza statusu.
const CALENDAR_STATUS_VARIANTS: Record<string, BadgeVariant> = {
  proponowana: 'muted',
  uchwalona: 'success',
};

function CalendarStatusPill({ status }: { status?: string }) {
  if (!status || !CALENDAR_STATUS_VARIANTS[status]) return null;
  return <Badge variant={CALENDAR_STATUS_VARIANTS[status]}>{status}</Badge>;
}

// ============ Upcoming Dividends Panel ============

function UpcomingDividendCardMobile({ d }: { d: UpcomingDividend }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ExpandableCard
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      expandedClassName="gap-1"
      headerLeft={
        <>
          <span className="font-mono font-semibold text-sm truncate">{d.ticker}</span>
          <CcyChip ccy={d.currency} />
        </>
      }
      headerRight={
        <span className="font-semibold text-sm tabular-nums text-gain shrink-0">
          {d.estimatedAmount > 0 ? formatNumber(d.estimatedAmount) : '—'}
        </span>
      }
      subHeader={
        <ExpandableCardSubRow>
          <span className="text-muted-foreground tabular-nums truncate">
            ex: {formatDate(d.exDividendDate)} · {formatQuantity(d.shares)} szt.
          </span>
          <span className="inline-flex items-center gap-1">
            <CalendarStatusPill status={d.status} />
            <StatusBadge exDate={d.exDividendDate} payDate={d.paymentDate} />
          </span>
        </ExpandableCardSubRow>
      }
    >
      <div className="flex justify-between gap-3 items-baseline">
        <span className="text-muted-foreground">Nazwa</span>
        <span className="text-right">{d.name}</span>
      </div>
      <div className="flex justify-between gap-3 items-baseline">
        <span className="text-muted-foreground">Data wypłaty</span>
        <span className="tabular-nums text-right">
          {d.paymentDate ? formatDate(d.paymentDate) : '—'}
        </span>
      </div>
      <div className="flex justify-between gap-3 items-baseline">
        <span className="text-muted-foreground">Stopa dywidendy</span>
        <span className="tabular-nums text-right">
          {d.dividendYield !== null ? formatPercent(d.dividendYield).replace('+', '') : '—'}
        </span>
      </div>
    </ExpandableCard>
  );
}

function UpcomingDividendsPanel() {
  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.upcomingDividends,
    queryFn: api.getUpcomingDividends,
    staleTime: 5 * 60 * 1000, // 5 min
  });

  const upcoming = data?.upcoming || [];
  const {
    sorted: sortedUpcoming,
    sortKey: upcomingSortKey,
    dir: upcomingDir,
    toggle: toggleUpcomingSort,
  } = useSortableData(upcoming);

  if (isLoading) return <LoadingSpinner />;
  if (upcoming.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Calendar className="h-4 w-4" />
          Nadchodzące dywidendy
          <span className="text-muted-foreground font-normal">({upcoming.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="md:hidden flex flex-col gap-2">
          {upcoming.map((d: UpcomingDividend) => (
            <UpcomingDividendCardMobile key={d.ticker} d={d} />
          ))}
        </div>
        <div className="hidden md:block overflow-x-auto scroll-shadow-x">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead
                  label="Ticker"
                  active={upcomingSortKey === 'ticker'}
                  dir={upcomingDir}
                  onToggle={() => toggleUpcomingSort('ticker')}
                />
                <TableHead>Nazwa</TableHead>
                <SortableTableHead
                  label="Ex-date"
                  active={upcomingSortKey === 'exDividendDate'}
                  dir={upcomingDir}
                  onToggle={() => toggleUpcomingSort('exDividendDate')}
                />
                <TableHead>Data wypłaty</TableHead>
                <TableHead>Akcje</TableHead>
                <SortableTableHead
                  label="Szac. kwota"
                  align="right"
                  active={upcomingSortKey === 'estimatedAmount'}
                  dir={upcomingDir}
                  onToggle={() => toggleUpcomingSort('estimatedAmount')}
                />
                <SortableTableHead
                  label="Stopa"
                  align="right"
                  active={upcomingSortKey === 'dividendYield'}
                  dir={upcomingDir}
                  onToggle={() => toggleUpcomingSort('dividendYield')}
                />
                <TableHead>Waluta</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedUpcoming.map((d: UpcomingDividend) => (
                <TableRow key={d.ticker}>
                  <TableCell className="font-mono font-medium">{d.ticker}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{d.name}</TableCell>
                  <TableCell>{formatDate(d.exDividendDate)}</TableCell>
                  <TableCell>{d.paymentDate ? formatDate(d.paymentDate) : '—'}</TableCell>
                  <TableCell>{formatQuantity(d.shares)}</TableCell>
                  <TableCell className="text-right font-medium text-gain tabular-nums">
                    {d.estimatedAmount > 0 ? formatNumber(d.estimatedAmount) : '—'}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {d.dividendYield !== null
                      ? formatPercent(d.dividendYield).replace('+', '')
                      : '—'}
                  </TableCell>
                  <TableCell>
                    <CcyChip ccy={d.currency} />
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1">
                      <CalendarStatusPill status={d.status} />
                      <StatusBadge exDate={d.exDividendDate} payDate={d.paymentDate} />
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ============ Stat tiles ============

/** Kafel statystyki dywidendowej — wzorzec wizualny StatTile z PerformanceStats. */
function DivStatTile({
  label,
  value,
  subtext,
  tooltip,
}: {
  label: string;
  value: string;
  subtext?: string;
  tooltip?: React.ReactNode;
}) {
  const content = (
    <div className="rounded-xl bg-card border border-border px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 flex items-center gap-1">
        {label}
        {tooltip && <Info className="h-3 w-3 text-muted-foreground/60" />}
      </p>
      <p className="text-base font-bold tabular-nums tracking-tight text-gain">{value}</p>
      {subtext && (
        <p className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">{subtext}</p>
      )}
    </div>
  );

  if (!tooltip) return content;
  return (
    <UITooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent className="max-w-[320px] text-xs leading-relaxed">{tooltip}</TooltipContent>
    </UITooltip>
  );
}

// ============ Main Page ============

export function DividendsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.dividends,
    queryFn: api.getDividends,
  });

  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<DividendRecord | null>(null);
  const [deleting, setDeleting] = useState<DividendRecord | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteDividend(id),
    onSuccess: (_, id) => {
      invalidateDividends(queryClient);
      const d = deleting;
      if (d && d.id === id) {
        toast.success(
          `Usunięto dywidendę ${d.ticker} — ${formatCurrency(d.amount, d.currency)} z ${formatDate(d.date)}`,
        );
      } else {
        toast.success('Usunięto dywidendę.');
      }
      setDeleting(null);
    },
    onError: (e: Error) => errorToast('Nie udało się usunąć', e),
  });

  const scanMutation = useMutation({
    mutationFn: () => api.scanDividends(),
    onSuccess: (result) => {
      invalidateDividends(queryClient);
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.upcomingDividends });
      if (result.newDividends > 0) {
        toast.success(
          `Znaleziono ${result.newDividends} nowych dywidend (przeskanowano ${result.scanned} tickerów)`,
        );
      } else {
        toast.info(`Brak nowych dywidend (przeskanowano ${result.scanned} tickerów)`);
      }
      for (const w of (result.warnings ?? []).slice(0, 3)) {
        toast.warning(w, { duration: 10000 });
      }
    },
    onError: (e: Error) => errorToast('Skan nie powiódł się', e),
  });

  const dividends: DividendRecord[] = data?.dividends || [];
  const [expandedHistory, toggleHistory] = useToggleSet<number>();
  const {
    sorted: sortedDividends,
    sortKey: histSortKey,
    dir: histDir,
    toggle: toggleHistSort,
  } = useSortableData(dividends);

  // Rozpiętość historii wypłat (pełne miesiące od pierwszej dywidendy) — decyduje
  // o tym, co ma sens pokazać: dla świeżego portfela okno 12M zaniża średnią, a
  // wykres roczny ma jeden słupek.
  const monthsCovered = useMemo(() => {
    if (!dividends.length) return 0;
    const first = dividends.reduce(
      (min, d) => (d.date.slice(0, 10) < min ? d.date.slice(0, 10) : min),
      dividends[0].date.slice(0, 10),
    );
    const [fy, fm] = first.split('-').map(Number);
    const now = new Date();
    const elapsed = (now.getFullYear() - fy) * 12 + (now.getMonth() + 1 - fm) + 1;
    return Math.max(1, elapsed);
  }, [dividends]);
  const hasFullYear = monthsCovered >= 12;

  // Sumy per waluta (stacked bars) — słupki celowo w walutach oryginalnych
  // (mieszanie walut w jednym słupku PLN zaciemniałoby strukturę wypłat).
  const yearlyGrouped = useMemo(() => groupDividendsByYearAndCurrency(dividends), [dividends]);
  const monthlyGrouped = useMemo(() => groupDividendsByMonthAndCurrency(dividends), [dividends]);

  // Jeden rok historii = jeden słupek, więc widok roczny wymaga ≥2 lat. `null` =
  // auto (wybór z danych); dopiero klik użytkownika utrwala tryb. Bez efektu —
  // efekt odpalałby się na pustej liście podczas ładowania i zostawiał miesiące.
  const canShowYearly = yearlyGrouped.rows.length >= 2;
  const [chartPeriod, setChartPeriod] = useState<'year' | 'month' | null>(null);
  const showYearly =
    (chartPeriod ?? (canShowYearly ? 'year' : 'month')) === 'year' && canShowYearly;
  const { rows: chartData, currencies: chartCurrencies } = showYearly
    ? yearlyGrouped
    : monthlyGrouped;

  // Yield on cost: dywidendy 12M (amountPln + isin anotowane przez backend)
  // vs koszt nabycia otwartych pozycji.
  const { data: positionsData } = useQuery({
    queryKey: QUERY_KEYS.positions,
    queryFn: api.getPositions,
    staleTime: 5 * 60 * 1000,
  });
  const yoc = useMemo(() => {
    if (!dividends.length || !positionsData?.positions?.length) return null;
    const today = new Date().toISOString().slice(0, 10);
    return computeYieldOnCost(dividends, positionsData.positions, today);
  }, [dividends, positionsData]);

  // Suma WSZYSTKICH dywidend z okna 12M (także ze sprzedanych pozycji — inaczej
  // niż licznik YoC) — do kafli „Ostatnie 12 mies." i „Śr. miesięcznie".
  const last12m = useMemo(() => {
    const ttmStart = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    let sumPln = 0;
    let approx = false;
    for (const d of dividends) {
      if (d.date.slice(0, 10) < ttmStart) continue;
      if (d.amountPln == null) approx = true;
      else sumPln += d.amountPln;
    }
    return { sumPln, approx };
  }, [dividends]);

  // Mianownik średniej miesięcznej: pełne 12 mies. tylko gdy historia to pokrywa —
  // inaczej dzielilibyśmy dorobek 3 miesięcy przez 12 i zaniżali wynik 4×.
  const avgMonths = Math.min(12, monthsCovered);

  // Widok historii: pojedyncze wypłaty vs agregacja per spółka (z YoC).
  const [historyView, setHistoryView] = useState<'payouts' | 'company'>('payouts');
  const companyRows = useMemo(() => {
    const ttmStart = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const yocByIsin = new Map((yoc?.positions ?? []).map((p) => [p.isin, p.yocPct]));
    interface Row {
      key: string;
      ticker: string;
      count: number;
      totalPln: number;
      sum12mPln: number;
      approx: boolean;
      yocPct: number | null;
      open: boolean;
    }
    const map = new Map<string, Row>();
    // Rekordy przychodzą od najnowszych — pierwszy widziany ticker grupy jest
    // najświeższy (po rebrandingu, np. TEXT zamiast LIVECHAT, gdy ISIN wspólny).
    for (const d of dividends) {
      const key = d.isin ?? `t:${d.ticker}`;
      let row = map.get(key);
      if (!row) {
        row = {
          key,
          ticker: d.ticker,
          count: 0,
          totalPln: 0,
          sum12mPln: 0,
          approx: false,
          yocPct: d.isin != null ? (yocByIsin.get(d.isin) ?? null) : null,
          open: d.isin != null && yocByIsin.has(d.isin),
        };
        map.set(key, row);
      }
      row.count += 1;
      if (d.amountPln == null) row.approx = true;
      else {
        row.totalPln += d.amountPln;
        if (d.date.slice(0, 10) >= ttmStart) row.sum12mPln += d.amountPln;
      }
    }
    return Array.from(map.values()).sort((a, b) => b.totalPln - a.totalPln);
  }, [dividends, yoc]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => scanMutation.mutate()}
          disabled={scanMutation.isPending}
        >
          {scanMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Skanuj dywidendy
        </Button>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" />
          Dodaj dywidende
        </Button>
      </div>

      {data && (
        <TooltipProvider>
          <div
            className={cn(
              'grid grid-cols-2 gap-2',
              hasFullYear ? 'md:grid-cols-4' : 'md:grid-cols-3',
            )}
          >
            <DivStatTile
              label="Suma dywidend"
              value={`${data.totalPlnApprox ? '≈ ' : ''}${formatPLN(data.totalPln)}`}
              subtext="łącznie · kurs z dnia wypłaty"
              tooltip={
                (data.byCurrency?.length ?? 0) > 1 ? (
                  <div className="space-y-1">
                    {data.byCurrency.map((c) => (
                      <div key={c.currency} className="flex justify-between gap-4 tabular-nums">
                        <span>
                          {formatNumber(c.amount)} {c.currency}
                        </span>
                        {c.currency !== 'PLN' && (
                          <span>{c.pln != null ? `≈ ${formatPLN(c.pln)}` : 'brak kursu'}</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : undefined
              }
            />
            {/* Przy historii < 12 mies. suma z okna równa się sumie łącznej — kafel
                byłby duplikatem, więc pojawia się dopiero gdy okno coś odcina. */}
            {hasFullYear && (
              <DivStatTile
                label="Ostatnie 12 mies."
                value={`${last12m.approx ? '≈ ' : ''}${formatPLN(last12m.sumPln)}`}
                subtext="wszystkie wypłaty netto"
              />
            )}
            <DivStatTile
              label={hasFullYear ? 'Yield on cost' : `Yield on cost (${avgMonths} mies.)`}
              value={yoc ? `${yoc.approx ? '≈ ' : ''}${formatNumber(yoc.totalYocPct)}%` : '—'}
              subtext={
                yoc
                  ? `${formatPLN(yoc.totalDividends12mPln)} / ${formatPLN(yoc.totalCostPln)}`
                  : undefined
              }
              tooltip={
                hasFullYear
                  ? 'Faktycznie wypłacone dywidendy netto z ostatnich 12 miesięcy (PLN po kursie z dnia wypłaty) podzielone przez koszt nabycia OTWARTYCH pozycji. Pokazuje, jak procentuje zainwestowany kapitał — niezależnie od bieżącej ceny. Dywidendy ze sprzedanych pozycji nie wchodzą do rachunku; YoC per spółka w widoku „Per spółka” poniżej.'
                  : `Faktycznie wypłacone dywidendy netto podzielone przez koszt nabycia OTWARTYCH pozycji. Portfel ma dopiero ${avgMonths} mies. historii wypłat, więc to wynik za NIEPEŁNY rok — nie porównuj go wprost ze stopą roczną. Nie annualizujemy, bo wypłaty są sezonowe (na GPW kumulują się latem).`
              }
            />
            <DivStatTile
              label="Śr. miesięcznie"
              value={`${last12m.approx ? '≈ ' : ''}${formatPLN(last12m.sumPln / avgMonths)}`}
              subtext={hasFullYear ? 'z ostatnich 12 mies.' : `z ${avgMonths} mies. historii`}
              tooltip={
                hasFullYear
                  ? undefined
                  : `Suma wypłat podzielona przez ${avgMonths} mies. faktycznej historii (nie przez 12) — dzielenie przez pełny rok zaniżałoby wynik. Przy krótkiej historii pojedyncza duża dywidenda mocno zawyża średnią.`
              }
            />
          </div>
        </TooltipProvider>
      )}

      {data && chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">
                {showYearly ? 'Dywidendy rocznie' : 'Dywidendy miesięcznie'}
              </CardTitle>
              {canShowYearly && (
                <div className="flex items-center rounded-md bg-muted p-0.5">
                  <button
                    className={cn(
                      'px-2 py-0.5 rounded text-xs font-medium transition-colors',
                      showYearly ? 'bg-background text-foreground' : 'text-muted-foreground',
                    )}
                    onClick={() => setChartPeriod('year')}
                  >
                    Rocznie
                  </button>
                  <button
                    className={cn(
                      'px-2 py-0.5 rounded text-xs font-medium transition-colors',
                      !showYearly ? 'bg-background text-foreground' : 'text-muted-foreground',
                    )}
                    onClick={() => setChartPeriod('month')}
                  >
                    Miesięcznie
                  </button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart
                data={chartData}
                accessibilityLayer
                aria-label={`Suma dywidend per ${showYearly ? 'rok' : 'miesiąc'}`}
              >
                <XAxis dataKey="year" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip
                  cursor={{ fill: 'var(--primary)', fillOpacity: 0.1 }}
                  contentStyle={{
                    backgroundColor: 'var(--popover)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: 'var(--popover-foreground)', fontWeight: 600 }}
                  formatter={(v, name) => [
                    formatCurrency(Number(v) || 0, String(name)),
                    String(name),
                  ]}
                />
                {chartCurrencies.length > 1 && (
                  <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
                )}
                {chartCurrencies.map((currency, i) => (
                  <Bar
                    key={currency}
                    dataKey={currency}
                    stackId="dividends"
                    fill={`var(--chart-${(i % 5) + 1})`}
                    radius={i === chartCurrencies.length - 1 ? [4, 4, 0, 0] : undefined}
                    maxBarSize={showYearly ? 80 : 32}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <UpcomingDividendsPanel />

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Historia dywidend
              {dividends.length > 0 && (
                <span className="text-muted-foreground font-normal">
                  ({historyView === 'company' ? companyRows.length : dividends.length})
                </span>
              )}
            </CardTitle>
            {dividends.length > 0 && (
              <div className="flex items-center rounded-md bg-muted p-0.5">
                <button
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    historyView === 'payouts'
                      ? 'bg-background text-foreground'
                      : 'text-muted-foreground'
                  }`}
                  onClick={() => setHistoryView('payouts')}
                >
                  Wypłaty
                </button>
                <button
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    historyView === 'company'
                      ? 'bg-background text-foreground'
                      : 'text-muted-foreground'
                  }`}
                  onClick={() => setHistoryView('company')}
                >
                  Per spółka
                </button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <LoadingSpinner />
          ) : dividends.length === 0 ? (
            <EmptyState
              message="Brak dywidend. Zaimportuj historię transakcji lub dodaj ręcznie."
              action={{ label: 'Dodaj dywidendę', onClick: () => setAddOpen(true) }}
            />
          ) : historyView === 'company' ? (
            <div className="overflow-x-auto scroll-shadow-x">
              <Table className="min-w-[560px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Spółka</TableHead>
                    <TableHead className="text-right">Wypłat</TableHead>
                    <TableHead className="text-right">12 mies.</TableHead>
                    <TableHead className="text-right">Łącznie</TableHead>
                    <TableHead className="text-right">Yield on cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {companyRows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell className="font-mono font-medium">{row.ticker}</TableCell>
                      <TableCell className="text-right text-muted-foreground tabular-nums">
                        {row.count}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.sum12mPln > 0 ? formatPLN(row.sum12mPln) : '—'}
                      </TableCell>
                      <TableCell className="text-right font-medium text-gain tabular-nums">
                        {row.approx ? '≈ ' : ''}
                        {formatPLN(row.totalPln)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.yocPct != null ? (
                          <span className="font-medium text-gain">{formatNumber(row.yocPct)}%</span>
                        ) : (
                          <span
                            className="text-muted-foreground"
                            title={row.open ? undefined : 'Pozycja zamknięta albo bez dywidend 12M'}
                          >
                            —
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Kwoty w PLN po kursie z dnia wypłaty · YoC = dywidendy 12 mies. / koszt nabycia
                otwartej pozycji („—" = pozycja sprzedana albo bez wypłat w 12 mies.)
              </p>
            </div>
          ) : (
            <>
              <div className="md:hidden flex flex-col gap-2">
                {dividends.map((d: DividendRecord) => {
                  const isExpanded = expandedHistory.has(d.id);
                  const hasDescription = !!(d.description && d.description.trim());
                  return (
                    <ExpandableCard
                      key={d.id}
                      expanded={isExpanded}
                      onToggle={() => toggleHistory(d.id)}
                      headerLeft={
                        <>
                          <span className="font-mono font-semibold text-sm truncate">
                            {d.ticker}
                          </span>
                          <CouponBadge subkind={d.subkind} />
                          <CcyChip ccy={d.currency} />
                        </>
                      }
                      headerRight={
                        <span className="font-semibold text-sm tabular-nums text-gain shrink-0">
                          {formatNumber(d.amount)}
                        </span>
                      }
                      subHeader={
                        <ExpandableCardSubRow>
                          <span className="text-muted-foreground tabular-nums">
                            {formatDate(d.date)}
                          </span>
                          <SourceBadge source={d.source} />
                        </ExpandableCardSubRow>
                      }
                    >
                      {hasDescription && (
                        <div className="flex justify-between gap-3 items-baseline">
                          <span className="text-muted-foreground shrink-0">Opis</span>
                          <span className="text-right">
                            {formatDividendDescription(d.description)}
                          </span>
                        </div>
                      )}
                      {(d.source === 'manual' || d.source === 'auto-yahoo') && (
                        <div className="flex justify-end gap-1.5 pt-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditing(d)}
                            className="h-7 px-2 text-xs"
                          >
                            <Pencil className="h-3 w-3 mr-1" />
                            Edytuj
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setDeleting(d)}
                            disabled={deleteMutation.isPending}
                            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Usuń
                          </Button>
                        </div>
                      )}
                    </ExpandableCard>
                  );
                })}
              </div>
              <div className="hidden md:block overflow-x-auto scroll-shadow-x">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableTableHead
                        label="Data"
                        active={histSortKey === 'date'}
                        dir={histDir}
                        onToggle={() => toggleHistSort('date')}
                      />
                      <SortableTableHead
                        label="Ticker"
                        active={histSortKey === 'ticker'}
                        dir={histDir}
                        onToggle={() => toggleHistSort('ticker')}
                      />
                      <TableHead>Opis</TableHead>
                      <SortableTableHead
                        label="Kwota"
                        align="right"
                        active={histSortKey === 'amount'}
                        dir={histDir}
                        onToggle={() => toggleHistSort('amount')}
                      />
                      <TableHead>Waluta</TableHead>
                      <TableHead>Źródło</TableHead>
                      <TableHead className="w-[80px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedDividends.map((d: DividendRecord) => (
                      <TableRow key={d.id}>
                        <TableCell>{formatDate(d.date)}</TableCell>
                        <TableCell className="font-mono font-medium">
                          {d.ticker} <CouponBadge subkind={d.subkind} />
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {formatDividendDescription(d.description)}
                        </TableCell>
                        <TableCell className="text-right font-medium text-gain tabular-nums">
                          {formatNumber(d.amount)}
                        </TableCell>
                        <TableCell>
                          <CcyChip ccy={d.currency} />
                        </TableCell>
                        <TableCell>
                          <SourceBadge source={d.source} />
                        </TableCell>
                        <TableCell>
                          {(d.source === 'manual' || d.source === 'auto-yahoo') && (
                            <div className="flex gap-1">
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => setEditing(d)}
                                className="text-muted-foreground hover:text-foreground"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => setDeleting(d)}
                                disabled={deleteMutation.isPending}
                                className="text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AddDividendDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <AddDividendDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        defaultValues={
          editing
            ? {
                id: editing.id,
                date: editing.date,
                ticker: editing.ticker,
                amount: editing.amount,
                currency: editing.currency,
                description: editing.description,
                source: editing.source,
              }
            : undefined
        }
      />
      <ConfirmDeleteDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
        description={
          deleting
            ? `Usunąć dywidendę ${deleting.ticker} — ${formatCurrency(deleting.amount, deleting.currency)} z ${formatDate(deleting.date)}?`
            : ''
        }
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
