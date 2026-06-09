import { useState, useMemo, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { usePortfolio } from '@/lib/portfolio-context';
import { QUERY_KEYS, invalidateCashFlow } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { AddDepositDialog } from './AddDepositDialog';
import { CashFlowChart } from './CashFlowChart';
import {
  Tooltip as UITooltip,
  TooltipContent as UITooltipContent,
  TooltipProvider as UITooltipProvider,
  TooltipTrigger as UITooltipTrigger,
} from '@/components/ui/tooltip';
import { formatPLN, formatDate, formatCurrency } from '@/lib/formatters';
import { ExpandableCard, ExpandableCardSubRow } from '@/components/ui/expandable-card';
import { useToggleSet } from '@/hooks/useToggleSet';
import {
  ChevronRight,
  ChevronDown,
  Plus,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  Info,
} from 'lucide-react';
import { toast } from 'sonner';

// XTB Transfer między sub-kontami trafia do CashOperation.description z tym prefixem.
// Wykrywamy go, by pokazać ikonę + tooltip wyjaśniający że to wymiana walutowa,
// ale traktowana jako depozyt/wypłata dla celów MWR/TWR.
const FX_MARKER_RE = /^\[z wymiany walut(?:\s+(\S+)\s+@\s+([\d.]+))?\]\s*(.*)$/;

function DepositDescription({ text }: { text: string }) {
  const m = text.match(FX_MARKER_RE);
  if (!m) {
    return <span className="text-xs text-muted-foreground/70 ml-1">{text}</span>;
  }
  const [, pair, rate, rest] = m;
  const label = pair ? `wymiana ${pair} @ ${rate}` : 'wymiana walut';
  return (
    <UITooltip>
      <UITooltipTrigger asChild>
        <span className="text-xs text-muted-foreground/70 ml-1 inline-flex items-center gap-1 cursor-help">
          <Info className="h-3 w-3" />
          {label}
          {rest && <span className="opacity-70">· {rest}</span>}
        </span>
      </UITooltipTrigger>
      <UITooltipContent className="max-w-xs">
        Ta operacja powstała z wymiany walutowej w ramach XTB (Transfer między sub-kontami).
        Traktujemy ją jako depozyt / wypłatę dla celów obliczania MWR/TWR, bo z perspektywy tego
        sub-konta reprezentuje środki wprowadzone z zewnątrz (lub wyprowadzone na zewnątrz).
      </UITooltipContent>
    </UITooltip>
  );
}

// Historyczne limity IKE/IKZE są centralne w shared/src/ike-ikze-limits.ts (2012–2026).
// Trzymaj tam wszystkie edycje — ten komponent jest tylko konsumentem.
import { IKE_LIMITS, IKZE_LIMITS, IKZE_DG_LIMITS } from 'shared';

interface CashEntry {
  id: number;
  date: string;
  amount: number;
  currency: string;
  source: string;
  description: string;
  type: 'deposit' | 'withdrawal';
}

interface YearGroup {
  year: number;
  totalDeposits: number;
  totalWithdrawals: number;
  /** Suma wpłat wyłącznie w PLN — limity IKE/IKZE są denominowane w PLN. */
  plnDeposits: number;
  /** Czy rok zawiera wpłaty w walucie innej niż PLN (limit nieporównywalny bez kursu). */
  hasForeignDeposits: boolean;
  ikeLimit: number;
  ikzeLimit: number;
  entries: CashEntry[];
}

/**
 * Placeholder "—" z tooltipem dla kolumn limitu, gdy rok zawiera wpłaty
 * w walucie obcej — porównywanie kwot np. w USD z limitem w PLN dawałoby
 * bezsensowne procenty, więc uczciwie pokazujemy brak danych.
 */
function LimitUnavailable() {
  return (
    <UITooltip>
      <UITooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 cursor-help text-muted-foreground">
          —<Info className="h-3 w-3" />
        </span>
      </UITooltipTrigger>
      <UITooltipContent className="max-w-xs">
        Limity IKE/IKZE są wyrażone w PLN, a ten rok zawiera wpłaty w innych walutach. Bez kursów
        wymiany nie da się rzetelnie policzyć wykorzystania limitu.
      </UITooltipContent>
    </UITooltip>
  );
}

export function CashFlowPage() {
  const queryClient = useQueryClient();
  const { activeSettings } = usePortfolio();

  const showIKE = activeSettings.isIKE;
  const showIKZE = activeSettings.isIKZE;
  const showLimits = showIKE || showIKZE;

  const { data: cashFlowData, isLoading: cashFlowLoading } = useQuery({
    queryKey: QUERY_KEYS.cashFlow,
    queryFn: api.getCashFlow,
    staleTime: 60 * 60 * 1000,
  });

  const { data: depositsData, isLoading: depositsLoading } = useQuery({
    queryKey: QUERY_KEYS.deposits,
    queryFn: api.getDeposits,
  });

  const [expandedYears, toggleYear] = useToggleSet<number>();
  const [showPortfolio, setShowPortfolio] = useState(true);
  const [showCashFlow, setShowCashFlow] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<CashEntry | null>(null);
  const [deleting, setDeleting] = useState<CashEntry | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteDeposit(id),
    onSuccess: (_, id) => {
      invalidateCashFlow(queryClient);
      const entry = deleting;
      if (entry && entry.id === id) {
        const label = entry.type === 'deposit' ? 'wpłatę' : 'wypłatę';
        toast.success(
          `Usunięto ${label} ${formatCurrency(Math.abs(entry.amount), entry.currency || 'PLN')} z ${formatDate(entry.date)}`,
        );
      } else {
        toast.success('Usunięto operację.');
      }
      setDeleting(null);
    },
    onError: (e: Error) => toast.error(`Nie udało się usunąć: ${e.message}`),
  });

  const entries: CashEntry[] = (depositsData?.deposits || []).map((d: any) => ({
    ...d,
    type: d.type || 'deposit',
  }));
  const ikzeLimits = activeSettings.ikzeIsDG ? IKZE_DG_LIMITS : IKZE_LIMITS;

  // Dominant currency across all entries — if all entries share one currency,
  // use it for aggregates (year totals, grand totals, chart axis). For mixed-
  // currency portfolios fall back to PLN as a common denominator (which may be
  // imprecise — IKE/IKZE limits are PLN-only anyway and sumy bez konwersji FX
  // nie mają sensu; osobny follow-up).
  const displayCurrency = useMemo(() => {
    const currencies = new Set(entries.map((e) => (e.currency || 'PLN').toUpperCase()));
    if (currencies.size === 1) return [...currencies][0];
    return 'PLN';
  }, [entries]);
  const isMultiCurrency = useMemo(() => {
    const currencies = new Set(entries.map((e) => (e.currency || 'PLN').toUpperCase()));
    return currencies.size > 1;
  }, [entries]);
  const fmtAgg = (v: number) => formatCurrency(v, displayCurrency);

  const yearGroups = useMemo(() => {
    if (!entries.length) return [];

    const byYear = new Map<number, CashEntry[]>();
    for (const entry of entries) {
      const year = parseInt(entry.date.slice(0, 4));
      const arr = byYear.get(year) || [];
      arr.push(entry);
      byYear.set(year, arr);
    }

    const groups: YearGroup[] = [];
    for (const [year, yearEntries] of byYear) {
      const depositEntries = yearEntries.filter((e) => e.type === 'deposit');
      const totalDeposits = depositEntries.reduce((s, d) => s + Math.abs(d.amount), 0);
      // Limity IKE/IKZE są w PLN — do wykorzystania limitu liczymy wyłącznie
      // wpłaty PLN. Gdy rok ma wpłaty w obcej walucie, UI pokazuje "—" z tooltipem
      // zamiast bezsensownego porównania np. USD z limitem PLN.
      const plnDeposits = depositEntries
        .filter((e) => (e.currency || 'PLN').toUpperCase() === 'PLN')
        .reduce((s, d) => s + Math.abs(d.amount), 0);
      const hasForeignDeposits = depositEntries.some(
        (e) => (e.currency || 'PLN').toUpperCase() !== 'PLN',
      );
      const totalWithdrawals = yearEntries
        .filter((e) => e.type === 'withdrawal')
        .reduce((s, d) => s + Math.abs(d.amount), 0);
      const ikeLimit = IKE_LIMITS[year] || 0;
      const ikzeLimit = ikzeLimits[year] || 0;
      yearEntries.sort((a, b) => b.date.localeCompare(a.date));
      groups.push({
        year,
        totalDeposits,
        totalWithdrawals,
        plnDeposits,
        hasForeignDeposits,
        ikeLimit,
        ikzeLimit,
        entries: yearEntries,
      });
    }

    groups.sort((a, b) => b.year - a.year);
    return groups;
  }, [entries, ikzeLimits]);

  const grandTotalDeposits = useMemo(
    () => yearGroups.reduce((s, g) => s + g.totalDeposits, 0),
    [yearGroups],
  );
  const grandTotalWithdrawals = useMemo(
    () => yearGroups.reduce((s, g) => s + g.totalWithdrawals, 0),
    [yearGroups],
  );

  const getYearLimit = (group: YearGroup) => {
    let total = 0;
    if (showIKE) total += group.ikeLimit;
    if (showIKZE) total += group.ikzeLimit;
    return total;
  };

  // Wykorzystanie limitu liczone wyłącznie z wpłat PLN (limity są PLN-only).
  const getRemaining = (group: YearGroup) => {
    const limit = getYearLimit(group);
    return Math.max(limit - group.plnDeposits, 0);
  };

  const getUsagePct = (group: YearGroup) => {
    const limit = getYearLimit(group);
    return limit > 0 ? (group.plnDeposits / limit) * 100 : 0;
  };

  const limitColCount = (showIKE ? 1 : 0) + (showIKZE ? 1 : 0) + (showLimits ? 2 : 0);
  const totalCols = 3 + limitColCount + 1; // rok + wpłaty + wypłaty + limits + actions

  const cardTitle =
    showIKE && showIKZE
      ? 'Przepływy gotówkowe vs limity IKE/IKZE'
      : showIKE
        ? 'Przepływy gotówkowe vs limit IKE'
        : showIKZE
          ? 'Przepływy gotówkowe vs limit IKZE'
          : 'Przepływy gotówkowe';

  return (
    <UITooltipProvider delayDuration={150}>
      <div className="space-y-4">
        <div className="flex items-center justify-end">
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            Dodaj operację
          </Button>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Wpłaty netto a wycena portfela
              {cashFlowData?.baseCurrency && cashFlowData.baseCurrency !== 'PLN' && (
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  (w {cashFlowData.baseCurrency})
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 mb-3">
              <button
                onClick={() => setShowPortfolio((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  showPortfolio ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full bg-[#f59e0b]"
                  style={{ opacity: showPortfolio ? 1 : 0.3 }}
                />
                Wartość portfela
              </button>
              <button
                onClick={() => setShowCashFlow((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  showCashFlow ? 'bg-secondary text-foreground' : 'bg-muted text-muted-foreground'
                }`}
              >
                <span
                  className="w-3 h-0.5 border-t-2 border-dashed border-current"
                  style={{ opacity: showCashFlow ? 1 : 0.3 }}
                />
                Wpłaty netto
              </button>
            </div>
            {cashFlowLoading ? (
              <LoadingSpinner />
            ) : cashFlowData?.chartData?.length ? (
              <CashFlowChart
                data={cashFlowData.chartData}
                currency={cashFlowData.baseCurrency || 'PLN'}
                showPortfolio={showPortfolio}
                showCashFlow={showCashFlow}
              />
            ) : (
              <div className="flex items-center justify-center h-80 text-muted-foreground">
                Brak danych.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{cardTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            {depositsLoading ? (
              <LoadingSpinner />
            ) : yearGroups.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">
                Brak operacji gotówkowych. Kliknij &quot;Dodaj operację&quot; aby dodać pierwszą.
              </div>
            ) : (
              <>
                <div className="md:hidden flex flex-col gap-2">
                  {yearGroups.map((group) => {
                    const isExpanded = expandedYears.has(group.year);
                    const remaining = getRemaining(group);
                    const usagePct = getUsagePct(group);
                    const yearLimit = getYearLimit(group);
                    const isFull =
                      showLimits && yearLimit > 0 && !group.hasForeignDeposits && remaining <= 0;
                    return (
                      <ExpandableCard
                        key={group.year}
                        expanded={isExpanded}
                        onToggle={() => toggleYear(group.year)}
                        expandedClassName="gap-1"
                        headerLeft={
                          <>
                            <span className="font-semibold text-sm">{group.year}</span>
                            <span className="text-[10px] text-muted-foreground">
                              ({group.entries.length})
                            </span>
                          </>
                        }
                        headerRight={
                          <span className="font-semibold text-sm tabular-nums text-gain shrink-0">
                            {group.totalDeposits > 0 ? fmtAgg(group.totalDeposits) : '—'}
                          </span>
                        }
                        subHeader={
                          <>
                            {showLimits && yearLimit > 0 && (
                              <ExpandableCardSubRow>
                                <span className="text-muted-foreground">
                                  Pozostało:{' '}
                                  {group.hasForeignDeposits ? (
                                    <LimitUnavailable />
                                  ) : (
                                    <span
                                      className={`tabular-nums ${isFull ? 'text-gain' : 'text-yellow-500'}`}
                                    >
                                      {formatPLN(remaining)}
                                    </span>
                                  )}
                                </span>
                                {group.hasForeignDeposits ? (
                                  <LimitUnavailable />
                                ) : (
                                  <Badge
                                    variant={isFull ? 'default' : 'secondary'}
                                    className={`text-xs shrink-0 ${isFull ? 'bg-gain/10 text-gain' : 'bg-muted text-muted-foreground'}`}
                                  >
                                    {usagePct.toFixed(0)}%
                                  </Badge>
                                )}
                              </ExpandableCardSubRow>
                            )}
                            {group.totalWithdrawals > 0 && (
                              <ExpandableCardSubRow>
                                <span className="text-muted-foreground">Wypłaty</span>
                                <span className="text-loss tabular-nums">
                                  −{fmtAgg(group.totalWithdrawals)}
                                </span>
                              </ExpandableCardSubRow>
                            )}
                          </>
                        }
                      >
                        {showLimits && yearLimit > 0 && (
                          <>
                            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
                              Limit
                            </div>
                            {showIKE && group.ikeLimit > 0 && (
                              <div className="flex justify-between gap-3 items-baseline">
                                <span className="text-muted-foreground">Limit IKE</span>
                                <span className="tabular-nums text-right">
                                  {formatPLN(group.ikeLimit)}
                                </span>
                              </div>
                            )}
                            {showIKZE && group.ikzeLimit > 0 && (
                              <div className="flex justify-between gap-3 items-baseline">
                                <span className="text-muted-foreground">Limit IKZE</span>
                                <span className="tabular-nums text-right">
                                  {formatPLN(group.ikzeLimit)}
                                </span>
                              </div>
                            )}
                            <div className="flex justify-between gap-3 items-baseline">
                              <span className="text-muted-foreground">Pozostało</span>
                              {group.hasForeignDeposits ? (
                                <LimitUnavailable />
                              ) : (
                                <span
                                  className={`tabular-nums text-right font-medium ${isFull ? 'text-gain' : 'text-yellow-500'}`}
                                >
                                  {formatPLN(remaining)}
                                </span>
                              )}
                            </div>
                            <div className="flex justify-between gap-3 items-baseline">
                              <span className="text-muted-foreground">Wykorzystanie</span>
                              {group.hasForeignDeposits ? (
                                <LimitUnavailable />
                              ) : (
                                <Badge
                                  variant={isFull ? 'default' : 'secondary'}
                                  className={`text-xs ${isFull ? 'bg-gain/10 text-gain' : 'bg-muted text-muted-foreground'}`}
                                >
                                  {usagePct.toFixed(0)}%
                                </Badge>
                              )}
                            </div>
                            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mt-2">
                              Operacje ({group.entries.length})
                            </div>
                          </>
                        )}
                        {group.entries.map((entry) => (
                          <div key={entry.id} className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 min-w-0 truncate">
                              {entry.type === 'deposit' ? (
                                <ArrowUp className="h-3 w-3 text-gain shrink-0" />
                              ) : (
                                <ArrowDown className="h-3 w-3 text-loss shrink-0" />
                              )}
                              <span className="text-muted-foreground tabular-nums">
                                {formatDate(entry.date)}
                              </span>
                              {entry.description && <DepositDescription text={entry.description} />}
                            </span>
                            <span className="flex items-center gap-1.5 shrink-0">
                              <span
                                className={`tabular-nums font-medium ${entry.type === 'deposit' ? 'text-gain' : 'text-loss'}`}
                              >
                                {entry.type === 'deposit' ? '+' : '−'}
                                {formatCurrency(Math.abs(entry.amount), entry.currency || 'PLN')}
                              </span>
                              {entry.source === 'manual' && (
                                <>
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => setEditing(entry)}
                                    className="text-muted-foreground hover:text-foreground"
                                    aria-label="Edytuj"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    onClick={() => setDeleting(entry)}
                                    disabled={deleteMutation.isPending}
                                    className="text-muted-foreground hover:text-destructive"
                                    aria-label="Usuń"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </>
                              )}
                            </span>
                          </div>
                        ))}
                      </ExpandableCard>
                    );
                  })}
                  <div className="rounded-xl border-2 border-border bg-card p-3 flex items-center justify-between gap-2 font-semibold">
                    <span className="text-sm">Razem</span>
                    <div className="flex items-center gap-2 text-sm tabular-nums">
                      <span className="text-gain">{fmtAgg(grandTotalDeposits)}</span>
                      {grandTotalWithdrawals > 0 && (
                        <span className="text-loss">−{fmtAgg(grandTotalWithdrawals)}</span>
                      )}
                    </div>
                  </div>
                  {grandTotalWithdrawals > 0 && (
                    <div className="text-[11px] text-muted-foreground text-right pr-1">
                      Netto: {fmtAgg(grandTotalDeposits - grandTotalWithdrawals)}
                      {isMultiCurrency && ' (różne waluty, bez konwersji)'}
                    </div>
                  )}
                </div>
                <div className="hidden md:block overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Rok</TableHead>
                        <TableHead className="text-right">Wpłaty</TableHead>
                        <TableHead className="text-right">Wypłaty</TableHead>
                        {showIKE && <TableHead className="text-right">Limit IKE</TableHead>}
                        {showIKZE && <TableHead className="text-right">Limit IKZE</TableHead>}
                        {showLimits && <TableHead className="text-right">Pozostało</TableHead>}
                        {showLimits && <TableHead className="text-right">Wykorzystanie</TableHead>}
                        <TableHead className="w-[80px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {yearGroups.length === 0 ? (
                        <TableRow>
                          <TableCell
                            colSpan={totalCols}
                            className="text-center py-12 text-muted-foreground"
                          >
                            Brak operacji gotówkowych. Kliknij &quot;Dodaj operację&quot; aby dodać
                            pierwszą.
                          </TableCell>
                        </TableRow>
                      ) : (
                        yearGroups.map((group) => {
                          const isExpanded = expandedYears.has(group.year);
                          const remaining = getRemaining(group);
                          const usagePct = getUsagePct(group);
                          const isFull = showLimits && !group.hasForeignDeposits && remaining <= 0;
                          return (
                            <Fragment key={group.year}>
                              <TableRow
                                className="cursor-pointer hover:bg-muted/50"
                                onClick={() => toggleYear(group.year)}
                                role="button"
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    toggleYear(group.year);
                                  }
                                }}
                              >
                                <TableCell className="font-medium">
                                  <div className="flex items-center gap-1">
                                    {isExpanded ? (
                                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                                    ) : (
                                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                                    )}
                                    {group.year}
                                    <span className="text-xs text-muted-foreground ml-1">
                                      ({group.entries.length})
                                    </span>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right font-medium text-gain">
                                  {group.totalDeposits > 0 ? fmtAgg(group.totalDeposits) : '—'}
                                </TableCell>
                                <TableCell className="text-right font-medium text-loss">
                                  {group.totalWithdrawals > 0
                                    ? fmtAgg(group.totalWithdrawals)
                                    : '—'}
                                </TableCell>
                                {showIKE && (
                                  <TableCell className="text-right text-muted-foreground">
                                    {group.ikeLimit > 0 ? formatPLN(group.ikeLimit) : '—'}
                                  </TableCell>
                                )}
                                {showIKZE && (
                                  <TableCell className="text-right text-muted-foreground">
                                    {group.ikzeLimit > 0 ? formatPLN(group.ikzeLimit) : '—'}
                                  </TableCell>
                                )}
                                {showLimits && (
                                  <TableCell
                                    className={`text-right font-medium ${isFull ? 'text-gain' : 'text-yellow-500'}`}
                                  >
                                    {getYearLimit(group) > 0 ? (
                                      group.hasForeignDeposits ? (
                                        <LimitUnavailable />
                                      ) : (
                                        formatPLN(remaining)
                                      )
                                    ) : (
                                      '—'
                                    )}
                                  </TableCell>
                                )}
                                {showLimits && (
                                  <TableCell className="text-right">
                                    {getYearLimit(group) > 0 &&
                                      (group.hasForeignDeposits ? (
                                        <LimitUnavailable />
                                      ) : (
                                        <Badge
                                          variant={isFull ? 'default' : 'secondary'}
                                          className={`text-xs ${isFull ? 'bg-gain/10 text-gain' : 'bg-muted text-muted-foreground'}`}
                                        >
                                          {usagePct.toFixed(0)}%
                                        </Badge>
                                      ))}
                                  </TableCell>
                                )}
                                <TableCell />
                              </TableRow>

                              {isExpanded &&
                                group.entries.map((entry) => (
                                  <TableRow key={entry.id} className="bg-muted/30">
                                    <TableCell className="text-muted-foreground pl-9 text-sm">
                                      <div className="flex items-center gap-1.5">
                                        {entry.type === 'deposit' ? (
                                          <ArrowUp className="h-3 w-3 text-gain shrink-0" />
                                        ) : (
                                          <ArrowDown className="h-3 w-3 text-loss shrink-0" />
                                        )}
                                        {formatDate(entry.date)}
                                        {entry.description && (
                                          <DepositDescription text={entry.description} />
                                        )}
                                      </div>
                                    </TableCell>
                                    <TableCell
                                      className={`text-right ${entry.type === 'deposit' ? 'text-gain' : ''}`}
                                    >
                                      {entry.type === 'deposit'
                                        ? formatCurrency(
                                            Math.abs(entry.amount),
                                            entry.currency || 'PLN',
                                          )
                                        : ''}
                                    </TableCell>
                                    <TableCell
                                      className={`text-right ${entry.type === 'withdrawal' ? 'text-loss' : ''}`}
                                    >
                                      {entry.type === 'withdrawal'
                                        ? formatCurrency(
                                            Math.abs(entry.amount),
                                            entry.currency || 'PLN',
                                          )
                                        : ''}
                                    </TableCell>
                                    <TableCell
                                      colSpan={limitColCount > 0 ? limitColCount - 1 : 0}
                                    />
                                    <TableCell className="text-right">
                                      {entry.source === 'manual' && (
                                        <Badge
                                          variant="secondary"
                                          className="text-xs bg-blue-500/10 text-blue-500"
                                        >
                                          ręczna
                                        </Badge>
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      {entry.source === 'manual' && (
                                        <div className="flex gap-1">
                                          <Button
                                            size="icon-xs"
                                            variant="ghost"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setEditing(entry);
                                            }}
                                            className="text-muted-foreground hover:text-foreground"
                                          >
                                            <Pencil className="h-3 w-3" />
                                          </Button>
                                          <Button
                                            size="icon-xs"
                                            variant="ghost"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setDeleting(entry);
                                            }}
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
                            </Fragment>
                          );
                        })
                      )}
                      {yearGroups.length > 0 && (
                        <TableRow className="font-semibold border-t-2">
                          <TableCell>Razem</TableCell>
                          <TableCell className="text-right">{fmtAgg(grandTotalDeposits)}</TableCell>
                          <TableCell className="text-right">
                            {grandTotalWithdrawals > 0 ? fmtAgg(grandTotalWithdrawals) : '—'}
                          </TableCell>
                          {showLimits && <TableCell colSpan={showIKE && showIKZE ? 4 : 3} />}
                          <TableCell />
                        </TableRow>
                      )}
                      {yearGroups.length > 0 && grandTotalWithdrawals > 0 && (
                        <TableRow className="font-semibold">
                          <TableCell className="text-muted-foreground">Netto</TableCell>
                          <TableCell colSpan={2} className="text-right">
                            {fmtAgg(grandTotalDeposits - grandTotalWithdrawals)}
                            {isMultiCurrency && (
                              <span className="ml-2 text-xs text-muted-foreground font-normal">
                                (różne waluty, bez konwersji)
                              </span>
                            )}
                          </TableCell>
                          {showLimits && <TableCell colSpan={showIKE && showIKZE ? 4 : 3} />}
                          <TableCell />
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <AddDepositDialog open={addOpen} onClose={() => setAddOpen(false)} />
        <AddDepositDialog
          open={!!editing}
          onClose={() => setEditing(null)}
          defaultValues={
            editing
              ? { id: editing.id, date: editing.date, amount: editing.amount, type: editing.type }
              : undefined
          }
        />
        <ConfirmDeleteDialog
          open={!!deleting}
          onClose={() => setDeleting(null)}
          onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
          description={
            deleting
              ? `Usunąć ${deleting.type === 'deposit' ? 'wpłatę' : 'wypłatę'} ${formatCurrency(Math.abs(deleting.amount), deleting.currency || 'PLN')} z ${formatDate(deleting.date)}?`
              : ''
          }
          loading={deleteMutation.isPending}
        />
      </div>
    </UITooltipProvider>
  );
}
