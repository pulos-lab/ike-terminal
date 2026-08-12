import { useMemo, useState, useRef, useLayoutEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Position, UpcomingEarnings } from 'shared';
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
import { Eye, EyeOff, AlertTriangle, Info, ChevronUp, ChevronDown } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { QuoteFreshnessLabel } from './QuoteFreshnessLabel';
import { PortfolioDiversification } from './PortfolioDiversification';
import { RiskReturnScatter } from './RiskReturnScatter';
import { PortfolioOptionsCard } from './PortfolioOptionsCard';
import { PortfolioPositionCardMobile } from './PortfolioPositionCardMobile';
import { EarningsBadge } from './EarningsBadge';
import { InstrumentSheet } from './InstrumentSheet';
import { useToggleSet } from '@/hooks/useToggleSet';

interface ColumnVisibility {
  avgPrice: boolean;
  dailyChange: boolean;
  pl: boolean;
  plPct: boolean;
}

const STORAGE_KEY = 'portfolio-col-visibility';
const SORT_STORAGE_KEY = 'portfolio-sort';

export type SortKey =
  | 'ticker'
  | 'name'
  | 'shares'
  | 'avgPrice'
  | 'price'
  | 'dailyChange'
  | 'value'
  | 'pl'
  | 'plPct'
  | 'weight';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** Kolumny tekstowe zaczynają od A→Z, liczbowe od największych — tak, jak
 *  użytkownik zwykle chce przy pierwszym kliknięciu. */
const TEXT_KEYS: ReadonlySet<SortKey> = new Set<SortKey>(['ticker', 'name']);

/** Domyślnie to samo, co zwraca API (wartość malejąco) — bez zmiany zastanego
 *  widoku dla kogoś, kto nigdy nie kliknie w nagłówek. */
export const DEFAULT_SORT: SortState = { key: 'value', dir: 'desc' };

/** Wartość porównywalna dla danej kolumny. `null` = brak danych; takie pozycje
 *  lądują ZAWSZE na końcu, niezależnie od kierunku (papier bez notowań nie ma
 *  wskakiwać na górę tylko dlatego, że sortujemy rosnąco). */
function sortValue(p: Position, key: SortKey, useNativeCcy: boolean): number | string | null {
  switch (key) {
    case 'ticker':
      return p.ticker ?? '';
    case 'name':
      return p.paperName ?? '';
    case 'shares':
      return p.shares;
    case 'avgPrice':
      return p.avgBuyPrice;
    case 'price':
      return p.currentPrice;
    case 'dailyChange':
      return p.dailyChangePct;
    case 'value':
      return useNativeCcy ? p.currentValue : p.currentValuePln;
    case 'pl':
      return useNativeCcy ? p.profitLoss : p.profitLossPln;
    case 'plPct':
      return p.profitLossPct;
    case 'weight':
      return p.weight;
  }
}

/** Czysta funkcja — cała logika sortowania, testowana bez renderowania. */
export function sortPositions(
  positions: Position[],
  sort: SortState,
  useNativeCcy: boolean,
): Position[] {
  const factor = sort.dir === 'asc' ? 1 : -1;
  return [...positions].sort((a, b) => {
    const av = sortValue(a, sort.key, useNativeCcy);
    const bv = sortValue(b, sort.key, useNativeCcy);
    // Brak danych na koniec listy w obu kierunkach.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv), 'pl') * factor;
    }
    if (av === bv) return 0;
    return (av < bv ? -1 : 1) * factor;
  });
}

/** Kliknięcie w tę samą kolumnę odwraca kierunek; w nową — ustawia domyślny. */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: TEXT_KEYS.has(key) ? 'asc' : 'desc' };
}

