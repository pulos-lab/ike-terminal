import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarClock, Coins, TrendingDown, TrendingUp } from 'lucide-react';
import type { PortfolioHistoryPoint } from 'shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { plColor } from '@/components/ui/pl-badge';
import { api } from '@/lib/api-client';
import { formatCurrency, formatPercent } from '@/lib/formatters';
import { describeDayChange, quoteFreshnessText } from '@/lib/day-change';
import {
  selectDayContributions,
  type ContributionMode,
  type DayContribution,
} from '@/lib/day-contributions';
import { describeBenchmarkDay, describeDayInHistory, localIsoDate } from '@/lib/day-fact';
import {
  buildPortfolioEvents,
  EVENTS_WINDOW_DAYS,
  formatEventWhen,
  type PortfolioEvent,
} from '@/lib/portfolio-events';
import { QUERY_KEYS } from '@/lib/query-keys';
import { useLocalStorage } from '@/lib/use-local-storage';
import { usePositionsQuery } from '@/lib/use-positions-query';
import { cn } from '@/lib/utils';

/** Ile wydarzeń mieści się w kolumnie obok pięciu wierszy wkładu. */
const MAX_EVENTS = 4;

const SECTION_LABEL =
  'mb-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground';

interface TodayPanelProps {
  /** Pełna historia portfela (nie przycięta do zakresu wykresu) — tło dla ciekawostki. */
  history?: PortfolioHistoryPoint[];
  /** Klucz benchmarku wybranego na wykresie; 'none' wyłącza porównanie. */
  benchmark: string;
  benchmarkLabel: string;
}

/**
 * „Dziś w portfelu" — skąd wziął się wynik dnia i co czeka posiadane spółki.
 *
 * Wynik dnia i wkład pozycji idą z tego samego zapytania pozycji co pasek metryk
 * i strona Portfel. Nie renderuje się, gdy żadna pozycja nie ma danych o zmianie
 * dziennej — pusta karta byłaby tylko szumem.
 */
