import { AlertTriangle, Info, Layers } from 'lucide-react';
import type { PortfolioHistoryPoint } from 'shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { formatCurrency, formatPercent } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { PerformanceStats } from './PerformanceStats';

interface Props {
  /** Historia portfela łączonego — już przefiltrowana i zrebase'owana do zakresu,
   *  dokładnie tak jak seria rysowana na wykresie. */
  data: PortfolioHistoryPoint[];
  /** Nazwy portfeli, które weszły do sumy. */
  memberNames: string[];
  /** Portfele pominięte, bo ich historia się nie pobrała. */
  excludedNames: string[];
  /** Etykieta wybranego zakresu dat (1M / YTD / ALL / własny). */
  rangeLabel: string;
  benchmarkLabel: string;
  showBenchmark: boolean;
  riskFreeRatePct?: number;
  /** Kolor serii „Razem" — spina okno z linią na wykresie. */
  color: string;
  /** Prawda, gdy któryś składnik ma walutę bazową inną niż PLN (kwoty przewalutowane). */
  mixedCurrency: boolean;
}

/**
 * Okno ze statystykami PORTFELA ŁĄCZONEGO — wyłącznie sumy, bez kolumn per portfel
 * (te są w kaflach pod wykresem). Siatka metryk to ten sam `PerformanceStats` co w trybie
 * pojedynczego portfela: bez `compareSeries` komponent renderuje układ jednoportfelowy,
 * więc okno nie duplikuje ani jednego kafla.
 */
export function CombinedStatsDialog({
  data,
  memberNames,
  excludedNames,
  rangeLabel,
  benchmarkLabel,
  showBenchmark,
  riskFreeRatePct,
  color,
  mixedCurrency,
}: Props) {
  const last = data.length ? data[data.length - 1] : null;

  // Kwoty są narastające OD POCZĄTKU historii (filtr zakresu ich nie rebase'uje —
  // rebase dotyczy tylko procentów), więc pasek nagłówkowy opisuje stan „łącznie",
  // a kafle niżej — wybrany zakres. Etykiety mówią to wprost.
  const totalValue = last?.portfolioValue ?? 0;
  const deposits = last?.cumulativeDepositsPln ?? 0;
  const withdrawals = last?.cumulativeWithdrawalsPln ?? 0;
  const pnl = totalValue + withdrawals - deposits;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-6 gap-1.5 px-2 text-xs">
          <Layers className="h-3.5 w-3.5" style={{ color }} />
          Statystyki łączone
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4" style={{ color }} />
            Portfel łączony
          </DialogTitle>
          <DialogDescription>
            Wynik, jaki dałyby zaznaczone portfele traktowane jako jeden rachunek. Zakres:{' '}
            {rangeLabel}
            {showBenchmark && benchmarkLabel ? ` · benchmark: ${benchmarkLabel}` : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1.5">
          {memberNames.map((name) => (
            <span
              key={name}
              className="inline-flex max-w-[180px] items-center gap-1.5 rounded-full border bg-card px-2 py-0.5 text-xs"
            >
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
              <span className="truncate">{name}</span>
            </span>
          ))}
        </div>

        {excludedNames.length > 0 && (
          <p className="flex items-start gap-1.5 rounded-md border border-loss/40 bg-loss/5 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-loss" />
            <span>
              Poza sumą (nie udało się pobrać historii): {excludedNames.join(', ')}. Odśwież portfel
              z chipa nad wykresem, żeby wszedł do wyniku.
            </span>
          </p>
        )}

        {last ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SummaryTile label="Wartość dziś" value={formatCurrency(totalValue, 'PLN')} />
              <SummaryTile label="Wpłaty łącznie" value={formatCurrency(deposits, 'PLN')} />
              <SummaryTile
                label="Wynik łącznie"
                value={formatCurrency(pnl, 'PLN')}
                tone={pnl > 0 ? 'gain' : pnl < 0 ? 'loss' : undefined}
              />
              <SummaryTile
                label={`Stopa zwrotu · ${rangeLabel}`}
                value={formatPercent(last.returnPct)}
                tone={last.returnPct > 0 ? 'gain' : last.returnPct < 0 ? 'loss' : undefined}
              />
            </div>

            <PerformanceStats
              data={data}
              benchmarkLabel={benchmarkLabel}
              showBenchmark={showBenchmark}
              riskFreeRatePct={riskFreeRatePct}
            />

            <div className="space-y-1 text-[11px] text-muted-foreground">
              <p className="flex items-start gap-1.5">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                Kafle liczą się z wybranego zakresu; „Wartość dziś", „Wpłaty" i „Wynik łącznie" są
                narastające od początku historii. XIRR pomijamy świadomie — wymaga dat pojedynczych
                przepływów, których seria dzienna nie niesie; jego odpowiednikiem jest tu stopa
                zwrotu MWR.
              </p>
              {mixedCurrency && (
                <p className="flex items-start gap-1.5">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  Któryś ze składników prowadzony jest w innej walucie bazowej — kwoty przeliczono
                  na PLN kursem z danego dnia, więc jego zwrot zawiera wpływ kursu. Beta i alfa są w
                  tym układzie przybliżone.
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Brak danych w wybranym zakresie dat.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SummaryTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'gain' | 'loss';
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          'text-base font-bold tabular-nums tracking-tight',
          tone === 'gain' && 'text-gain',
          tone === 'loss' && 'text-loss',
        )}
      >
        {value}
      </p>
    </div>
  );
}