function loadSort(): SortState {
  try {
    const stored = localStorage.getItem(SORT_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as SortState;
      if (parsed?.key && (parsed.dir === 'asc' || parsed.dir === 'desc')) return parsed;
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SORT };
}

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
  const [sort, setSort] = useState<SortState>(loadSort);
  const [expandedPositions, togglePosition] = useToggleSet<string>();
  // Klik w wiersz pozycji → panel boczny z wykresem instrumentu (markery K/S);
  // pełna strona /app/instrument/:isin dostępna linkiem z panelu.
  const [sheetPos, setSheetPos] = useState<Position | null>(null);

  const toggleCol = (key: keyof ColumnVisibility) => {
    setColVis((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      saveVisibility(next);
      return next;
    });
  };

  const allVisible = colVis.avgPrice && colVis.dailyChange && colVis.pl && colVis.plPct;

  // Tempo odświeżania dyktuje serwer przez `quotes.nextRefreshAt` (TTL wg stanu
  // rynku): co ~15 min w trakcie sesji, co kilka godzin po zamknięciu, praktycznie
  // zero pollingu w weekend. Sztywne 15 min nie miało związku z tym, kiedy dane
  // faktycznie się zmieniają.
  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.positions,
    queryFn: api.getPositions,
    refetchInterval: (query) => {
      const next = query.state.data?.quotes?.nextRefreshAt;
      const ms = next ? Date.parse(next) - Date.now() : NaN;
      return Number.isFinite(ms) ? Math.max(ms, 60_000) : 15 * 60 * 1000;
    },
  });

  // Waluta bazowa portfela — PLN dla polskich/mixed, USD/EUR dla single-currency
  // (np. XTB USD sub-konto). Gdy != PLN, wyświetlamy natywne wartości pozycji
  // (currentValue, profitLoss) zamiast PLN-konwersji.
  const baseCurrency: string = data?.baseCurrency || 'PLN';
  const useNativeCcy = baseCurrency !== 'PLN';

  // Opcje mają własną kartę (inne kolumny: strike/expiry/DTE, możliwe ujemne
  // ilości i wartości dla pozycji krótkich) — główna tabela pokazuje resztę.
  const regularPositions = useMemo(
    () => (data?.positions ?? []).filter((p) => p.category !== 'option'),
    [data?.positions],
  );
  const optionPositions = useMemo(
    () => (data?.positions ?? []).filter((p) => p.category === 'option'),
    [data?.positions],
  );

  // Jedna posortowana lista dla tabeli i dla kart mobilnych — inaczej ten sam
  // portfel miałby dwie różne kolejności zależnie od szerokości ekranu.
  const sortedPositions = useMemo(
    () => sortPositions(regularPositions, sort, useNativeCcy),
    [regularPositions, sort, useNativeCcy],
  );

  const applySort = (key: SortKey) => {
    const next = nextSort(sort, key);
    setSort(next);
    try {
      localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* prywatny tryb przeglądarki — sortowanie zadziała, tylko się nie zapamięta */
    }
  };

  /** Nagłówek klikalny: strzałka pokazuje kierunek, aria-sort informuje czytniki. */
  const SortableHead = ({
    sortKey,
    children,
    className,
  }: {
    sortKey: SortKey;
    children: React.ReactNode;
    className?: string;
  }) => {
    const active = sort.key === sortKey;
    return (
      <TableHead
        className={className}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button
          type="button"
          onClick={() => applySort(sortKey)}
          className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
          title={`Sortuj wg: ${typeof children === 'string' ? children : sortKey}`}
        >
          {children}
          {active &&
            (sort.dir === 'asc' ? (
              <ChevronUp className="h-3 w-3" aria-hidden />
            ) : (
              <ChevronDown className="h-3 w-3" aria-hidden />
            ))}
        </button>
      </TableHead>
    );
  };

  const totals = useMemo(() => {
    if (!regularPositions.length) return null;
    if (useNativeCcy) {
      // Sumy w walucie portfela — raw sum z pos.currentValue/profitLoss (native)
      const totalValue = regularPositions.reduce((s, p) => s + p.currentValue, 0);
      const totalProfitLoss = regularPositions.reduce((s, p) => s + p.profitLoss, 0);
      const totalCostBasis = totalValue - totalProfitLoss;
      const totalProfitLossPct = totalCostBasis > 0 ? (totalProfitLoss / totalCostBasis) * 100 : 0;
      return {
        totalValue,
        totalProfitLoss,
        totalProfitLossPct,
        totalValuePln: data!.totalValuePln,
        cashValuePln: data!.cashValuePln,
      };
    }
    // Wiersz „Razem" musi być sumą kolumny „Wartość" nad nim, czyli samych pozycji
    // z TEJ tabeli (bez opcji — mają własną kartę — i bez gotówki).
    const totalValue = regularPositions.reduce((s, p) => s + p.currentValuePln, 0);
    const totalProfitLoss = regularPositions.reduce((s, p) => s + p.profitLossPln, 0);
    const totalCostBasis = totalValue - totalProfitLoss;
    const totalProfitLossPct = totalCostBasis > 0 ? (totalProfitLoss / totalCostBasis) * 100 : 0;
    return {
      totalValue,
      totalProfitLoss,
      totalProfitLossPct,
      totalValuePln: totalValue,
      cashValuePln: data!.cashValuePln,
    };
  }, [data, regularPositions, useNativeCcy]);

  const recentSplitMap = useMemo(() => {
    const map = new Map<string, { ratio: number; date: string }>();
    for (const s of data?.recentSplits ?? []) {
      map.set(s.isin, { ratio: s.ratio, date: s.date });
    }
    return map;
  }, [data?.recentSplits]);

  // Spin-offy: badge przy pozycji DZIECKA (skąd wzięły się akcje) + subtelny
  // marker przy RODZICU (koszt nabycia proporcjonalnie obniżony).
  const recentSpinOffChildMap = useMemo(() => {
    const map = new Map<
      string,
      { parentTicker: string; exDate: string; ratio: number; allocationPct: number }
    >();
    for (const s of data?.recentSpinOffs ?? []) {
      map.set(s.childIsin, {
        parentTicker: s.parentTicker,
        exDate: s.exDate,
        ratio: s.ratio,
        allocationPct: s.allocationPct,
      });
    }
    return map;
  }, [data?.recentSpinOffs]);

  const recentSpinOffParentMap = useMemo(() => {
    const map = new Map<string, { childTicker: string; exDate: string }>();
    for (const s of data?.recentSpinOffs ?? []) {
      map.set(s.parentIsin, { childTicker: s.childTicker, exDate: s.exDate });
    }
    return map;
  }, [data?.recentSpinOffs]);

  // Spin-offy wykryte przez scraper, ale czekające na ratio z SEC (klucz: ticker
  // rodzica — zdarzenia z tabeli globalnej nie znają ISIN-ów portfela)
  const pendingRatioMap = useMemo(() => {
    const map = new Map<string, { childTicker: string; exDate: string }>();
    for (const s of data?.pendingRatioSpinOffs ?? []) {
      map.set(s.parentTicker.toUpperCase(), { childTicker: s.childTicker, exDate: s.exDate });
    }
    return map;
  }, [data?.pendingRatioSpinOffs]);

  // Nadchodzące publikacje wyników (okno D+45 z serwera; ikona zapala się od D−7).
  const earningsMap = useMemo(() => {
    const map = new Map<string, UpcomingEarnings>();
    for (const e of data?.upcomingEarnings ?? []) map.set(e.isin, e);
    return map;
  }, [data?.upcomingEarnings]);

  const cashPositions = data?.cashPositions ?? [];

  // Kolumny przed „Wartość": Ticker, Nazwa, Ilość, [Śr. cena], Kurs, [Zmiana].
  // Liczba MUSI zgadzać się z nagłówkiem — inaczej cały wiersz „Razem" jedzie
  // o kolumnę w prawo i kwoty przestają stać pod swoimi nagłówkami.
  const colsBeforeValue = 4 + (colVis.avgPrice ? 1 : 0) + (colVis.dailyChange ? 1 : 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              Otwarte pozycje
              {data && (
                <span className="ml-2 text-muted-foreground font-normal">
                  ({regularPositions.length} pozycji |{' '}
                  {useNativeCcy
                    ? formatCurrency(totals?.totalValue ?? 0, baseCurrency)
                    : formatPLN(totals?.totalValuePln ?? 0)}
                  )
                </span>
              )}
              {data?.quotes && <QuoteFreshnessLabel quotes={data.quotes} />}
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
          ) : regularPositions.length ? (
            <>
              <div className="md:hidden flex flex-col gap-2">
                {sortedPositions.map((pos) => (
                  <PortfolioPositionCardMobile
                    key={pos.isin}
                    position={pos}
                    baseCurrency={baseCurrency}
                    useNativeCcy={useNativeCcy}
                    splitInfo={recentSplitMap.get(pos.isin)}
                    spinOffInfo={recentSpinOffChildMap.get(pos.isin)}
                    earningsInfo={earningsMap.get(pos.isin)}
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
                      <SortableHead sortKey="ticker">Ticker</SortableHead>
                      <SortableHead sortKey="name">Nazwa</SortableHead>
                      <SortableHead sortKey="shares" className="text-right">
                        Ilość
                      </SortableHead>
                      {colVis.avgPrice && (
                        <SortableHead sortKey="avgPrice" className="text-right">
                          Śr. cena
                        </SortableHead>
                      )}
                      <SortableHead sortKey="price" className="text-right">
                        Kurs
                      </SortableHead>
                      {colVis.dailyChange && (
                        <SortableHead sortKey="dailyChange" className="text-right">
                          Zmiana
                        </SortableHead>
                      )}
                      <SortableHead sortKey="value" className="text-right">
                        Wartość ({baseCurrency})
                      </SortableHead>
                      {colVis.pl && (
                        <SortableHead sortKey="pl" className="text-right">
                          P/L
                        </SortableHead>
                      )}
                      {colVis.plPct && (
                        <SortableHead sortKey="plPct" className="text-right">
                          P/L %
                        </SortableHead>
                      )}
                      <SortableHead sortKey="weight" className="text-right">
                        Udział
                      </SortableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedPositions.map((pos) => (
                      <TableRow
                        key={pos.isin}
                        className="cursor-pointer"
                        title={`Pokaż wykres ${pos.ticker} z transakcjami`}
                        onClick={() => setSheetPos(pos)}
                      >
                        <TableCell className="font-mono font-medium">
                          {pos.ticker}
                          <CategoryBadge category={pos.category} />
                          <EarningsBadge earnings={earningsMap.get(pos.isin)} />
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
                          {recentSpinOffChildMap.has(pos.isin) &&
                            (() => {
                              const so = recentSpinOffChildMap.get(pos.isin)!;
                              return (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <AlertTriangle className="h-4 w-4 text-amber-500 inline ml-1 cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="right" className="max-w-[300px]">
                                    Ta pozycja powstała z wydzielenia ze spółki {so.parentTicker}{' '}
                                    (spin-off {so.ratio}:1, ex {so.exDate}). Koszt nabycia (
                                    {(so.allocationPct * 100).toFixed(1)}% kosztu spółki
                                    macierzystej) został przeniesiony automatycznie.
                                  </TooltipContent>
                                </Tooltip>
                              );
                            })()}
                          {recentSpinOffParentMap.has(pos.isin) &&
                            (() => {
                              const so = recentSpinOffParentMap.get(pos.isin)!;
                              return (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info className="h-4 w-4 text-muted-foreground inline ml-1 cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="right" className="max-w-[300px]">
                                    Ze spółki wydzielono {so.childTicker} (spin-off, ex {so.exDate})
                                    — koszt nabycia został proporcjonalnie obniżony o część
                                    przeniesioną na nową pozycję.
                                  </TooltipContent>
                                </Tooltip>
                              );
                            })()}
                          {!recentSpinOffParentMap.has(pos.isin) &&
                            pendingRatioMap.has(pos.ticker.toUpperCase()) &&
                            (() => {
                              const so = pendingRatioMap.get(pos.ticker.toUpperCase())!;
                              return (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Info className="h-4 w-4 text-muted-foreground inline ml-1 cursor-help" />
                                  </TooltipTrigger>
                                  <TooltipContent side="right" className="max-w-[300px]">
                                    Wykryto spin-off {so.childTicker} (ex {so.exDate}) — czekam na
                                    potwierdzenie ratio dystrybucji z oficjalnych filingów SEC.
                                    Pozycja spółki wydzielonej pojawi się automatycznie.
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

      <PortfolioOptionsCard
        positions={optionPositions}
        totalValuePln={data?.totalValuePln ?? 0}
        earningsByIsin={earningsMap}
      />

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
                    <TableCell
                      className={`text-right tabular-nums ${cp.balance < 0 ? 'text-loss font-medium' : ''}`}
                    >
                      {cp.balance < 0 ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-help">
                              {formatCurrency(cp.balance, cp.currency)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-[280px]">
                            Ujemne saldo — kredyt (margin) u brokera.
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        formatCurrency(cp.balance, cp.currency)
                      )}
                    </TableCell>
                    <TableCell
                      className={`text-right font-medium tabular-nums ${cp.valuePln < 0 ? 'text-loss' : ''}`}
                    >
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

      {regularPositions.length > 0 && (
        <PortfolioDiversification
          positions={regularPositions}
          totalValuePln={data?.totalValuePln ?? 0}
        />
      )}

      {regularPositions.length > 1 && <RiskReturnScatter positions={regularPositions} />}

      <InstrumentSheet
        position={sheetPos}
        open={sheetPos !== null}
        onOpenChange={(open) => {
          if (!open) setSheetPos(null);
        }}
      />
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
