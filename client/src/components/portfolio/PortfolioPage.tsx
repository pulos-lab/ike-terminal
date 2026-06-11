import { useMemo, useState, useRef, useLayoutEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
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
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { CcyChip } from '@/components/ui/ccy-chip';
import {
  formatCurrency,
  formatNumber,
  formatPercent,
  formatPLN,
  formatQuantity,
} from '@/lib/formatters';
import { Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PortfolioDiversification } from './PortfolioDiversification';
import { PortfolioPositionCardMobile } from './PortfolioPositionCardMobile';
import { useToggleSet } from '@/hooks/useToggleSet';

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
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_VISIBILITY };
}

function saveVisibility(v: ColumnVisibility) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
}

export function PortfolioPage() {
  const [colVis, setColVis] = useState<ColumnVisibility>(loadVisibility);
  const [expandedPositions, togglePosition] = useToggleSet<string>();

  const toggleCol = (key: keyof ColumnVisibility) => {
    setColVis((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveVisibility(next);
      return next;
    });
  };

  const allVisible = colVis.avgPrice && colVis.dailyChange && colVis.pl && colVis.plPct;

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.positions,
    queryFn: api.getPositions,
    refetchInterval: 15 * 60 * 1000, // auto-refresh every 15 min
  });

  // Waluta bazowa portfela — PLN dla polskich/mixed, USD/EUR dla single-currency
  // (np. XTB USD sub-konto). Gdy != PLN, wyświetlamy natywne wartości pozycji
  // (currentValue, profitLoss) zamiast PLN-konwersji.
  const baseCurrency: string = data?.baseCurrency || 'PLN';
  const useNativeCcy = baseCurrency !== 'PLN';

  const totals = useMemo(() => {
    if (!data?.positions?.length) return null;
    if (useNativeCcy) {
      // Sumy w walucie portfela — raw sum z pos.currentValue/profitLoss (native)
      const totalValue = data.positions.reduce((s, p) => s + p.currentValue, 0);
      const totalProfitLoss = data.positions.reduce((s, p) => s + p.profitLoss, 0);
      const totalCostBasis = totalValue - totalProfitLoss;
      const totalProfitLossPct = totalCostBasis > 0 ? (totalProfitLoss / totalCostBasis) * 100 : 0;
      return {
        totalValue,
        totalProfitLoss,
        totalProfitLossPct,
        totalValuePln: data.totalValuePln,
        cashValuePln: data.cashValuePln,
      };
    }
    const totalValue = data.totalValuePln;
    const totalProfitLoss = data.positions.reduce((s, p) => s + p.profitLossPln, 0);
    const totalCostBasis = data.stocksValuePln - totalProfitLoss;
    const totalProfitLossPct = totalCostBasis > 0 ? (totalProfitLoss / totalCostBasis) * 100 : 0;
    return {
      totalValue,
      totalProfitLoss,
      totalProfitLossPct,
      totalValuePln: totalValue,
      cashValuePln: data.cashValuePln,
    };
  }, [data, useNativeCcy]);

  const recentSplitMap = useMemo(() => {
    const map = new Map<string, { ratio: number; date: string }>();
    for (const s of data?.recentSplits ?? []) {
      map.set(s.isin, { ratio: s.ratio, date: s.date });
    }
    return map;
  }, [data?.recentSplits]);

  const cashPositions = data?.cashPositions ?? [];

  // Columns before "Wartość (PLN)": Ticker, Nazwa, Ilość, [Śr. cena], Prowizje, Kurs, [Zmiana]
  const colsBeforeValue = 5 + (colVis.avgPrice ? 1 : 0) + (colVis.dailyChange ? 1 : 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              Otwarte pozycje
              {data && (
                <span className="ml-2 text-muted-foreground font-normal">
                  ({data.positions.length} pozycji |{' '}
                  {useNativeCcy
                    ? formatCurrency(totals?.totalValue ?? 0, baseCurrency)
                    : formatPLN(data.stocksValuePln ?? data.totalValuePln)}
                  )
                </span>
              )}
            </CardTitle>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hidden md:inline-flex"
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
            <LoadingSpinner />
          ) : data?.positions?.length ? (
            <>
              <div className="md:hidden flex flex-col gap-2">
                {data.positions.map((pos) => (
                  <PortfolioPositionCardMobile
                    key={pos.isin}
                    position={pos}
                    baseCurrency={baseCurrency}
                    useNativeCcy={useNativeCcy}
                    splitInfo={recentSplitMap.get(pos.isin)}
                    isExpanded={expandedPositions.has(pos.isin)}
                    onToggle={() => togglePosition(pos.isin)}
                  />
                ))}
                {totals && (
                  <div className="rounded-xl border-2 border-border bg-card p-3 flex items-center justify-between gap-2 font-semibold">
                    <span className="text-sm">Razem</span>
                    <div className="flex items-center gap-3 text-sm tabular-nums">
                      <span>
                        {useNativeCcy
                          ? formatCurrency(totals.totalValue, baseCurrency)
                          : formatPLN(totals.totalValuePln)}
                      </span>
                      <span className={plColor(totals.totalProfitLoss)}>
                        {useNativeCcy
                          ? formatCurrency(totals.totalProfitLoss, baseCurrency)
                          : formatPLN(totals.totalProfitLoss)}
                      </span>
                      <PLBadge value={totals.totalProfitLossPct} />
                    </div>
                  </div>
                )}
              </div>
              <div className="hidden md:block overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ticker</TableHead>
                      <TableHead>Nazwa</TableHead>
                      <TableHead className="text-right">Ilość</TableHead>
                      {colVis.avgPrice && <TableHead className="text-right">Śr. cena</TableHead>}
                      <TableHead className="text-right">Kurs</TableHead>
                      {colVis.dailyChange && <TableHead className="text-right">Zmiana</TableHead>}
                      <TableHead className="text-right">Wartość ({baseCurrency})</TableHead>
                      {colVis.pl && <TableHead className="text-right">P/L</TableHead>}
                      {colVis.plPct && <TableHead className="text-right">P/L %</TableHead>}
                      <TableHead className="text-right">Udział</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.positions.map((pos) => (
                      <TableRow key={pos.isin}>
                        <TableCell className="font-mono font-medium">
                          {pos.ticker}
                          <CategoryBadge category={pos.category} />
                          {pos.maturityPassed && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <AlertTriangle className="h-4 w-4 text-amber-500 inline ml-1 cursor-help" />
                              </TooltipTrigger>
                              <TooltipContent side="right" className="max-w-[280px]">
                                Obligacja po terminie wykupu, a pozycja wciąż otwarta —
                                prawdopodobnie brakuje operacji wykupu. Zaimportuj aktualny plik
                                operacji z Bossy albo dodaj sprzedaż ręcznie w panelu Transakcje.
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {recentSplitMap.has(pos.isin) &&
                            (() => {
                              const split = recentSplitMap.get(pos.isin)!;
                              const isReverse = split.ratio < 1;
                              const label = isReverse
                                ? `1:${Math.round(1 / split.ratio)}`
                                : `${Math.round(split.ratio)}:1`;
                              return (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <AlertTriangle className="h-4 w-4 text-amber-500 inline ml-1 cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="right" className="max-w-[280px]">
                                    Spółka przeszła {isReverse ? 'reverse split' : 'split'} {label}{' '}
                                    w dniu {split.date}. Ilość i cena zostały automatycznie
                                    skorygowane.
                                  </TooltipContent>
                                </Tooltip>
                              );
                            })()}
                        </TableCell>
                        <TableCell className="text-muted-foreground max-w-[180px]">
                          <TruncatedName name={pos.paperName} />
                        </TableCell>
                        <TableCell className="text-right">{formatQuantity(pos.shares)}</TableCell>
                        {colVis.avgPrice && (
                          <TableCell className="text-right">
                            {formatNumber(pos.avgBuyPrice)}
                          </TableCell>
                        )}
                        <TableCell className="text-right">
                          <span className="tabular-nums">
                            {pos.currentPrice ? formatNumber(pos.currentPrice) : '—'}
                          </span>
                          <CcyChip ccy={pos.currency} className="ml-1.5" />
                          {pos.priceManual && (
                            <span
                              className="ml-1 text-[10px] text-muted-foreground/60"
                              title="Cena z ostatniej transakcji — instrument bez aktualnych notowań"
                            >
                              ⚠
                            </span>
                          )}
                        </TableCell>
                        {colVis.dailyChange && (
                          <TableCell className="text-right">
                            {pos.dailyChangePct != null ? (
                              <PLBadge value={pos.dailyChangePct} />
                            ) : (
                              '—'
                            )}
                          </TableCell>
                        )}
                        <TableCell className="text-right font-medium">
                          {useNativeCcy
                            ? formatCurrency(pos.currentValue ?? 0, baseCurrency)
                            : formatPLN(pos.currentValuePln)}
                        </TableCell>
                        {colVis.pl && (
                          <TableCell
                            className={`text-right font-medium ${plColor(pos.profitLossPct)}`}
                          >
                            {formatCurrency(pos.profitLoss, pos.currency)}
                          </TableCell>
                        )}
                        {colVis.plPct && (
                          <TableCell className="text-right">
                            <PLBadge value={pos.profitLossPct} />
                          </TableCell>
                        )}
                        <TableCell className="text-right text-muted-foreground">
                          {formatPercent(pos.weight).replace('+', '')}
                        </TableCell>
                      </TableRow>
                    ))}
                    {totals && (
                      <TableRow className="border-t-2 font-semibold">
                        <TableCell colSpan={colsBeforeValue} className="text-right">
                          Razem
                        </TableCell>
                        <TableCell className="text-right">
                          {useNativeCcy
                            ? formatCurrency(totals.totalValue, baseCurrency)
                            : formatPLN(totals.totalValuePln)}
                        </TableCell>
                        {colVis.pl && (
                          <TableCell className={`text-right ${plColor(totals.totalProfitLoss)}`}>
                            {useNativeCcy
                              ? formatCurrency(totals.totalProfitLoss, baseCurrency)
                              : formatPLN(totals.totalProfitLoss)}
                          </TableCell>
                        )}
                        {colVis.plPct && (
                          <TableCell className="text-right">
                            <PLBadge value={totals.totalProfitLossPct} />
                          </TableCell>
                        )}
                        <TableCell />
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : (
            <EmptyState message="Brak otwartych pozycji. Zaimportuj historię transakcji lub dodaj ręcznie transakcje." />
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
                {cashPositions.map((cp) => (
                  <TableRow key={cp.currency}>
                    <TableCell>
                      <CcyChip ccy={cp.currency} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(cp.balance, cp.currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatPLN(cp.valuePln)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {formatPercent(cp.weight).replace('+', '')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {data && data.positions.length > 0 && (
        <PortfolioDiversification positions={data.positions} totalValuePln={data.totalValuePln} />
      )}
    </div>
  );
}

/**
 * Jednoliniowy label z nazwą spółki. Jeśli tekst mieści się w szerokości komórki
 * — render bez tooltipa ani cursor-help. Jeśli jest obcięty (scrollWidth > clientWidth)
 * — dodaje ellipsis, cursor-help i Tooltip pokazujący pełną nazwę po hoverze.
 * Przelicza się po każdym zmianie `name` lub rozmiaru okna.
 */
function TruncatedName({ name }: { name: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  // useLayoutEffect bez listy zależności: sprawdzenie po każdym renderze + on resize.
  // Guard przed pętlą: setState tylko gdy wynik się zmienia.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const should = el.scrollWidth > el.clientWidth;
      setIsTruncated((prev) => (prev === should ? prev : should));
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  });

  // Tooltip wrapper jest zawsze tym samym węzłem React-tree'a, żeby span nie był
  // remountowany przy zmianie `isTruncated` (co wcześniej gubiło ref i efekt).
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span ref={ref} className={`block truncate ${isTruncated ? 'cursor-help' : ''}`}>
          {name}
        </span>
      </TooltipTrigger>
      {isTruncated && (
        <TooltipContent side="top" className="max-w-[420px] text-xs">
          {name}
        </TooltipContent>
      )}
    </Tooltip>
  );
}
