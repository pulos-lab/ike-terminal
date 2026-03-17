import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { formatCurrency, formatNumber, formatPercent, formatPLN } from '@/lib/formatters';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { PortfolioDiversification } from './PortfolioDiversification';

interface ColumnVisibility {
  avgPrice: boolean;
  dailyChange: boolean;
  pl: boolean;
  plPct: boolean;
}

const STORAGE_KEY = 'portfolio-col-visibility';

const DEFAULT_VISIBILITY: ColumnVisibility = {
  avgPrice: true,
  dailyChange: true,
  pl: true,
  plPct: true,
};

function loadVisibility(): ColumnVisibility {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...DEFAULT_VISIBILITY, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return { ...DEFAULT_VISIBILITY };
}

function saveVisibility(v: ColumnVisibility) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
}

export function PortfolioPage() {
  const [colVis, setColVis] = useState<ColumnVisibility>(loadVisibility);

  const toggleCol = (key: keyof ColumnVisibility) => {
    setColVis(prev => {
      const next = { ...prev, [key]: !prev[key] };
      saveVisibility(next);
      return next;
    });
  };

  const allVisible = colVis.avgPrice && colVis.dailyChange && colVis.pl && colVis.plPct;

  const { data, isLoading } = useQuery({
    queryKey: ['portfolio', 'positions'],
    queryFn: api.getPositions,
    refetchInterval: 15 * 60 * 1000, // auto-refresh every 15 min
  });

  const totals = useMemo(() => {
    if (!data?.positions?.length) return null;
    const totalValuePln = data.totalValuePln ?? data.positions.reduce((s: number, p: any) => s + p.currentValuePln, 0);
    const totalProfitLoss = data.positions.reduce((s: number, p: any) => s + (p.profitLossPln ?? p.profitLoss), 0);
    const totalCostBasis = (data.stocksValuePln ?? totalValuePln) - totalProfitLoss;
    const totalProfitLossPct = totalCostBasis > 0 ? (totalProfitLoss / totalCostBasis) * 100 : 0;
    const cashValuePln = data.cashValuePln ?? 0;
    return { totalValuePln, totalProfitLoss, totalProfitLossPct, cashValuePln };
  }, [data]);

  const cashPositions = data?.cashPositions ?? [];

  // Columns before "Wartość (PLN)": Ticker, Nazwa, Ilość, [Śr. cena], Prowizje, Kurs, [Zmiana]
  const colsBeforeValue = 5 + (colVis.avgPrice ? 1 : 0) + (colVis.dailyChange ? 1 : 0);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Struktura portfela</h1>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              Otwarte pozycje
              {data && (
                <span className="ml-2 text-muted-foreground font-normal">
                  ({data.positions.length} pozycji | {formatPLN(data.stocksValuePln ?? data.totalValuePln)})
                </span>
              )}
            </CardTitle>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground"
                  title="Widoczność kolumn"
                >
                  {allVisible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Widoczność kolumn</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={colVis.avgPrice}
                  onCheckedChange={() => toggleCol('avgPrice')}
                >
                  Śr. cena nabycia
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={colVis.dailyChange}
                  onCheckedChange={() => toggleCol('dailyChange')}
                >
                  Dzienna zmiana %
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={colVis.pl}
                  onCheckedChange={() => toggleCol('pl')}
                >
                  P/L
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={colVis.plPct}
                  onCheckedChange={() => toggleCol('plPct')}
                >
                  P/L %
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : data?.positions?.length ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ticker</TableHead>
                    <TableHead>Nazwa</TableHead>
                    <TableHead className="text-right">Ilość</TableHead>
                    {colVis.avgPrice && <TableHead className="text-right">Śr. cena</TableHead>}
                    <TableHead className="text-right">Prowizje</TableHead>
                    <TableHead className="text-right">Kurs</TableHead>
                    {colVis.dailyChange && <TableHead className="text-right">Zmiana</TableHead>}
                    <TableHead className="text-right">Wartość (PLN)</TableHead>
                    {colVis.pl && <TableHead className="text-right">P/L</TableHead>}
                    {colVis.plPct && <TableHead className="text-right">P/L %</TableHead>}
                    <TableHead className="text-right">Udział</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.positions.map((pos: any) => {
                    const isPositive = pos.profitLossPct >= 0;
                    return (
                      <TableRow key={pos.isin}>
                        <TableCell className="font-mono font-medium">{pos.ticker}</TableCell>
                        <TableCell className="text-muted-foreground">{pos.paperName}</TableCell>
                        <TableCell className="text-right">{pos.shares}</TableCell>
                        {colVis.avgPrice && (
                          <TableCell className="text-right">{formatNumber(pos.avgBuyPrice)}</TableCell>
                        )}
                        <TableCell className="text-right text-muted-foreground">{formatNumber(pos.totalCommission)}</TableCell>
                        <TableCell className="text-right">
                          {pos.currentPrice ? formatNumber(pos.currentPrice) : '—'}
                          <span className="text-xs text-muted-foreground ml-1">{pos.currency}</span>
                        </TableCell>
                        {colVis.dailyChange && (
                          <TableCell className="text-right">
                            {pos.dailyChangePct != null ? (
                              <Badge
                                variant={pos.dailyChangePct >= 0 ? 'default' : 'destructive'}
                                className={`text-xs ${pos.dailyChangePct >= 0 ? 'bg-green-500/10 text-green-500 hover:bg-green-500/20' : 'bg-red-500/10 text-red-500 hover:bg-red-500/20'}`}
                              >
                                {formatPercent(pos.dailyChangePct)}
                              </Badge>
                            ) : '—'}
                          </TableCell>
                        )}
                        <TableCell className="text-right font-medium">{formatPLN(pos.currentValuePln)}</TableCell>
                        {colVis.pl && (
                          <TableCell className={`text-right font-medium ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
                            {formatCurrency(pos.profitLoss, pos.currency)}
                          </TableCell>
                        )}
                        {colVis.plPct && (
                          <TableCell className="text-right">
                            <Badge variant={isPositive ? 'default' : 'destructive'} className={`text-xs ${isPositive ? 'bg-green-500/10 text-green-500 hover:bg-green-500/20' : 'bg-red-500/10 text-red-500 hover:bg-red-500/20'}`}>
                              {formatPercent(pos.profitLossPct)}
                            </Badge>
                          </TableCell>
                        )}
                        <TableCell className="text-right text-muted-foreground">
                          {formatPercent(pos.weight).replace('+', '')}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {totals && (() => {
                    const isPositive = totals.totalProfitLoss >= 0;
                    return (
                      <TableRow className="border-t-2 font-semibold">
                        <TableCell colSpan={colsBeforeValue} className="text-right">Razem</TableCell>
                        <TableCell className="text-right">{formatPLN(totals.totalValuePln)}</TableCell>
                        {colVis.pl && (
                          <TableCell className={`text-right ${isPositive ? 'text-green-500' : 'text-red-500'}`}>
                            {formatPLN(totals.totalProfitLoss)}
                          </TableCell>
                        )}
                        {colVis.plPct && (
                          <TableCell className="text-right">
                            <Badge variant={isPositive ? 'default' : 'destructive'} className={`text-xs ${isPositive ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                              {formatPercent(totals.totalProfitLossPct)}
                            </Badge>
                          </TableCell>
                        )}
                        <TableCell />
                      </TableRow>
                    );
                  })()}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              Brak otwartych pozycji. Zaimportuj historię transakcji.
            </div>
          )}
        </CardContent>
      </Card>

      {cashPositions.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Wolna gotówka
              <span className="ml-2 text-muted-foreground font-normal">
                ({formatPLN(data?.cashValuePln ?? 0)})
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Waluta</TableHead>
                  <TableHead className="text-right">Saldo</TableHead>
                  <TableHead className="text-right">Wartość (PLN)</TableHead>
                  <TableHead className="text-right">Udział w portfelu</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cashPositions.map((cp: any) => (
                  <TableRow key={cp.currency}>
                    <TableCell className="font-mono font-medium">{cp.currency}</TableCell>
                    <TableCell className="text-right">{formatNumber(cp.balance)} {cp.currency}</TableCell>
                    <TableCell className="text-right font-medium">{formatPLN(cp.valuePln)}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {formatPercent(cp.weight).replace('+', '')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {data?.positions?.length > 0 && (
        <PortfolioDiversification
          positions={data.positions}
          totalValuePln={data.totalValuePln}
        />
      )}
    </div>
  );
}