export function TodayPanel({ history, benchmark, benchmarkLabel }: TodayPanelProps) {
  const { data } = usePositionsQuery();
  const [storedMode, setMode] = useLocalStorage<ContributionMode>('dashboard-movers-mode', 'value');
  const mode: ContributionMode = storedMode === 'pct' ? 'pct' : 'value';

  const { data: dividends } = useQuery({
    queryKey: QUERY_KEYS.upcomingDividends,
    queryFn: api.getUpcomingDividends,
    staleTime: 60 * 60 * 1000,
  });
  const { data: benchmarkDay } = useQuery({
    queryKey: QUERY_KEYS.benchmarkDay(benchmark),
    queryFn: () => api.getBenchmarkDay(benchmark),
    enabled: benchmark !== 'none',
    staleTime: 10 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  });

  const baseCurrency = data?.baseCurrency || 'PLN';
  const contributions = useMemo(
    () =>
      selectDayContributions(data?.positions ?? [], { mode, useNative: baseCurrency !== 'PLN' }),
    [data?.positions, mode, baseCurrency],
  );

  const now = new Date();
  const today = localIsoDate(now);
  const events = useMemo(
    () =>
      buildPortfolioEvents({
        earnings: data?.upcomingEarnings ?? [],
        dividends: dividends?.upcoming ?? [],
        today,
      }),
    [data?.upcomingEarnings, dividends?.upcoming, today],
  );

  const dayView = describeDayChange(data?.dayChange, data?.quotes, now);
  if (!data || !dayView || dayView.amount === null) return null;

  // Dzień, którego dotyczy wynik: data notowań, a bez znacznika czasu — dziś.
  const asOf = data.quotes?.asOf ? new Date(data.quotes.asOf) : null;
  const sessionDate = asOf && !Number.isNaN(asOf.getTime()) ? localIsoDate(asOf) : today;
  const fact = describeDayInHistory(history ?? [], dayView.pct, sessionDate, {
    provisional: Boolean(data.quotes?.marketOpen),
  });
  const benchmarkText =
    benchmark === 'none'
      ? null
      : describeBenchmarkDay(benchmarkDay, benchmarkLabel, dayView.pct, sessionDate);
  const notes = [dayView.coverageNote, dayView.fxNote].filter(Boolean).join(' · ');
  const FactIcon = fact?.direction === 'down' ? TrendingDown : TrendingUp;

  return (
    <Card className="gap-4">
      <CardHeader className="gap-0 pb-0">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <CardTitle className="text-sm font-semibold">
              {dayView.label === 'Dziś' ? 'Dziś w portfelu' : 'Ostatnia sesja w portfelu'}
            </CardTitle>
            {data.quotes && (
              <span className="text-[11px] text-muted-foreground">
                {quoteFreshnessText(data.quotes, now)}
              </span>
            )}
          </div>
          <div
            role="group"
            aria-label="Sposób rankingu"
            className="flex shrink-0 rounded-md border border-border p-0.5 text-xs"
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
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 tabular-nums">
            <span
              className={cn(
                'text-2xl font-bold leading-none tracking-tight',
                plColor(dayView.amount),
              )}
            >
              {signed(dayView.amount, dayView.currency)}
            </span>
            {dayView.pct !== null && (
              <span className={cn('text-lg font-semibold tracking-tight', plColor(dayView.pct))}>
                {formatPercent(dayView.pct)}
              </span>
            )}
            {benchmarkText && (
              <span className="basis-full text-xs text-muted-foreground md:ml-auto md:basis-auto">
                {benchmarkText}
              </span>
            )}
          </div>
          {notes && <p className="text-[11px] text-muted-foreground">{notes}</p>}
        </div>

        {fact && (
          <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm leading-snug">
            <FactIcon
              className={cn(
                'mt-0.5 h-4 w-4 shrink-0',
                fact.direction === 'down' ? 'text-loss' : 'text-gain',
              )}
              aria-hidden
            />
            <span>
              <span className="font-semibold">{fact.headline}</span>
              {fact.detail && <span className="text-muted-foreground"> · {fact.detail}</span>}
            </span>
          </p>
        )}

        {/* `grid-cols-1` jest konieczne: bez zdefiniowanej kolumny tor siatki rośnie do
            szerokości najdłuższej treści i rozpycha całą stronę w poziomie. */}
        <div className="grid grid-cols-1 gap-y-4 border-t border-border pt-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] md:gap-x-8">
          <div className="min-w-0">
            <p className={SECTION_LABEL}>
              {mode === 'value' ? 'Co złożyło się na wynik' : 'Największe ruchy cen'}
            </p>
            {contributions.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Żadna pozycja nie zmieniła ceny.</p>
            ) : (
              <ul className="space-y-2.5">
                {contributions.rows.map((row) => (
                  <ContributionRow key={row.isin} row={row} mode={mode} currency={baseCurrency} />
                ))}
                {contributions.rest && (
                  <li className={cn(ROW_GRID, 'text-muted-foreground')}>
                    <span className="truncate">Reszta</span>
                    <Bar share={contributions.rest.share} className="bg-muted-foreground/40" />
                    <span className={VALUE_CELL}>
                      <span className="font-medium md:text-right">
                        {signed(contributions.rest.amount, baseCurrency)}
                      </span>
                      <span className="text-xs md:text-right md:text-sm">
                        {contributions.rest.count} poz.
                      </span>
                    </span>
                  </li>
                )}
              </ul>
            )}
          </div>

          <div className="min-w-0 border-t border-border pt-4 md:border-l md:border-t-0 md:pl-8 md:pt-0">
            <p className={SECTION_LABEL}>Najbliższe wydarzenia</p>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Bez publikacji wyników i dywidend w najbliższych {EVENTS_WINDOW_DAYS} dniach.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {events.slice(0, MAX_EVENTS).map((event) => (
                  <EventRow key={event.key} event={event} />
                ))}
              </ul>
            )}
            {events.length > MAX_EVENTS && (
              <p className="mt-2.5 text-[11px] text-muted-foreground">
                i jeszcze {events.length - MAX_EVENTS} w ciągu {EVENTS_WINDOW_DAYS} dni
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Kwota ze znakiem; minus dostawia formatter, plus trzeba dopisać. */
function signed(amount: number, currency: string): string {
  return `${amount > 0 ? '+' : ''}${formatCurrency(amount, currency)}`;
}

/**
 * Stałe szerokości kolumn zamiast pary „kwota + procent" dosuniętej do prawej:
 * tylko tak kwoty stoją jedna pod drugą niezależnie od długości procentu.
 * Na telefonie kwota i procent są w jednej komórce, jedna pod drugą.
 */
const ROW_GRID =
  'grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-3 text-sm md:grid-cols-[5.5rem_minmax(0,1fr)_7rem_4rem]';
const VALUE_CELL = 'flex flex-col items-end leading-tight tabular-nums md:contents';
/** Procent, którego źródło nie podało („—”) — bez koloru kierunku. */
const MISSING = 'text-xs text-muted-foreground md:text-sm';

/** Kolor kierunku o stopień cichszy niż `plColor` — dla miary drugoplanowej. */
function softPlColor(value: number): string {
  return value >= 0 ? 'text-gain/80' : 'text-loss/80';
}

function Bar({ share, className }: { share: number; className: string }) {
  return (
    <span className="block" aria-hidden>
      <span
        className={cn('block h-2 min-w-1 rounded-full', className)}
        style={{ width: `${Math.round(share * 100)}%` }}
      />
    </span>
  );
}

function ContributionRow({
  row,
  mode,
  currency,
}: {
  row: DayContribution;
  mode: ContributionMode;
  currency: string;
}) {
  const direction = mode === 'value' ? row.amount : (row.pct ?? 0);
  // Obie miary tym samym krojem, rozmiarem i kolorem kierunku — różni je tylko
  // waga i nasycenie. Szary, mniejszy procent obok zielonej kwoty wyglądał jak
  // dopisek z innego zestawu liczb.
  const emphasis = cn('font-semibold', plColor(direction));
  const quiet = cn('text-xs font-medium md:text-sm', softPlColor(direction));
  return (
    <li className={ROW_GRID}>
      {row.linkable ? (
        <Link
          to={`/app/instrument/${encodeURIComponent(row.isin)}`}
          title={row.name}
          className="truncate font-semibold hover:underline"
        >
          {row.ticker}
        </Link>
      ) : (
        <span title={row.name} className="truncate font-semibold">
          {row.ticker}
        </span>
      )}
      <Bar share={row.share} className={direction >= 0 ? 'bg-gain' : 'bg-loss'} />
      {/* Kolejność kolumn jest stała (kwota, procent) — przełącznik zmienia ranking
          i to, która miara jest wyróżniona, a nie miejsce liczb na ekranie. */}
      <span className={VALUE_CELL}>
        <span className={cn('md:text-right', mode === 'value' ? emphasis : quiet)}>
          {signed(row.amount, currency)}
        </span>
        <span
          className={cn(
            'md:text-right',
            row.pct === null ? MISSING : mode === 'pct' ? emphasis : quiet,
          )}
        >
          {formatPercent(row.pct)}
        </span>
      </span>
    </li>
  );
}

function EventRow({ event }: { event: PortfolioEvent }) {
  const Icon = event.kind === 'earnings' ? CalendarClock : Coins;
  const when = formatEventWhen(event.date, event.daysUntil);
  return (
    <li className="flex items-start gap-2.5 text-sm">
      <Icon
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          // Dziś i jutro — jak ikona wyników w tabeli Portfela.
          event.daysUntil <= 1 ? 'text-warning' : 'text-muted-foreground',
        )}
        aria-hidden
      />
      <div className="min-w-0 leading-tight">
        {/* Bez przycinania: okres raportu („III kwartał 2026") nie mieścił się w wąskiej
            kolumnie i znikał za wielokropkiem. */}
        <p className="break-words">
          <span className="font-semibold">{event.ticker}</span> · {event.title}
        </p>
        <p className="text-xs text-muted-foreground">
          {when}
          {event.detail ? ` · ${event.detail}` : ''}
        </p>
      </div>
    </li>
  );
}
