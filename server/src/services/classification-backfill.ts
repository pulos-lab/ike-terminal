import type { TickerMapEntry } from 'shared';
import { updateTickerCountry, updateTickerSectors } from '../db/ticker-map-repo.js';
import type { ResolvedSector } from './sector-resolver.js';

/**
 * Wspólna reguła backfillu klasyfikacji (sektor + kraj) dla `lazyBackfillSectors`
 * i endpointu `POST /ticker-map/refresh-sectors`.
 *
 * Zasady:
 *  - sektory dopisujemy tylko, gdy brakowało — nie nadpisujemy ręcznie przypisanych;
 *  - kraj dopisujemy, gdy brakowało ALBO gdy jest ślad po prowizorycznym stubie
 *    (`hasStalePolishCountry`);
 *  - każdy zapis jest compare-and-set względem kopii wpisu, na której liczyliśmy
 *    (ticker + giełda + stara wartość). Backfill chodzi w tle i trwa (lookupy
 *    Yahoo), a w tym czasie samonaprawa resolvera potrafi przepisać wpis na inny
 *    papier — wtedy wynik policzony dla starej wersji jest nieaktualny i przepada.
 */

const POLISH_EXCHANGES = new Set(['GPW', 'NC', 'CATALYST']);

/**
 * Kraj „Poland" na wpisie, który NIE jest polskim papierem — ślad po stubie.
 *
 * GENEZA (audyt 2026-11-06, IKE użytkownika): TSM kupiony w Bossie w PLN był
 * najpierw nierozpoznany → `buildProvisionalStub` dał mu giełdę GPW (waluta
 * transakcji PLN), backfill przypisał krajowi statyczne „Poland", a po
 * rozpoznaniu (NYSE, USD) kraj został — wykres regionów liczył TSMC jako Polskę.
 *
 * Kryterium celowo wąskie: giełda spoza GPW/NC/Catalyst, waluta notowania inna
 * niż PLN i ticker bez sufiksu `.WA`/`.NC`. Ponowne pytanie Yahoo jest
 * nieszkodliwe — dla polskiej spółki notowanej za granicą odpowie znów „Poland"
 * i zapis się nie odbędzie (wartość bez zmian).
 */
export function hasStalePolishCountry(entry: TickerMapEntry): boolean {
  return (
    entry.country === 'Poland' &&
    !POLISH_EXCHANGES.has(entry.exchange) &&
    (entry.currency || '').toUpperCase() !== 'PLN' &&
    !/\.(WA|NC)$/i.test(entry.ticker)
  );
}

/** Czy wpis wymaga (ponownej) klasyfikacji. Opcje (`OPT:`) nie mają sektora. */
export function needsClassificationBackfill(entry: TickerMapEntry): boolean {
  if (entry.isin.startsWith('OPT:')) return false;
  return !entry.supersector || !entry.country || hasStalePolishCountry(entry);
}

/** Zapisuje wynik `resolveSector` zgodnie z regułami wyżej. Zwraca, czy coś zapisano. */
export function applyClassificationBackfill(
  entry: TickerMapEntry,
  resolved: ResolvedSector,
  portfolioId: string,
): boolean {
  const snapshot = { ticker: entry.ticker, exchange: entry.exchange };
  let touched = false;

  if (!entry.supersector && (resolved.supersector || resolved.subsector)) {
    touched =
      updateTickerSectors(entry.isin, resolved.supersector, resolved.subsector, portfolioId, {
        ...snapshot,
        supersector: entry.supersector ?? null,
      }) || touched;
  }

  const country = resolved.country;
  if (country && country !== entry.country && (!entry.country || hasStalePolishCountry(entry))) {
    touched =
      updateTickerCountry(entry.isin, country, portfolioId, {
        ...snapshot,
        country: entry.country ?? null,
      }) || touched;
  }

  return touched;
}
