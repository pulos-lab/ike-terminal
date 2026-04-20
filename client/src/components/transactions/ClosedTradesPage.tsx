import { useMemo, useState, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidatePortfolio } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { formatNumber, formatDate, formatCurrency, formatQuantity } from '@/lib/formatters';
import { useToggleSet } from '@/hooks/useToggleSet';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { ChevronRight, ChevronDown, Trash2 } from 'lucide-react';
import type { ClosedTrade } from 'shared';

interface TradeGroup {
  key: string;
  ticker: string;
  paperName: string;
  sellDate: string;
  sellPrice: number;
  currency: string;
  totalQuantity: number;
  totalProfitLoss: number;
  totalCost: number;
  weightedProfitLossPct: number;
  minBuyDate: string;
  maxBuyDate: string;
  minBuyPrice: number;
  maxBuyPrice: number;
  avgHoldingDays: number;
  sellTransactionId: number;
  sellSource: 'bossa' | 'mbank' | 'degiro' | 'xtb' | 'manual' | 'auto-yahoo';
  trades: ClosedTrade[];
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

export function ClosedTradesPage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.closedTrades,
    queryFn: api.getClosedTrades,
  });

  const [expandedGroups, toggleGroup] = useToggleSet<string>();

  const [plFilter, setPlFilter] = useState<'all' | 'profit' | 'loss'>('all');
  const [currencyFilter, setCurrencyFilter] = useState<string>('ALL');
  const [dateRange, setDateRange] = useState<string>('ALL');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteTransaction(id),
    onSuccess: () => invalidatePortfolio(queryClient),
  });

  const availableCurrencies = useMemo(() => {
    if (!data?.trades?.length) return [];
    const set = new Set<string>();
    for (const trade of data.trades as ClosedTrade[]) set.add(trade.currency);
    return Array.from(set).sort();
  }, [data]);

  const availableYears = useMemo(() => {
    if (!data?.trades?.length) return [];
    const set = new Set<number>();
    for (const trade of data.trades as ClosedTrade[]) set.add(new Date(trade.sellDate).getFullYear());
    return Array.from(set).sort((a, b) => b - a);
  }, [data]);

  const filteredTrades = useMemo(() => {
    if (!data?.trades?.length) return [];
    let trades = data.trades as ClosedTrade[];

    if (plFilter === 'profit') trades = trades.filter(t => t.profitLoss > 0);
    else if (plFilter === 'loss') trades = trades.filter(t => t.profitLoss < 0);

    if (currencyFilter !== 'ALL') trades = trades.filter(t => t.currency === currencyFilter);

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
      if (fromDate) trades = trades.filter(t => t.sellDate.slice(0, 10) >= fromDate!);
      if (toDate) trades = trades.filter(t => t.sellDate.slice(0, 10) <= toDate!);
    }

    return trades;
  }, [data, plFilter, currencyFilter, dateRange, customFrom, customTo]);

  const groups = useMemo(() => {
    if (!filteredTrades.length) return [];

    const map = new Map<string, ClosedTrade[]>();
    for (const trade of filteredTrades) {
      const sellDay = trade.sellDate.slice(0, 10);
      const key = `${trade.ticker}|${sellDay}`;
      const arr = map.get(key) || [];
      arr.push(trade);
      map.set(key, arr);
    }

    const result: TradeGroup[] = [];
    for (const [key, trades] of map) {
      const first = trades[0];
      const totalQuantity = trades.reduce((s, t) => s + t.quantity, 0);
      const totalProfitLoss = trades.reduce((s, t) => s + t.profitLoss, 0);
      // Use quantity-weighted average of individual P/L% (correct for both stocks and CFD)
      const weightedProfitLossPct = totalQuantity > 0
        ? trades.reduce((s, t) => s + t.profitLossPct * t.quantity, 0) / totalQuantity
        : 0;

      const buyDates = trades.map(t => t.buyDate).sort();
      const buyPrices = trades.map(t => t.buyPrice);
      const totalHoldingDaysWeighted = trades.reduce((s, t) => s + t.holdingDays * t.quantity, 0);

      const totalCost = trades.reduce((s, t) => s + (t.totalCost || t.buyCommission + t.sellCommission), 0);

      result.push({
        key,
        ticker: first.ticker,
        paperName: first.paperName,
        sellDate: first.sellDate,
        sellPrice: first.sellPrice,
        currency: first.currency,
        totalQuantity,
        totalProfitLoss,
        totalCost,
        weightedProfitLossPct,
        minBuyDate: buyDates[0],
        maxBuyDate: buyDates[buyDates.length - 1],
        minBuyPrice: Math.min(...buyPrices),
        maxBuyPrice: Math.max(...buyPrices),
        avgHoldingDays: Math.round(totalHoldingDaysWeighted / totalQuantity),
        sellTransactionId: first.sellTransactionId,
        sellSource: first.sellSource,
        trades,
      });
    }

    result.sort((a, b) => b.sellDate.localeCompare(a.sellDate));
    return result;
  }, [filteredTrades]);

  const plSummary = useMemo(() => {
    const map = new Map<string, { currency: string; totalPL: number; count: number; wins: number; losses: number }>();
    for (const group of groups) {
      const s = map.get(group.currency) || { currency: group.currency, totalPL: 0, count: 0, wins: 0, losses: 0 };
      s.totalPL += group.totalProfitLoss;
      s.count += 1;
      if (group.totalProfitLoss > 0) s.wins += 1;
      else if (group.totalProfitLoss < 0) s.losses += 1;
      map.set(group.currency, s);
    }
    return Array.from(map.values()).sort((a, b) => a.currency.localeCompare(b.currency));
  }, [groups]);

  const totalTrades = data?.trades?.length ?? 0;
  const isFiltered = plFilter !== 'all' || currencyFilter !== 'ALL' || dateRange !== 'ALL';

  return (
    <div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Historia zamkniętych pozycji (FIFO)
            {groups.length > 0 && (
              <span className="ml-2 text-muted-foreground font-normal">
                ({groups.length} pozycji, {filteredTrades.length} transakcji{isFiltered && ` z ${totalTrades}`})
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!isLoading && data?.trades?.length ? (
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <div className="flex items-center rounded-md border">
                <Button size="sm" variant={plFilter === 'all' ? 'secondary' : 'ghost'} className="h-7 px-2.5 text-xs rounded-r-none" onClick={() => setPlFilter('all')}>Wszystkie</Button>
                <Button size="sm" variant={plFilter === 'profit' ? 'secondary' : 'ghost'} className="h-7 px-2.5 text-xs rounded-none border-x" onClick={() => setPlFilter('profit')}>Zyski</Button>
                <Button size="sm" variant={plFilter === 'loss' ? 'secondary' : 'ghost'} className="h-7 px-2.5 text-xs rounded-l-none" onClick={() => setPlFilter('loss')}>Straty</Button>
              </div>

              {availableCurrencies.length > 1 && (
                <Select value={currencyFilter} onValueChange={setCurrencyFilter}>
                  <SelectTrigger className="h-7 w-[140px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">Wszystkie waluty</SelectItem>
                    {availableCurrencies.map(c => (
                      <SelectItem key={c} value={c}>{c}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <div className="ml-auto flex flex-wrap items-center gap-3">
                <div className="flex items-center rounded-md border">
                  <Button size="sm" variant={dateRange === 'ALL' ? 'secondary' : 'ghost'} className="h-7 px-2.5 text-xs rounded-r-none" onClick={() => setDateRange('ALL')}>Wszystko</Button>
                  {availableYears.slice(0, 4).map((year, i) => (
                    <Button key={year} size="sm" variant={dateRange === String(year) ? 'secondary' : 'ghost'} className={`h-7 px-2.5 text-xs rounded-none border-l ${i === availableYears.slice(0, 4).length - 1 && dateRange !== 'CUSTOM' ? 'rounded-r-md' : ''}`} onClick={() => setDateRange(String(year))}>{year}</Button>
                  ))}
                  <Button size="sm" variant={dateRange === 'CUSTOM' ? 'secondary' : 'ghost'} className="h-7 px-2.5 text-xs rounded-l-none border-l" onClick={() => setDateRange('CUSTOM')}>Zakres</Button>
                </div>

                {dateRange === 'CUSTOM' && (
                  <div className="flex items-center gap-1.5">
                    <Input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="h-7 text-xs w-[130px]" />
                    <span className="text-muted-foreground text-xs">—</span>
                    <Input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="h-7 text-xs w-[130px]" />
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {isLoading ? (
            <LoadingSpinner />
          ) : groups.length ? (
            <div className="overflow-x-auto">
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
                            {trade.ticker}
                            <CategoryBadge category={trade.category} />
                            {trade.isShort && <span className="ml-1 text-[10px] font-semibold bg-violet-500/15 text-violet-400 px-1 py-0.5 rounded">SHORT</span>}
                          </TableCell>
                          <TableCell className="text-right">{formatQuantity(trade.quantity)}</TableCell>
                          <TableCell className="text-muted-foreground">{formatDate(trade.buyDate)}</TableCell>
                          <TableCell className="text-right">{formatNumber(trade.buyPrice)}</TableCell>
                          <TableCell className="text-muted-foreground">{formatDate(trade.sellDate)}</TableCell>
                          <TableCell className="text-right">{formatNumber(trade.sellPrice)}</TableCell>
                          <TableCell className={`text-right font-medium ${plColor(trade.profitLossPct)}`}>
                            {formatCurrency(trade.profitLoss, trade.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            <PLBadge value={trade.profitLossPct} />
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground text-xs">
                            <CostCell trade={trade} />
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">{trade.holdingDays}d</TableCell>
                          <TableCell>
                            {trade.sellSource === 'manual' && (
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => deleteMutation.mutate(trade.sellTransactionId)}
                                disabled={deleteMutation.isPending}
                                className="text-muted-foreground hover:text-red-500"
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
                    const sameBuyDate = group.minBuyDate.slice(0, 10) === group.maxBuyDate.slice(0, 10);
                    const sameBuyPrice = group.minBuyPrice === group.maxBuyPrice;

                    return (
                      <Fragment key={group.key}>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/50"
                          onClick={() => toggleGroup(group.key)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(group.key); } }}
                        >
                          <TableCell className="font-mono font-medium">
                            <div className="flex items-center gap-1">
                              {isExpanded
                                ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                                : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                              }
                              {group.ticker}
                              <CategoryBadge category={group.trades[0]?.category} />
                              {group.trades.some(t => t.isShort) && <span className="text-[10px] font-semibold bg-violet-500/15 text-violet-400 px-1 py-0.5 rounded">{group.trades.every(t => t.isShort) ? 'SHORT' : `${group.trades.filter(t => t.isShort).length}S`}</span>}
                              <span className="text-xs text-muted-foreground ml-1">({group.trades.length})</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right">{formatQuantity(group.totalQuantity)}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {sameBuyDate
                              ? formatDate(group.minBuyDate)
                              : `${formatDate(group.minBuyDate)} – ${formatDate(group.maxBuyDate)}`
                            }
                          </TableCell>
                          <TableCell className="text-right text-sm">
                            {sameBuyPrice
                              ? formatNumber(group.minBuyPrice)
                              : `${formatNumber(group.minBuyPrice)} – ${formatNumber(group.maxBuyPrice)}`
                            }
                          </TableCell>
                          <TableCell className="text-muted-foreground">{formatDate(group.sellDate)}</TableCell>
                          <TableCell className="text-right">{formatNumber(group.sellPrice)}</TableCell>
                          <TableCell className={`text-right font-medium ${plColor(group.weightedProfitLossPct)}`}>
                            {formatCurrency(group.totalProfitLoss, group.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            <PLBadge value={group.weightedProfitLossPct} />
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground text-xs">
                            {group.totalCost > 0 ? formatNumber(group.totalCost) : '—'}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">{group.avgHoldingDays}d</TableCell>
                          <TableCell>
                            {group.sellSource === 'manual' && (
                              <Button
                                size="icon-xs"
                                variant="ghost"
                                onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(group.sellTransactionId); }}
                                disabled={deleteMutation.isPending}
                                className="text-muted-foreground hover:text-red-500"
                                title="Usuń transakcję sprzedaży"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>

                        {isExpanded && group.trades.map((trade, j) => (
                            <TableRow key={`${group.key}-${j}`} className="bg-muted/30">
                              <TableCell className="font-mono text-muted-foreground pl-9 text-sm">
                                └ lot {j + 1}
                                {trade.isShort && <span className="ml-1 text-[10px] font-semibold bg-violet-500/15 text-violet-400 px-1 py-0.5 rounded">S</span>}
                              </TableCell>
                              <TableCell className="text-right text-muted-foreground">{formatQuantity(trade.quantity)}</TableCell>
                              <TableCell className="text-muted-foreground">{formatDate(trade.buyDate)}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{formatNumber(trade.buyPrice)}</TableCell>
                              <TableCell className="text-muted-foreground">{formatDate(trade.sellDate)}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{formatNumber(trade.sellPrice)}</TableCell>
                              <TableCell className={`text-right text-sm ${trade.profitLossPct >= 0 ? 'text-green-500/70' : 'text-red-500/70'}`}>
                                {formatCurrency(trade.profitLoss, trade.currency)}
                              </TableCell>
                              <TableCell className="text-right">
                                <PLBadge value={trade.profitLossPct} muted />
                              </TableCell>
                              <TableCell className="text-right text-muted-foreground text-xs">
                                <CostCell trade={trade} muted />
                              </TableCell>
                              <TableCell className="text-right text-muted-foreground">{trade.holdingDays}d</TableCell>
                              <TableCell />
                            </TableRow>
                        ))}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
              {plSummary.length > 0 && (
                <div className="mt-4 flex flex-wrap items-center gap-4 border-t pt-4">
                  <span className="text-sm font-medium text-muted-foreground">Podsumowanie P/L:</span>
                  {plSummary.map(s => (
                    <div key={s.currency} className="flex items-center gap-2">
                      <span className={`text-sm font-semibold ${s.totalPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {formatCurrency(s.totalPL, s.currency)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ({s.count} poz: {s.wins}Z / {s.losses}S)
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : data?.trades?.length ? (
            <EmptyState message="Brak transakcji dla wybranych filtrów." />
          ) : (
            <EmptyState message="Brak danych." />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
