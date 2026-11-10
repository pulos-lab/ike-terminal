import type { PortfolioDayChange, PortfolioPositionsResponse } from 'shared';

type Quotes = NonNullable<PortfolioPositionsResponse['quotes']>;

export interface DayChangeView {
  /** „Dziś” gdy kursy są z bieżącego dnia, inaczej „Ostatnia sesja”. */
  label: 'Dziś' | 'Ostatnia sesja';
  /** Kwota w walucie bazowej; null = żadna pozycja nie ma danych. */
  amount: number | null;
  pct: number | null;
  currency: string;
  /** „bez danych: 2 z 14” — tylko przy niepełnym pokryciu. */
  coverageNote: string | null;
  /** Tickery bez danych (lista bywa przycięta przez serwer). */
  missingTickers: string[];
  /** Dopisek o kursach walut — tylko gdy portfel ma pozycje w obcej walucie. */
  fxNote: string | null;
}

/**
 * Tłumaczy kontrakt serwera na to, co widać w pasku i w hero.
 *
 * Dwie rzeczy, których NIE wolno zgubić po drodze:
 *  - niepełne pokrycie jest zawsze nazwane (liczba z połowy pozycji bez
 *    dopisku wyglądałaby na pełną),
 *  - poza sesją liczba to ruch OSTATNIEJ sesji, nie „dziś” — w sobotę etykieta
 *    „Dziś” przy piątkowym wyniku byłaby po prostu nieprawdą.
 */
export function describeDayChange(
  dayChange: PortfolioDayChange | null | undefined,
  quotes: Quotes | undefined,
  now: Date,
): DayChangeView | null {
  if (!dayChange) return null;

  const asOf = quotes?.asOf ? new Date(quotes.asOf) : null;
  const quotesFromToday =
    asOf && !Number.isNaN(asOf.getTime()) ? asOf.toDateString() === now.toDateString() : false;
  // Brak znacznika czasu (źródła bez godziny notowania): w trakcie sesji to „dziś”.
  const label = quotes?.marketOpen || quotesFromToday || !quotes ? 'Dziś' : 'Ostatnia sesja';

  const missing = dayChange.totalCount - dayChange.coveredCount;
  return {
    label,
    amount: dayChange.change,
    pct: dayChange.changePct,
    currency: dayChange.currency,
    coverageNote: missing > 0 ? `bez danych: ${missing} z ${dayChange.totalCount}` : null,
    missingTickers: dayChange.missingTickers,
    fxNote:
      dayChange.hasForeignPositions && !dayChange.fxIncluded ? 'bez ruchu kursów walut' : null,
  };
}

/** „Kursy z 17:32 · rynek zamknięty” / z datą, gdy kurs jest z innego dnia. */
export function quoteFreshnessText(quotes: Quotes, now: Date): string {
  const asOf = quotes.asOf ? new Date(quotes.asOf) : null;
  const valid = asOf && !Number.isNaN(asOf.getTime()) ? asOf : null;
  const time = valid
    ? valid.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
    : null;
  // Kurs z innego dnia niż dziś (weekend, święto) — sama godzina wprowadzałaby
  // w błąd, więc dokładamy datę.
  const isToday = valid ? valid.toDateString() === now.toDateString() : false;
  const stamp = valid
    ? isToday
      ? time
      : `${valid.toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit' })} ${time}`
    : null;
  return `${stamp ? `Kursy z ${stamp}` : 'Kursy z cache'} · ${
    quotes.marketOpen ? 'sesja trwa' : 'rynek zamknięty'
  }`;
}
