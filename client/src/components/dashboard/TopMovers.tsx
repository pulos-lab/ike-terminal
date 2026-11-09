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
        <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
          <MoversList
            title="Największe wzrosty"
            icon={<TrendingUp className="h-3.5 w-3.5 text-gain" aria-hidden />}
            movers={side.gainers}
            mode={mode}
            currency={baseCurrency}
            emptyText="Żadna pozycja nie zyskała"
          />
          <MoversList
            title="Największe spadki"
            icon={<TrendingDown className="h-3.5 w-3.5 text-loss" aria-hidden />}
            movers={side.losers}
            mode={mode}
            currency={baseCurrency}
            emptyText="Żadna pozycja nie straciła"
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

function MoversList({
  title,
  icon,
  movers,
  mode,
  currency,
  emptyText,
}: {
  title: string;
  icon: React.ReactNode;
  movers: Mover[];
  mode: MoversMode;
  currency: string;
  emptyText: string;
}) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </p>
      {movers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {movers.map((m) => {
            const primary = mode === 'value' ? m.amount : m.pct;
            return (
              <li key={m.isin} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  <span className="font-semibold">{m.ticker}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{m.name}</span>
                </span>
                <span className="shrink-0 tabular-nums">
                  <span className={cn('font-semibold', plColor(primary ?? 0))}>
                    {mode === 'value'
                      ? `${(m.amount ?? 0) > 0 ? '+' : ''}${formatCurrency(m.amount ?? 0, currency)}`
                      : formatPercent(m.pct)}
                  </span>
                  {/* Druga miara drobnym drukiem — kwota bez procentu (i odwrotnie)
                      nie mówi, czy to duża pozycja, czy duży ruch. */}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {mode === 'value'
                      ? formatPercent(m.pct)
                      : `${(m.amount ?? 0) > 0 ? '+' : ''}${formatCurrency(m.amount ?? 0, currency)}`}
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
