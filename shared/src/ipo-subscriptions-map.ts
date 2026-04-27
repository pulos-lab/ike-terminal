/**
 * Mapa historycznych subskrypcji IPO, dla których Bossa NIE zapisała K transakcji w hisPW,
 * tylko cashflow w pliku operacji (`Zapisy na akcje X` + `Zwrot nadpłaty X`).
 *
 * Wzorzec: użytkownik dokonuje subskrypcji na kwotę maksymalną, broker blokuje środki,
 * po alokacji zwraca nadpłatę proporcjonalnie do wielkości otrzymanej puli. Różnica =
 * faktyczny koszt nabycia. Akcje trafiają na rachunek ale nie pojawiają się w pliku
 * transakcji — znikają z cashflow po prostu (pozycja otwarta "znikąd").
 *
 * Analogicznie do `tender-offers-map.ts`: gdy emisja jest w mapie, parser tworzy marker,
 * a reconciliation generuje syntetyczną K transakcję z qty = netto / ipoPrice.
 *
 * Klucz dopasowania: `(ticker, subscriptionDate)` gdzie `subscriptionDate` to data wiersza
 * `Zapisy na akcje` (nie data alokacji).
 */

export interface IpoSubscriptionEntry {
  /** Ticker jak w kolumnie `papier` Bossy (bez suffixów typu _IPO gdy stripowane). */
  ticker: string;
  /** Seria akcji w ramach subskrypcji (opcjonalnie, dla spółek z wieloma seriami). */
  series?: string;
  /** Data wiersza `Zapisy na akcje` w OPS (ISO YYYY-MM-DD). */
  subscriptionDate: string;
  /** Cena emisyjna per akcja (PLN). */
  ipoPrice: number;
  /** ISIN papieru (żeby synthetic K miał poprawny ISIN dla resolvera cen). */
  isin: string;
  /** Link do komunikatu ESPI / prospektu. */
  source?: string;
  /** Opcjonalny opis (np. 'Debiut GPW 2021-03-26'). */
  note?: string;
}

export const IPO_SUBSCRIPTIONS_MAP: IpoSubscriptionEntry[] = [
  {
    ticker: 'BIOCELTIX',
    series: 'G',
    subscriptionDate: '2021-03-15',
    ipoPrice: 20.5,
    isin: 'PLBCLTX00019',
    source:
      'https://biocel.pl/wp-content/uploads/2021/03/Biuletyn-Oferty-Publicznej-BIOCELTIX-S.A..pdf',
    note: 'Subskrypcja Serii G, debiut NewConnect 2021-04-13',
  },
];

/**
 * Wyszukaj subskrypcję IPO po tickerze i dacie `Zapisy na akcje`.
 * Zwraca `null` jeśli brak wpisu — caller powinien zostawić obie operacje
 * (Zapisy + Zwrot nadpłaty) jako zwykły withdrawal/deposit + warning.
 */
export function lookupIpoSubscription(
  ticker: string,
  subscriptionDate: string,
): IpoSubscriptionEntry | null {
  const isoDate = subscriptionDate.slice(0, 10);
  return (
    IPO_SUBSCRIPTIONS_MAP.find((e) => e.ticker === ticker && e.subscriptionDate === isoDate) ?? null
  );
}
