import { Sigma } from 'lucide-react';
import type { PortfolioHistoryPoint, PortfolioMetrics } from 'shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { COMBINED_SERIES_COLOR } from '@/lib/chart-palette';
import { formatCurrency, formatPercent } from '@/lib/formatters';
import { useTheme } from '@/lib/use-theme';
import { cn } from '@/lib/utils';
import { PerformanceStats } from './PerformanceStats';

/** Wiersz agregatów jednego portfela — dane z `metrics` odpowiedzi /history
 *  (już pobranej dla trybu porównania; sekcja nie robi żadnych requestów). */
export interface CombinedPortfolioSummary {
  portfolioId: string;
  name: string;
  color: string;
  baseCurrency: string;
  metrics: PortfolioMetrics;
}

interface Props {
  /** Aktywny portfel pierwszy — kolejność i kolory jak serie na wykresie. */
  summaries: CombinedPortfolioSummary[];
  /** Lista walut bazowych przy konflikcie (np. "PLN, USD") — wyłącza wiersz
   *  „Łącznie" i metryki połączonego portfela; null gdy waluty zgodne. */
  currencyConflict: string | null;
  /** Historia połączonego portfela po filtrze zakresu i rebase — wejście
   *  dla kafli metryk (PerformanceStats w trybie pojedynczym). */
  combinedPoints: PortfolioHistoryPoint[];
  benchmarkLabel: string;
  showBenchmark: boolean;
  riskFreeRatePct?: number;
}

function portfolioCountLabel(n: number): string {
  if (n === 1) return 'portfel';
  return n < 5 ? 'portfele' : 'portfeli';
}

const signColor = (v: number) => (v > 0 ? 'text-gain' : v < 0 ? 'text-loss' : '');

/**
 * Sekcja „Statystyki łączne" na dole dashboardu w trybie porównania:
 * agregaty per portfel + wiersz „Łącznie" (sumy) oraz metryki wydajności
 * portfeli policzonych jak JEDEN rachunek (seria z buildCombinedHistory).
 */
export function CombinedStatsSection({
  summaries,
  currencyConflict,
  combinedPoints,
  benchmarkLabel,
  showBenchmark,
  riskFreeRatePct,
}: Props) {
  const { isDark } = useTheme();
  const combinedColor = isDark ? COMBINED_SERIES_COLOR.dark : COMBINED_SERIES_COLOR.light;

  const totals = {
    currentValue: summaries.reduce((s, p) => s + p.metrics.currentValue, 0),
    totalInvested: summaries.reduce((s, p) => s + p.metrics.totalInvested, 0),
    totalReturn: summaries.reduce((s, p) => s + p.metrics.totalReturn, 0),
    totalDividends: summaries.reduce((s, p) => s + p.metrics.totalDividends, 0),
  };
  // MWR sum: łączny zysk do łącznych wpłat — spójne z totalReturnPct składników.
  const totalReturnPct =
    totals.totalInvested > 0 ? (totals.totalReturn / totals.totalInvested) * 100 : null;
  const currency = summaries[0]?.baseCurrency ?? 'PLN';

  return (
    <Card className="gap-3">
      <CardHeader className="pb-0">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Sigma className="h-4 w-4 text-muted-foreground" />
          Statystyki łączne — {summaries.length} {portfolioCountLabel(summaries.length)}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            Podsumowanie od początku historii (niezależne od zakresu wykresu)
          </h3>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Portfel</TableHead>
                  <TableHead className="text-right">Wartość</TableHead>
                  <TableHead className="text-right">Wpłacone</TableHead>
                  <TableHead className="text-right">Zysk</TableHead>
                  <TableHead className="text-right">Zwrot</TableHead>
                  <TableHead className="text-right">Dywidendy</TableHead>
                  <TableHead className="text-right">XIRR</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summaries.map((p) => (
                  <TableRow key={p.portfolioId}>
                    <TableCell className="max-w-[200px]">
                      <span className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: p.color }}
                        />
                        <span className="truncate font-medium">{p.name}</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(p.metrics.currentValue, p.baseCurrency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(p.metrics.totalInvested, p.baseCurrency)}
                    </TableCell>
                    <TableCell
                      className={cn('text-right tabular-nums', signColor(p.metrics.totalReturn))}
                    >
                      {formatCurrency(p.metrics.totalReturn, p.baseCurrency)}
                    </TableCell>
                    <TableCell
                      className={cn('text-right tabular-nums', signColor(p.metrics.totalReturnPct))}
                    >
                      {formatPercent(p.metrics.totalReturnPct)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(p.metrics.totalDividends, p.baseCurrency)}
                    </TableCell>
                    <TableCell className={cn('text-right tabular-nums', signColor(p.metrics.xirr))}>
                      {formatPercent(p.metrics.xirr)}
                    </TableCell>
                  </TableRow>
                ))}
                {!currencyConflict && (
                  <TableRow className="border-t-2 bg-accent/40 font-medium hover:bg-accent/40">
                    <TableCell className="max-w-[200px]">
                      <span className="flex items-center gap-2">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ background: combinedColor }}
                        />
                        <span className="truncate">Łącznie</span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(totals.currentValue, currency)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(totals.totalInvested, currency)}
                    </TableCell>
                    <TableCell
                      className={cn('text-right tabular-nums', signColor(totals.totalReturn))}
                    >
                      {formatCurrency(totals.totalReturn, currency)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right tabular-nums',
                        totalReturnPct !== null && signColor(totalReturnPct),
                      )}
                    >
                      {formatPercent(totalReturnPct)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(totals.totalDividends, currency)}
                    </TableCell>
                    {/* XIRR nie sumuje się bez dat wszystkich przepływów. */}
                    <TableCell className="text-right text-muted-foreground">—</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </section>

        {currencyConflict ? (
          <p className="text-xs text-muted-foreground">
            Portfele mają różne waluty bazowe ({currencyConflict}) — wiersz „Łącznie" i metryki
            połączonego portfela wymagają wspólnej waluty.
          </p>
        ) : (
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">
              Metryki połączonego portfela — wybrany okres wykresu, jak jeden rachunek
            </h3>
            {combinedPoints.length > 1 ? (
              <>
                <PerformanceStats
                  data={combinedPoints}
                  benchmarkLabel={benchmarkLabel}
                  showBenchmark={showBenchmark}
                  riskFreeRatePct={riskFreeRatePct}
                />
                <p className="text-[11px] text-muted-foreground">
                  Benchmark jak na wykresie dashboardu: serie benchmarku aktywnego portfela.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Za mało danych w wybranym zakresie.</p>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
