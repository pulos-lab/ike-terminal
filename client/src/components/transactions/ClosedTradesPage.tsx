import { useMemo, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidatePortfolio } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { formatNumber, formatDate, formatCurrency, formatQuantity } from '@/lib/formatters';
import { useToggleSet } from '@/hooks/useToggleSet';
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

export function ClosedTradesPage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.closedTrades,
    queryFn: api.getClosedTrades,
  });

  const [expandedGroups, toggleGroup] = useToggleSet<string>();

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteTransaction(id),
    onSuccess: () => invalidatePortfolio(queryClient),
  });

  const groups = useMemo(() => {
    if (!data?.trades?.length) return [];

    const map = new Map<string, ClosedTrade[]>();
    for (const trade of data.trades as ClosedTrade[]) {
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
      const totalBuyValue = trades.reduce((s, t) => s + t.quantity * t.buyPrice, 0);
      const weightedProfitLossPct = totalBuyValue > 0 ? (totalProfitLoss / totalBuyValue) * 100 : 0;

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
  }, [data]);

  const totalTrades = data?.trades?.length ?? 0;

  return (
    <div>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Historia zamkniętych pozycji (FIFO)
            {groups.length > 0 && (
              <span className="ml-2 text-muted-foreground font-normal">
                ({groups.length} pozycji, {totalTrades} transakcji)
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
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
                            {(trade.totalCost || 0) > 0 ? formatNumber(trade.totalCost!) : '—'}
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
                                {(trade.totalCost || 0) > 0 ? formatNumber(trade.totalCost!) : '—'}
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
            </div>
          ) : (
            <EmptyState message="Brak danych." />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
