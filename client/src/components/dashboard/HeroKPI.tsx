import { useMetricsQuery } from '@/lib/use-metrics-query';
import { formatCurrency, formatPercent, formatNumber } from '@/lib/formatters';
import { cn } from '@/lib/utils';
import { plColor } from '@/components/ui/pl-badge';
import { usePositionsQuery } from '@/lib/use-positions-query';
import { describeDayChange } from '@/lib/day-change';

interface HeroKPIProps {
  history?: Array<{ date: string; returnPct: number }>;
}

/**
 * Kafel główny dashboardu na telefonie (desktop ma pasek metryk).
 *
 * Trzy poziomy: wartość portfela → wynik dnia → zysk od początku. Zarys wykresu
 * siedzi w prawym górnym rogu, obok wartości — tam nie nachodzi na liczby
 * (w dolnym rogu kolidował z wynikiem). Świeżości kursów tu nie ma: jest
 * w nagłówku Portfela.
 */
export function HeroKPI({ history }: HeroKPIProps) {
  const { data, isError } = useMetricsQuery();
  const { data: positions } = usePositionsQuery();

  // Jak w MetricsBar: przy błędzie bez danych nie udajemy wiecznego ładowania.
  if (!data && isError) return null;

  if (!data) {
    return (
      <div className="relative overflow-hidden rounded-2xl bg-card border border-border p-5 animate-pulse">
        <div className="h-3 w-32 bg-muted rounded mb-3" />
        <div className="h-9 w-48 bg-muted rounded mb-2" />
        <div className="h-4 w-40 bg-muted rounded" />
      </div>
    );
  }

  const currency = data.baseCurrency || 'PLN';
  const sparkPath = buildSparkPath(history ?? []);
  const dayView = describeDayChange(positions?.dayChange, positions?.quotes, new Date());

  return (
    <div className="relative overflow-hidden rounded-2xl bg-card border border-border p-5">
      {/* Amber radial halo */}
      <div
        className="absolute -top-1/2 -right-[20%] w-[280px] h-[280px] pointer-events-none"
        style={{
          background: 'radial-gradient(circle, rgba(245,158,11,0.18) 0%, transparent 65%)',
        }}
      />

      <div className="relative">
        {/* Zarys jest elementem wiersza, nie nakładką: przy długiej wartości na wąskim
            ekranie zwęża się, zamiast nachodzić na liczbę. */}
        <div className="flex items-start justify-between gap-4">
          <div className="shrink-0">
            <p className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              Wartość portfela
            </p>
            <p className="text-[2rem] font-bold tracking-tight leading-none tabular-nums">
              {formatNumber(data.currentValue, 0)}
              <span className="ml-2 text-base font-medium text-muted-foreground">{currency}</span>
            </p>
          </div>
          {sparkPath && (
            <svg
              className="h-[42px] min-w-0 max-w-[110px] flex-1 pointer-events-none"
              viewBox="0 0 110 42"
              preserveAspectRatio="none"
              aria-hidden
            >
              <defs>
                <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <path d={`${sparkPath} L 110 42 L 0 42 Z`} fill="url(#sparkFill)" />
              <path
                d={sparkPath}
                fill="none"
                stroke="var(--primary)"
                strokeWidth={1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          )}
        </div>

        {/* Wynik dnia — druga liczba na karcie, po którą sięga się na telefonie. Przy
            niepełnym pokryciu dopisek jest obowiązkowy; przy zerowym „brak danych”. */}
        {dayView && (
          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-3">
              {dayView.amount !== null ? (
                <p
                  className={cn(
                    'min-w-0 text-lg font-semibold leading-tight tabular-nums',
                    plColor(dayView.amount),
                  )}
                >
                  {dayView.amount > 0 ? '+' : ''}
                  {formatCurrency(dayView.amount, dayView.currency)}
                  {dayView.pct !== null && (
                    <span className="ml-2 text-sm">{formatPercent(dayView.pct)}</span>
                  )}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">brak danych</p>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">
                {dayView.label.toLowerCase()}
              </span>
            </div>
            {dayView.coverageNote && dayView.amount !== null && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">{dayView.coverageNote}</p>
            )}
          </div>
        )}

        {/* Zysk liczony od pierwszej wpłaty — wyciszony i podpisany, żeby nie czytał
            się jak wynik dnia. Bez groszy: przy tej skali to szum. */}
        <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-3 text-sm">
          <span className="text-xs text-muted-foreground">od początku</span>
          <span className={cn('font-medium tabular-nums', plColor(data.totalReturn))}>
            {data.totalReturn > 0 ? '+' : ''}
            {formatNumber(data.totalReturn, 0)} {currencySuffix(currency)}
            <span className="ml-2">{formatPercent(data.totalReturnPct)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Sufiks waluty dla kwoty bez groszy — spójny z `formatCurrency` dla PLN. */
function currencySuffix(currency: string): string {
  return currency === 'PLN' ? 'zł' : currency;
}

function buildSparkPath(history: Array<{ date: string; returnPct: number }>): string | null {
  if (history.length < 2) return null;
  // Take last ~30 points for the sparkline
  const slice = history.slice(-30);
  const values = slice.map((d) => d.returnPct);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 110;
  const h = 42;
  const step = w / (slice.length - 1);
  return slice
    .map((d, i) => {
      const x = i * step;
      const y = h - ((d.returnPct - min) / range) * h;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}
