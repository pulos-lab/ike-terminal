import { useMemo } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { plColor } from '@/components/ui/pl-badge';
import { formatCurrency, formatPercent } from '@/lib/formatters';
import { describeDayChange } from '@/lib/day-change';
import { selectTopMovers, type Mover } from '@/lib/top-movers';
import { useLocalStorage } from '@/lib/use-local-storage';
import { usePositionsQuery } from '@/lib/use-positions-query';
import { cn } from '@/lib/utils';

type MoversMode = 'value' | 'pct';

/**
 * „Co dziś ruszyło portfelem” — po trzy największe wzrosty i spadki.
 *
 * Korzysta z tego samego zapytania pozycji co pasek metryk i strona Portfel
 * (bez nowego endpointu). Nie renderuje się, gdy żadna pozycja nie ma danych
 * o zmianie dziennej — pusta karta byłaby tylko szumem.
 */
export function TopMovers() {
  const { data } = usePositionsQuery();
  const [storedMode, setMode] = useLocalStorage<MoversMode>('dashboard-movers-mode', 'value');
  const mode: MoversMode = storedMode === 'pct' ? 'pct' : 'value';

  const baseCurrency = data?.baseCurrency || 'PLN';
  const movers = useMemo(
    () => selectTopMovers(data?.positions ?? [], { useNative: baseCurrency !== 'PLN' }),
    [data?.positions, baseCurrency],
  );

  if (!data || movers.coveredCount === 0) return null;

  const side = mode === 'value' ? movers.byValue : movers.byPct;
  const label = describeDayChange(data.dayChange, data.quotes, new Date())?.label ?? 'Dziś';
  const missing = movers.totalCount - movers.coveredCount;

  return (
    <Card className="gap-3">
      <CardHeader className="gap-0 pb-0">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-sm font-semibold">
            {label === 'Dziś' ? 'Dziś w portfelu' : 'Ostatnia sesja w portfelu'}
          </CardTitle>
          <div
            role="group"
            aria-label="Sposób rankingu"
            className="flex rounded-md border border-border p-0.5 text-xs"
          >
            {(
              [
                ['value', 'Kwota'],
                ['pct', '%'],
              ] as const
            ).map(([value, text]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={cn(
                  'rounded px-2 py-0.5 font-medium transition-colors',
                  mode === value
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {text}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* `grid-cols-1` jest konieczne: bez zdefiniowanej kolumny tor siatki rośnie do
            szerokości najdłuższej nazwy spółki (nowrap) i rozpycha całą stronę w poziomie. */}
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2 md:gap-y-4">
          <MoversList
            title="Największe wzrosty"
            icon={<TrendingUp className="h-3.5 w-3.5 text-gain" aria-hidden />}
            movers={side.gainers}
            mode={mode}
            emptyText="Żadna pozycja nie zyskała"
          />
          <MoversList
            title="Największe spadki"
            icon={<TrendingDown className="h-3.5 w-3.5 text-loss" aria-hidden />}
            movers={side.losers}
            mode={mode}
            emptyText="Żadna pozycja nie straciła"
            className="border-t border-border pt-3 md:border-t-0 md:pt-0"
          />
        </div>
        {missing > 0 && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Bez danych o zmianie dziennej: {missing} z {movers.totalCount} pozycji — nie biorą
            udziału w rankingu.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Kwota zmiany w walucie waloru; ranking i tak liczy się w walucie portfela. */
function formatMoverAmount(m: Mover): string {
  const amount = m.nativeAmount ?? 0;
  return `${amount > 0 ? '+' : ''}${formatCurrency(amount, m.currency)}`;
}

function MoversList({
  title,
  icon,
  movers,
  mode,
  emptyText,
  className,
}: {
  title: string;
  icon: React.ReactNode;
  movers: Mover[];
  mode: MoversMode;
  emptyText: string;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      {/* Na telefonie nagłówek sekcji jest zbędny — kierunek niosą kolor i ikona
          w wierszu; zostaje dla czytników ekranu i na szerokim ekranie. */}
      <p className="sr-only mb-1.5 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground md:not-sr-only md:flex">
        {icon}
        {title}
      </p>
      {movers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="space-y-2 md:space-y-1">
          {movers.map((m) => {
            const primary = mode === 'value' ? m.nativeAmount : m.pct;
            const amountText = formatMoverAmount(m);
            const pctText = formatPercent(m.pct);
            return (
              <li key={m.isin} className="flex items-center justify-between gap-3 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 md:hidden">{icon}</span>
                  <span className="min-w-0 truncate">
                    <span className="font-semibold">{m.ticker}</span>
                    {/* Pełna nazwa tylko od md — na telefonie ticker wystarcza, a nazwa
                        i tak kończyła się wielokropkiem. */}
                    <span className="ml-2 hidden text-xs text-muted-foreground md:inline">
                      {m.name}
                    </span>
                  </span>
                </span>
                {/* Główna miara + druga drobnym drukiem: kwota bez procentu (i odwrotnie)
                    nie mówi, czy to duża pozycja, czy duży ruch. Na telefonie jedna pod
                    drugą, żeby nie zabierały szerokości nazwie. */}
                <span className="flex shrink-0 flex-col items-end leading-tight tabular-nums md:flex-row md:items-baseline md:gap-2">
                  <span className={cn('font-semibold', plColor(primary ?? 0))}>
                    {mode === 'value' ? amountText : pctText}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {mode === 'value' ? pctText : amountText}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
