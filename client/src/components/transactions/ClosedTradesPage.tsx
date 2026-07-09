import { useMemo, useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { errorToast } from '@/lib/error-toast';
import { QUERY_KEYS, invalidatePortfolio } from '@/lib/query-keys';
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
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { formatNumber, formatDate, formatCurrency, formatQuantity } from '@/lib/formatters';
import { groupClosedTrades, type TradeGroup } from '@/lib/closed-trades-grouping';
import { useToggleSet } from '@/hooks/useToggleSet';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { ChevronRight, ChevronDown, Trash2, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import type { ClosedTrade } from 'shared';
import { ClosedPositionCardMobile } from './ClosedPositionCardMobile';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { displayOptionTicker } from 'shared';
import { TickerLabel } from '@/components/ui/ticker-label';

/** Round-trip wskazany do usunięcia — może obejmować kilka transakcji sprzedaży. */
const CATEGORY_FILTER_LABELS: Record<string, string> = {
  stock: 'Akcje',
  etf: 'ETF',
  cfd: 'CFD',
  bond: 'Obligacje',
  option: 'Opcje',
};

interface DeleteSellTarget {
  ids: number[];
  ticker: string;
  sellDate: string;
  quantity: number;
}

function CostCell({ trade, muted }: { trade: ClosedTrade; muted?: boolean }) {
  const totalCost = trade.totalCost || 0;
  if (totalCost <= 0) return <span>—</span>;

  const commission = trade.buyCommission + trade.sellCommission;
  const hasFees = trade.fees && trade.fees.length > 0;

  if (!hasFees) {
    return <span>{formatNumber(totalCost)}</span>;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`cursor-help underline decoration-dotted ${muted ? '' : ''}`}>
            {formatNumber(totalCost)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="left" className="text-left">
          <div className="space-y-0.5">
            {commission > 0 && (
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">prowizja:</span>
                <span>{formatNumber(commission)}</span>
              </div>
            )}
            {trade.fees!.map((fee, i) => (
              <div key={i} className="flex justify-between gap-4">
                <span className="text-muted-foreground">{fee.type}:</span>
                <span>{formatNumber(fee.amount)}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface ClosedTradesPageProps {
  dateRange?: string;
  onDateRangeChange?: (v: string) => void;
  customFrom?: string;
  onCustomFromChange?: (v: string) => void;
  customTo?: string;
  onCustomToChange?: (v: string) => void;
}

export function ClosedTradesPage(props: ClosedTradesPageProps = {}) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.closedTrades,
    queryFn: api.getClosedTrades,
  });

  const [expandedGroups, toggleGroup] = useToggleSet<string>();

  const [plFilter, setPlFilter] = useState<'all' | 'profit' | 'loss'>('all');
  const [currencyFilter, setCurrencyFilter] = useState<string>('ALL');
  // Filtr kategorii instrumentu (akcje/ETF/opcje/…) — opcje liczą się do wspólnych
  // statystyk, ale da się je wyodrębnić.
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  // Date range: use controlled props if provided, else internal state (backward compat)
  const [internalDateRange, setInternalDateRange] = useState<string>('ALL');
  const [internalCustomFrom, setInternalCustomFrom] = useState('');
  const [internalCustomTo, setInternalCustomTo] = useState('');
  const dateRange = props.dateRange ?? internalDateRange;
  const setDateRange = (v: string) => {
    if (props.onDateRangeChange) props.onDateRangeChange(v);
    else setInternalDateRange(v);
  };
  const customFrom = props.customFrom ?? internalCustomFrom;
  const setCustomFrom = (v: string) => {
    if (props.onCustomFromChange) props.onCustomFromChange(v);
    else setInternalCustomFrom(v);
  };
  const customTo = props.customTo ?? internalCustomTo;
  const setCustomTo = (v: string) => {
    if (props.onCustomToChange) props.onCustomToChange(v);
    else setInternalCustomTo(v);
  };

  // Potwierdzenie usunięcia — wspólny wzorzec ConfirmDeleteDialog (jak Dywidendy/Waluty).
  const [deleteTarget, setDeleteTarget] = useState<DeleteSellTarget | null>(null);

  const deleteMutation = useMutation({
    // Round-trip może obejmować kilka sprzedaży — usuwamy sekwencyjnie (silnik przelicza po każdej).
    mutationFn: async (ids: number[]) => {
      for (const id of ids) await api.deleteTransaction(id);
    },
    onSuccess: (_, ids) => {
      invalidatePortfolio(queryClient);
      const t = deleteTarget;
      if (t) {
        toast.success(
          ids.length > 1
            ? `Usunięto sprzedaże ${displayOptionTicker(t.ticker)} (${ids.length}) — łącznie ${formatQuantity(t.quantity)} szt`
            : `Usunięto transakcję sprzedaży ${displayOptionTicker(t.ticker)} — ${formatQuantity(t.quantity)} szt z ${formatDate(t.sellDate)}`,
        );
      } else {
        toast.success('Usunięto transakcję sprzedaży.');
      }
      setDeleteTarget(null);
    },
    onError: (e: Error) => errorToast('Nie udało się usunąć', e),
  });

  const availableCurrencies = useMemo(() => {
    if (!data?.trades?.length) return [];
    const set = new Set<string>();
    for (const trade of data.trades) set.add(trade.currency);
    return Array.from(set).sort();
  }, [data]);

  const availableCategories = useMemo(() => {
    if (!data?.trades?.length) return [];
    const set = new Set<string>();
    for (const trade of data.trades) set.add(trade.category ?? 'stock');
    return Array.from(set).sort();
  }, [data]);

  const availableYears = useMemo(() => {
    if (!data?.trades?.length) return [];
    const set = new Set<number>();
    for (const trade of data.trades) set.add(new Date(trade.sellDate).getFullYear());
    return Array.from(set).sort((a, b) => b - a);
  }, [data]);

  // Round-tripy (flat→flat) z całej historii — grupujemy NAJPIERW, filtrujemy po grupach,
  // żeby filtr P/L (zysk/strata) ani daty nie rozcinał pojedynczego round-tripu.
  const allGroups = useMemo(() => groupClosedTrades(data?.trades ?? []), [data]);

  const groups = useMemo((): TradeGroup[] => {
    let g = allGroups;
    if (plFilter === 'profit') g = g.filter((x) => x.totalProfitLoss > 0);
    else if (plFilter === 'loss') g = g.filter((x) => x.totalProfitLoss < 0);
    if (currencyFilter !== 'ALL') g = g.filter((x) => x.currency === currencyFilter);
    if (categoryFilter !== 'ALL')
      g = g.filter((x) => (x.trades[0]?.category ?? 'stock') === categoryFilter);
    if (dateRange !== 'ALL') {
      let fromDate: string | undefined;
      let toDate: string | undefined;
      if (dateRange === 'CUSTOM') {
        fromDate = customFrom || undefined;
        toDate = customTo || undefined;
      } else {
        fromDate = `${dateRange}-01-01`;
        toDate = `${dateRange}-12-31`;
      }
      if (fromDate) g = g.filter((x) => x.sellDate.slice(0, 10) >= fromDate!);
      if (toDate) g = g.filter((x) => x.sellDate.slice(0, 10) <= toDate!);
    }
    return g;
  }, [allGroups, plFilter, currencyFilter, categoryFilter, dateRange, customFrom, customTo]);

  // Liczba nóg (transakcji) w przefiltrowanych grupach — do nagłówka.
  const filteredLegCount = useMemo(() => groups.reduce((s, g) => s + g.trades.length, 0), [groups]);

  const plSummary = useMemo(() => {
    const map = new Map<
      string,
      { currency: string; totalPL: number; count: number; wins: number; losses: number }
    >();
    for (const group of groups) {
      const s = map.get(group.currency) || {
        currency: group.currency,
        totalPL: 0,
        count: 0,
        wins: 0,
        losses: 0,
      };
      s.totalPL += group.totalProfitLoss;
      s.count += 1;
      if (group.totalProfitLoss > 0) s.wins += 1;
      else if (group.totalProfitLoss < 0) s.losses += 1;
      map.set(group.currency, s);
    }
    return Array.from(map.values()).sort((a, b) => a.currency.localeCompare(b.currency));
  }, [groups]);

  const totalTrades = data?.trades?.length ?? 0;
  const isFiltered =
    plFilter !== 'all' ||
    currencyFilter !== 'ALL' ||
    categoryFilter !== 'ALL' ||
    dateRange !== 'ALL';
  const activeFilterCount =
    (plFilter !== 'all' ? 1 : 0) +
    (currencyFilter !== 'ALL' ? 1 : 0) +
    (categoryFilter !== 'ALL' ? 1 : 0) +
    (dateRange !== 'ALL' ? 1 : 0);

  return (
    <div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Historia zamkniętych pozycji (FIFO)
            {groups.length > 0 && (
              <span className="ml-2 text-muted-foreground font-normal">
                ({groups.length} pozycji, {filteredLegCount} transakcji
                {isFiltered && ` z ${totalTrades}`})
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!isLoading && data?.trades?.length ? (
            <>
              <div className="md:hidden mb-3 flex justify-end">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button size="sm" variant="outline" className="h-8 px-3 text-xs gap-1.5">
                      <SlidersHorizontal className="h-3.5 w-3.5" />
                      Filtry
                      {activeFilterCount > 0 && (
                        <span className="ml-0.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold">
                          {activeFilterCount}
                        </span>
                      )}
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="bottom" className="rounded-t-xl max-h-[85vh] overflow-auto">
                    <SheetHeader className="pb-2">
                      <SheetTitle>Filtry</SheetTitle>
                    </SheetHeader>
                    <div className="flex flex-col gap-4 px-4 pb-6">
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                          Wynik
                        </span>
                        <div className="grid grid-cols-3 rounded-md border overflow-hidden">
                          <Button
                            size="sm"
                            variant={plFilter === 'all' ? 'secondary' : 'ghost'}
                            className="h-9 text-xs rounded-none"
                            onClick={() => setPlFilter('all')}
                          >
                            Wszystkie
                          </Button>
                          <Button
                            size="sm"
                            variant={plFilter === 'profit' ? 'secondary' : 'ghost'}
                            className="h-9 text-xs rounded-none border-x"
                            onClick={() => setPlFilter('profit')}
                          >
                            Zyski
                          </Button>
                          <Button
                            size="sm"
                            variant={plFilter === 'loss' ? 'secondary' : 'ghost'}
                            className="h-9 text-xs rounded-none"
                            onClick={() => setPlFilter('loss')}
                          >
                            Straty
                          </Button>
                        </div>
                      </div>

                      {availableCurrencies.length > 1 && (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                            Waluta
                          </span>
                          <Select value={currencyFilter} onValueChange={setCurrencyFilter}>
                            <SelectTrigger className="h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ALL">Wszystkie waluty</SelectItem>
                              {availableCurrencies.map((c) => (
                                <SelectItem key={c} value={c}>
                                  {c}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {availableCategories.length > 1 && (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                            Kategoria
                          </span>
                          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                            <SelectTrigger className="h-9 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="ALL">Wszystkie kategorie</SelectItem>
                              {availableCategories.map((c) => (
                                <SelectItem key={c} value={c}>
                                  {CATEGORY_FILTER_LABELS[c] ?? c}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      <div className="flex flex-col gap-1.5">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                          Okres
                        </span>
                        <div className="flex flex-wrap gap-1.5">
                          <Button
                            size="sm"
                            variant={dateRange === 'ALL' ? 'secondary' : 'outline'}
                            className="h-8 px-3 text-xs"
                            onClick={() => setDateRange('ALL')}
                          >
                            Wszystko
                          </Button>
                          {availableYears.slice(0, 4).map((year) => (
                            <Button
                              key={year}
                              size="sm"
                              variant={dateRange === String(year) ? 'secondary' : 'outline'}
                              className="h-8 px-3 text-xs"
                              onClick={() => setDateRange(String(year))}
                            >
                              {year}
                            </Button>
                          ))}
                          <Button
                            size="sm"
                            variant={dateRange === 'CUSTOM' ? 'secondary' : 'outline'}
                            className="h-8 px-3 text-xs"
                            onClick={() => setDateRange('CUSTOM')}
                          >
                            Zakres
                          </Button>
                        </div>
                        {dateRange === 'CUSTOM' && (
                          <div className="flex items-center gap-2 mt-1">
                            <Input
                              type="date"
                              value={customFrom}
                              onChange={(e) => setCustomFrom(e.target.value)}
                              className="h-9 text-xs flex-1"
                            />
                            <span className="text-muted-foreground text-xs">—</span>
                            <Input
                              type="date"
                              value={customTo}
                              onChange={(e) => setCustomTo(e.target.value)}
                              className="h-9 text-xs flex-1"
                            />
                          </div>
                        )}
                      </div>

                      {activeFilterCount > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 text-xs text-muted-foreground self-start"
                          onClick={() => {
                            setPlFilter('all');
                            setCurrencyFilter('ALL');
                            setDateRange('ALL');
                            setCustomFrom('');
                            setCustomTo('');
                          }}
                        >
                          Wyczyść filtry
                        </Button>
                      )}
                    </div>
                  </SheetContent>
                </Sheet>
              </div>

              <div className="hidden md:flex flex-wrap items-center gap-3 mb-4">
                <div className="flex items-center rounded-md border">
                  <Button
                    size="sm"
                    variant={plFilter === 'all' ? 'secondary' : 'ghost'}
                    className="h-7 px-2.5 text-xs rounded-r-none"
                    onClick={() => setPlFilter('all')}
                  >
                    Wszystkie
                  </Button>
                  <Button
                    size="sm"
                    variant={plFilter === 'profit' ? 'secondary' : 'ghost'}
                    className="h-7 px-2.5 text-xs rounded-none border-x"
                    onClick={() => setPlFilter('profit')}
                  >
                    Zyski
                  </Button>
                  <Button
                    size="sm"
                    variant={plFilter === 'loss' ? 'secondary' : 'ghost'}
                    className="h-7 px-2.5 text-xs rounded-l-none"
                    onClick={() => setPlFilter('loss')}
                  >
                    Straty
                  </Button>
                </div>

                {availableCurrencies.length > 1 && (
                  <Select value={currencyFilter} onValueChange={setCurrencyFilter}>
                    <SelectTrigger className="h-7 w-[140px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">Wszystkie waluty</SelectItem>
                      {availableCurrencies.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                {availableCategories.length > 1 && (
                  <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger className="h-7 w-[150px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">Wszystkie kategorie</SelectItem>
                      {availableCategories.map((c) => (
                        <SelectItem key={c} value={c}>
                          {CATEGORY_FILTER_LABELS[c] ?? c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                <div className="ml-auto flex flex-wrap items-center gap-3">
                  <div className="flex items-center rounded-md border">
                    <Button
                      size="sm"
                      variant={dateRange === 'ALL' ? 'secondary' : 'ghost'}
                      className="h-7 px-2.5 text-xs rounded-r-none"
                      onClick={() => setDateRange('ALL')}
                    >
                      Wszystko
                    </Button>
                    {availableYears.slice(0, 4).map((year, i) => (
                      <Button
                        key={year}
                        size="sm"
                        variant={dateRange === String(year) ? 'secondary' : 'ghost'}
                        className={`h-7 px-2.5 text-xs rounded-none border-l ${i === availableYears.slice(0, 4).length - 1 && dateRange !== 'CUSTOM' ? 'rounded-r-md' : ''}`}
                        onClick={() => setDateRange(String(year))}
                      >
                        {year}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      variant={dateRange === 'CUSTOM' ? 'secondary' : 'ghost'}
                      className="h-7 px-2.5 text-xs rounded-l-none border-l"
                      onClick={() => setDateRange('CUSTOM')}
                    >
                      Zakres
                    </Button>
                  </div>

                  {dateRange === 'CUSTOM' && (
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="date"
                        value={customFrom}
                        onChange={(e) => setCustomFrom(e.target.value)}
                        className="h-7 text-xs w-[130px]"
                      />
                      <span className="text-muted-foreground text-xs">—</span>
                      <Input
                        type="date"
                        value={customTo}
                        onChange={(e) => setCustomTo(e.target.value)}
                        className="h-7 text-xs w-[130px]"
                      />
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : null}

          {isLoading ? (
            <LoadingSpinner />
          ) : groups.length ? (
            <>
              <div className="md:hidden flex flex-col gap-2">
                {groups.map((group) => (
                  <ClosedPositionCardMobile
                    key={group.key}
                    group={group}
                    isExpanded={expandedGroups.has(group.key)}
                    onToggle={() => toggleGroup(group.key)}
                    onDelete={() =>
                      setDeleteTarget({
                        ids: group.sellTransactionIds,
                        ticker: group.spreadLabel ?? group.ticker,
                        sellDate: group.sellDate,
                        quantity: group.totalQuantity,
                      })
                    }
                    isDeleting={deleteMutation.isPending}
                  />
                ))}
              </div>
              <div className="hidden md:block overflow-x-auto scroll-shadow-x">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ticker</TableHead>
                      <TableHead className="text-right">Ilość</TableHead>
                      <TableHead>Data kupna</TableHead>
                      <TableHead className="text-right">Cena kupna</TableHead>
                      <TableHead>Data sprzedaży</TableHead>
                      <TableHead className="text-right">Cena sprzedaży</TableHead>
                      <TableHead className="text-right">P/L</TableHead>
                      <TableHead className="text-right">P/L %</TableHead>
                      <TableHead className="text-right">Prowizja</TableHead>
                      <TableHead className="text-right">Dni</TableHead>
                      <TableHead className="w-[40px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.map((group) => {
                      const isSingle = group.trades.length === 1;

                      if (isSingle) {
                        const trade = group.trades[0];
                        return (
                          <TableRow key={group.key}>
                            <TableCell className="font-mono font-medium">
                              <TickerLabel ticker={trade.ticker} />
                              <CategoryBadge category={trade.category} />
                              {trade.isShort && (
                                <span className="ml-1 text-[10px] font-semibold bg-violet-500/15 text-violet-400 px-1 py-0.5 rounded">
                                  SHORT
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatQuantity(trade.quantity)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatDate(trade.buyDate)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatNumber(trade.buyPrice)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {formatDate(trade.sellDate)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatNumber(trade.sellPrice)}
                            </TableCell>
                            <TableCell
                              className={`text-right font-medium ${plColor(trade.profitLossPct)}`}
                            >
                              {formatCurrency(trade.profitLoss, trade.currency)}
                            </TableCell>
                            <TableCell className="text-right">
                              <PLBadge value={trade.profitLossPct} />
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground text-xs">
                              <CostCell trade={trade} />
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {trade.holdingDays}d
                            </TableCell>
                            <TableCell>
                              {group.everyManual && (
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  onClick={() =>
                                    setDeleteTarget({
                                      ids: group.sellTransactionIds,
                                      ticker: group.spreadLabel ?? group.ticker,
                                      sellDate: group.sellDate,
                                      quantity: group.totalQuantity,
                                    })
                                  }
                                  disabled={deleteMutation.isPending}
                                  className="text-muted-foreground hover:text-destructive"
                                  title="Usuń transakcję sprzedaży"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      }

                      // Multi-trade group
                      const isExpanded = expandedGroups.has(group.key);
                      const sameBuyDate =
                        group.minBuyDate.slice(0, 10) === group.maxBuyDate.slice(0, 10);
                      const sameBuyPrice = group.minBuyPrice === group.maxBuyPrice;
                      const sameSellDate =
                        group.minSellDate.slice(0, 10) === group.sellDate.slice(0, 10);
                      const sameSellPrice = group.minSellPrice === group.maxSellPrice;

                      return (
                        <Fragment key={group.key}>
                          <TableRow
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => toggleGroup(group.key)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleGroup(group.key);
                              }
                            }}
                          >
                            <TableCell className="font-mono font-medium">
                              <div className="flex items-center gap-1">
                                {isExpanded ? (
                                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                                ) : (
                                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                                )}
                                {group.spreadLabel ? (
                                  <span className="font-mono font-medium whitespace-nowrap">
                                    {group.spreadLabel}
                                  </span>
                                ) : (
                                  <TickerLabel ticker={group.ticker} />
                                )}
                                <CategoryBadge category={group.trades[0]?.category} />
                                {group.trades.some((t) => t.isShort) && (
                                  <span className="text-[10px] font-semibold bg-violet-500/15 text-violet-400 px-1 py-0.5 rounded">
                                    {group.spreadLabel
                                      ? 'spread'
                                      : group.trades.every((t) => t.isShort)
                                        ? 'SHORT'
                                        : `${group.trades.filter((t) => t.isShort).length}S`}
                                  </span>
                                )}
                                <span className="text-xs text-muted-foreground ml-1">
                                  ({group.trades.length})
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              {formatQuantity(group.totalQuantity)}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">
                              {sameBuyDate
                                ? formatDate(group.minBuyDate)
                                : `${formatDate(group.minBuyDate)} – ${formatDate(group.maxBuyDate)}`}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {sameBuyPrice
                                ? formatNumber(group.minBuyPrice)
                                : `${formatNumber(group.minBuyPrice)} – ${formatNumber(group.maxBuyPrice)}`}
                            </TableCell>
                            <TableCell className="text-muted-foreground text-sm">
                              {sameSellDate
                                ? formatDate(group.sellDate)
                                : `${formatDate(group.minSellDate)} – ${formatDate(group.sellDate)}`}
                            </TableCell>
                            <TableCell className="text-right text-sm">
                              {sameSellPrice
                                ? formatNumber(group.sellPrice)
                                : `${formatNumber(group.minSellPrice)} – ${formatNumber(group.maxSellPrice)}`}
                            </TableCell>
                            <TableCell
                              className={`text-right font-medium ${plColor(group.weightedProfitLossPct)}`}
                            >
                              {formatCurrency(group.totalProfitLoss, group.currency)}
                            </TableCell>
                            <TableCell className="text-right">
                              <PLBadge value={group.weightedProfitLossPct} />
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground text-xs">
                              {group.totalCost > 0 ? formatNumber(group.totalCost) : '—'}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {group.avgHoldingDays}d
                            </TableCell>
                            <TableCell>
                              {group.everyManual && (
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setDeleteTarget({
                                      ids: group.sellTransactionIds,
                                      ticker: group.spreadLabel ?? group.ticker,
                                      sellDate: group.sellDate,
                                      quantity: group.totalQuantity,
                                    });
                                  }}
                                  disabled={deleteMutation.isPending}
                                  className="text-muted-foreground hover:text-destructive"
                                  title="Usuń transakcję sprzedaży"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>

                          {isExpanded &&
                            group.trades.map((trade, j) => (
                              <TableRow key={`${group.key}-${j}`} className="bg-muted/30">
                                <TableCell className="font-mono text-muted-foreground pl-9 text-sm">
                                  {group.spreadLabel ? (
                                    <span className="inline-flex items-center gap-1">
                                      <span className="text-muted-foreground">└</span>
                                      <TickerLabel ticker={trade.ticker} />
                                    </span>
                                  ) : (
                                    `└ lot ${j + 1}`
                                  )}
                                  {trade.isShort && (
                                    <span className="ml-1 text-[10px] font-semibold bg-violet-500/15 text-violet-400 px-1 py-0.5 rounded">
                                      S
                                    </span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground">
                                  {formatQuantity(trade.quantity)}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                  {formatDate(trade.buyDate)}
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground">
                                  {formatNumber(trade.buyPrice)}
                                </TableCell>
                                <TableCell className="text-muted-foreground">
                                  {formatDate(trade.sellDate)}
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground">
                                  {formatNumber(trade.sellPrice)}
                                </TableCell>
                                <TableCell
                                  className={`text-right text-sm ${trade.profitLossPct >= 0 ? 'text-gain/70' : 'text-loss/70'}`}
                                >
                                  {formatCurrency(trade.profitLoss, trade.currency)}
                                </TableCell>
                                <TableCell className="text-right">
                                  <PLBadge value={trade.profitLossPct} muted />
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground text-xs">
                                  <CostCell trade={trade} muted />
                                </TableCell>
                                <TableCell className="text-right text-muted-foreground">
                                  {trade.holdingDays}d
                                </TableCell>
                                <TableCell />
                              </TableRow>
                            ))}
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {plSummary.length > 0 && (
                <div className="mt-4 flex flex-wrap items-center gap-3 md:gap-4 border-t pt-4">
                  <span className="text-sm font-medium text-muted-foreground">
                    Podsumowanie P/L:
                  </span>
                  {plSummary.map((s) => (
                    <div key={s.currency} className="flex items-center gap-2">
                      <span
                        className={`text-sm font-semibold ${s.totalPL >= 0 ? 'text-gain' : 'text-loss'}`}
                      >
                        {formatCurrency(s.totalPL, s.currency)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ({s.count} poz: {s.wins}Z / {s.losses}S)
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : data?.trades?.length ? (
            <EmptyState
              message="Brak transakcji dla wybranych filtrów."
              action={{
                label: 'Wyczyść filtry',
                onClick: () => {
                  setPlFilter('all');
                  setCurrencyFilter('ALL');
                  setDateRange('ALL');
                },
              }}
            />
          ) : (
            <EmptyState message="Brak zamkniętych transakcji. Zaimportuj historię transakcji lub dodaj ręcznie." />
          )}
        </CardContent>
      </Card>

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.ids)}
        description={
          deleteTarget
            ? deleteTarget.ids.length > 1
              ? `Usunąć ${deleteTarget.ids.length} transakcje sprzedaży ${displayOptionTicker(deleteTarget.ticker)} (łącznie ${formatQuantity(deleteTarget.quantity)} szt)? Pozycja wróci do otwartych.`
              : `Usunąć transakcję sprzedaży ${displayOptionTicker(deleteTarget.ticker)} — ${formatQuantity(deleteTarget.quantity)} szt z ${formatDate(deleteTarget.sellDate)}? Pozycja wróci do otwartych.`
            : ''
        }
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
