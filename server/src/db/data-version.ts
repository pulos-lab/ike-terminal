/**
 * Licznik wersji danych per portfel (in-memory, per proces).
 *
 * Każdy zapis zmieniający dane wejściowe silnika historii (transactions,
 * cash_operations, ticker_map, splity) bumpuje wersję portfela. Memo w
 * services/history-memo.ts wlicza tę wersję do klucza cache — bump
 * automatycznie unieważnia zapamiętane wyniki computePortfolioHistory.
 *
 * Moduł celowo NIE importuje niczego (żadnych zależności na services/ ani
 * connection) — dzięki temu repa DB mogą go używać bez ryzyka cyklu importów
 * (history-memo importuje portfolio-engine, który importuje db/connection).
 *
 * Restart procesu zeruje liczniki — to OK, bo cache memo też jest in-memory
 * i znika razem z nimi.
 */

const versions = new Map<string, number>();

/** Aktualna wersja danych portfela (0 dla portfela bez żadnego zapisu w tym procesie). */
export function getPortfolioDataVersion(portfolioId: string): number {
  return versions.get(portfolioId) ?? 0;
}

/** Podbij wersję danych portfela — wołane przy każdym zapisie wpływającym na historię. */
export function bumpPortfolioDataVersion(portfolioId: string): void {
  versions.set(portfolioId, getPortfolioDataVersion(portfolioId) + 1);
}
