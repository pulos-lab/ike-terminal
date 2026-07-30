import { CalendarClock } from 'lucide-react';
import type { UpcomingEarnings } from 'shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDate, daysUntilDate } from '@/lib/formatters';
import { cn } from '@/lib/utils';

/** Od ilu dni przed publikacją pokazujemy ikonę. */
export const EARNINGS_ALERT_DAYS = 7;

/** Od ilu dni ikona zmienia kolor na ostrzegawczy (dziś i jutro). */
const EARNINGS_IMMINENT_DAYS = 1;

/**
 * Czy pokazać sygnał. Dni liczymy PO STRONIE KLIENTA, mimo że serwer podaje
 * `daysUntil`: przy 15-minutowym staleTime karta otwarta przez noc pokazywałaby
 * „za 1 dzień" w dniu publikacji.
 */
export function shouldShowEarnings(earnings: UpcomingEarnings | undefined): boolean {
  if (!earnings) return false;
  const days = daysUntilDate(earnings.reportDate);
  return Number.isFinite(days) && days >= 0 && days <= EARNINGS_ALERT_DAYS;
}

/** Kolor ikony wg pilności i pewności terminu. */
export function earningsIconClass(daysUntil: number, confidence: string): string {
  if (daysUntil <= EARNINGS_IMMINENT_DAYS) return 'text-warning';
  if (confidence === 'estimated') return 'text-muted-foreground opacity-80';
  return 'text-info';
}

/** „dziś" / „jutro" / „za 5 dni" — z poprawną polską odmianą. */
export function formatDaysUntil(days: number): string {
  if (days <= 0) return 'dziś';
  if (days === 1) return 'jutro';
  return `za ${days} dni`;
}

function sessionText(session: UpcomingEarnings['session']): string {
  if (session === 'bmo') return ', przed otwarciem sesji';
  // Pora odnosi się do sesji RYNKU EMITENTA — tak samo jak `reportDate`, które
  // celowo nie jest przeliczane na polską strefę (patrz UpcomingEarnings).
  if (session === 'amc') return ', po zamknięciu sesji';
  return '';
}

function confidenceText(confidence: UpcomingEarnings['confidence']): string {
  switch (confidence) {
    case 'confirmed':
      return 'Termin ogłoszony przez spółkę.';
    case 'tentative':
      return 'Termin zapowiedziany, ale spółka nie potwierdziła pory publikacji — może się jeszcze przesunąć.';
    case 'estimated':
      return 'Data wyliczona z historycznego rytmu raportowania spółki — nie została przez nią potwierdzona i może się przesunąć o kilka dni.';
  }
}

export function EarningsTooltipBody({ earnings }: { earnings: UpcomingEarnings }) {
  const days = daysUntilDate(earnings.reportDate);
  const isEstimate = earnings.confidence === 'estimated';
  const period = earnings.fiscalLabel ? ` za ${earnings.fiscalLabel}` : '';
  const date = `${isEstimate ? 'ok. ' : ''}${formatDate(earnings.reportDate)}`;

  return (
    <div className="space-y-1">
      <div className="font-semibold">
        {earnings.viaUnderlying ? `Wyniki spółki bazowej ${earnings.ticker}` : 'Publikacja wyników'}
        {period}
      </div>
      <div>
        {date} — {formatDaysUntil(days)}
        {sessionText(earnings.session)}.
      </div>
      <div className="text-muted-foreground">{confidenceText(earnings.confidence)}</div>
    </div>
  );
}

interface EarningsBadgeProps {
  earnings: UpcomingEarnings | undefined;
  /** Karty mobilne używają mniejszej ikony niż tabela. */
  size?: 'sm' | 'md';
  /** Nagłówek karty mobilnej jest klikalnym togglem — ikona nie może go rozwijać. */
  stopPropagation?: boolean;
}

/**
 * Ikona sygnalizująca nadchodzącą publikację wyników. Renderuje się dopiero
 * w oknie 7 dni; poza nim zwraca null, więc można ją wstawiać bezwarunkowo.
 */
export function EarningsBadge({ earnings, size = 'md', stopPropagation }: EarningsBadgeProps) {
  if (!shouldShowEarnings(earnings) || !earnings) return null;
  const days = daysUntilDate(earnings.reportDate);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <CalendarClock
          className={cn(
            size === 'sm' ? 'h-3.5 w-3.5 shrink-0' : 'h-4 w-4 inline ml-1',
            'cursor-help',
            earningsIconClass(days, earnings.confidence),
          )}
          onClick={stopPropagation ? (e) => e.stopPropagation() : undefined}
          aria-label={`Publikacja wyników ${formatDaysUntil(days)}`}
        />
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[300px]">
        <EarningsTooltipBody earnings={earnings} />
      </TooltipContent>
    </Tooltip>
  );
}
