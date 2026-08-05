import type { PortfolioPositionsResponse } from 'shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type Quotes = NonNullable<PortfolioPositionsResponse['quotes']>;

/**
 * Znacznik świeżości kursów w nagłówku Portfela.
 *
 * Bez niego dłuższe TTL po sesji wygląda jak zawieszona aplikacja („czemu ta
 * kwota się nie rusza?"). Z nim jest widoczną, zrozumiałą decyzją: po zamknięciu
 * rynku kurs nie ma się z czego zmieniać.
 */
export function QuoteFreshnessLabel({ quotes }: { quotes: Quotes }) {
  const asOf = quotes.asOf ? new Date(quotes.asOf) : null;
  const time = asOf
    ? asOf.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
    : null;
  // Kurs z innego dnia niż dziś (weekend, święto) — sama godzina wprowadzałaby
  // w błąd, więc dokładamy datę.
  const isToday = asOf ? asOf.toDateString() === new Date().toDateString() : false;
  const stamp = asOf
    ? isToday
      ? time
      : `${asOf.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })} ${time}`
    : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-2 text-xs font-normal text-muted-foreground cursor-help">
          {stamp ? `Kursy z ${stamp}` : 'Kursy z cache'}
          {' · '}
          {quotes.marketOpen ? 'sesja trwa' : 'rynek zamknięty'}
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
