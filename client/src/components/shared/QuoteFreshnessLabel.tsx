import type { PortfolioPositionsResponse } from 'shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { quoteFreshnessText } from '@/lib/day-change';
import { cn } from '@/lib/utils';

type Quotes = NonNullable<PortfolioPositionsResponse['quotes']>;

/**
 * Znacznik świeżości kursów — nagłówek Portfela i dzienna zmiana na dashboardzie.
 *
 * Bez niego dłuższe TTL po sesji wygląda jak zawieszona aplikacja („czemu ta
 * kwota się nie rusza?"). Z nim jest widoczną, zrozumiałą decyzją: po zamknięciu
 * rynku kurs nie ma się z czego zmieniać.
 *
 * Wymaga `TooltipProvider` wyżej w drzewie.
 */
export function QuoteFreshnessLabel({
  quotes,
  className,
  now,
}: {
  quotes: Quotes;
  className?: string;
  /** Wstrzykiwany moment (testy); domyślnie bieżący czas. */
  now?: Date;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('text-xs font-normal text-muted-foreground cursor-help', className)}>
          {quoteFreshnessText(quotes, now ?? new Date())}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[300px]">
        {quotes.marketOpen
          ? 'Kursy odświeżają się co ~15 minut. Notowania z darmowego źródła są opóźnione o ok. 15 minut względem rynku.'
          : 'Rynek zamknięty — kurs nie zmieni się do otwarcia, więc dane odświeżają się rzadziej.'}
      </TooltipContent>
    </Tooltip>
  );
}
