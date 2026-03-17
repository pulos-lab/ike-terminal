import { useState, useMemo, Fragment } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatNumber, formatPercent, formatDate, formatCurrency } from '@/lib/formatters';
import { ChevronRight, ChevronDown, Loader2, Trash2 } from 'lucide-react';
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
  weightedProfitLossPct: number;
  minBuyDate: string;
  maxBuyDate: string;
  minBuyPrice: number;
  maxBuyPrice: number;
  avgHoldingDays: number;
  sellTransactionId: number;
  sellSource: 'bossa' | 'mbank' | 'degiro' | 'manual';
  trades: ClosedTrade[];
}

export function ClosedTradesPage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['portfolio', 'closed-trades'],
    queryFn: api.getClosedTrades,
  });

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteTransaction(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'positions'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'transactions'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'closed-trades'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'metrics'] });
      queryClient.invalidateQueries({ queryKey: ['portfolio', 'history'] });
    },
  });

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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

      result.push({
        key,
        ticker: first.ticker,
        paperName: first.paperName,
        sellDate: first.sellDate,
        sellPrice: first.sellPrice,
        currency: first.currency,
        totalQuantity,
        totalProfitLoss,
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
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
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
                    <TableHead className="text-right">Dni</TableHead>
                    <TableHead className="w-[40px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((group) => {
                    const isSingle = group.trades.length === 1;

                    if (isSingle) {
                      const trade = group.trades[0];
                      const isPositive = trade.profitLossPct >= 0;
                      return (
                        <TableRow key={group.key}>
                          <TableCell className="font-mono font-medium">{trade.ticker}</TableCell>
                          <TableCell className="text-right">{trade.quantity}</TableCell>
                          <TableCell className="text-muted-foreground">{formatDate(trade.buyDate)}</TableCell>
                          <TableCell className="text-right">{formatNumber(trade.buyPrice)}</TableCell>
                          <TableCell className="text-muted-foreground">{formatDate(trade.sellDate)}</TableCell>
                          <TableCell className="text-right">{formatNumber(trade.sellPrice)}</TableCell>
                          <TableCell className={`text-right font-medium ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
                            {formatCurrency(trade.profitLoss, trade.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge variant={isPositive ? 'default' : 'destructive'} className={`text-xs ${isPositive ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                              {formatPercent(trade.profitLossPct)}
                            </Badge>
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
                    const isPositive = group.weightedProfitLossPct >= 0;
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
                              <span className="text-xs text-muted-foreground ml-1">({group.trades.length})</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right">{group.totalQuantity}</TableCell>
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
                          <TableCell className={`text-right font-medium ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
                            {formatCurrency(group.totalProfitLoss, group.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            <Badge variant={isPositive ? 'default' : 'destructive'} className={`text-xs ${isPositive ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                              {formatPercent(group.weightedProfitLossPct)}
                            </Badge>
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

                        {isExpanded && group.trades.map((trade, j) => {
                          const tradePositive = trade.profitLossPct >= 0;
                          return (
                            <TableRow key={`${group.key}-${j}`} className="bg-muted/30">
                              <TableCell className="font-mono text-muted-foreground pl-9 text-sm">
                                └ lot {j + 1}
                              </TableCell>
                              <TableCell className="text-right text-muted-foreground">{trade.quantity}</TableCell>
                              <TableCell className="text-muted-foreground">{formatDate(trade.buyDate)}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{formatNumber(trade.buyPrice)}</TableCell>
                              <TableCell className="text-muted-foreground">{formatDate(trade.sellDate)}</TableCell>
                              <TableCell className="text-right text-muted-foreground">{formatNumber(trade.sellPrice)}</TableCell>
                              <TableCell className={`text-right text-sm ${tradePositive ? 'text-green-500/70' : 'text-red-500/70'}`}>
                                {formatCurrency(trade.profitLoss, trade.currency)}
                              </TableCell>
                              <TableCell className="text-right">
                                <Badge variant={tradePositive ? 'default' : 'destructive'} className={`text-xs ${tradePositive ? 'bg-green-500/10 text-green-500/70' : 'bg-red-500/10 text-red-500/70'}`}>
                                  {formatPercent(trade.profitLossPct)}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-right text-muted-foreground">{trade.holdingDays}d</TableCell>
                              <TableCell />
                            </TableRow>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">Brak danych.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
