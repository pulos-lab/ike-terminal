/**
 * Mapa aliasów ISIN — dla akcji, które zmieniły identyfikator ISIN w wyniku zdarzeń
 * korporacyjnych (redomiciliacja, reorganizacja, fuzja), a Bossa zapisała transakcje
 * przed i po zmianie pod różnymi ISIN-ami i paperName'ami.
 *
 * Klasyczny przypadek: HUUUGE Games S.A. (polska spółka, ISIN `PLHGE0000020`, ticker
 * `HUUUGE_IPO`) zreorganizowała się w HUUUGE Inc. (delaware, ISIN `US44853H1086`, ticker
 * `HUUUGE-C`). Akcjonariusze dostali akcje nowej entity 1:1. W hisPW user ma:
 *   K 7 szt HUUUGE_IPO (PLHGE0000020)  — subskrypcja oferty pierwotnej
 *   S 7 szt HUUUGE-C   (US44853H1086)  — sprzedaż po debiucie w nowym ISIN-ie
 * Bez aliasu FIFO widzi dwie osobne pozycje: 7 szt HUUUGE_IPO otwarte + 7 szt HUUUGE-C
 * jako orphan sell. Z aliasem wszystkie transakcje migrują na canonicalIsin/canonicalTicker
 * i pozycja się zamyka.
 *
 * Parser podmienia `(isin, paperName)` wiersza TRANSAKCJI gdy `legacyIsin` jest w mapie.
 * Zwykle obie strony transakcji K i S są już w nowym ISIN-ie, więc mapa dotyczy tylko
 * kilku starych wpisów (IPO, pre-listing). To NIE jest ticker renaming — `ticker` z
 * ticker_map (dla resolvera cen) i tak używa canonicalIsin.
 */

export interface IsinAliasEntry {
  /** Stary ISIN z pliku brokera (zwykle polski pseudo-ISIN pre-listing). */
  legacyIsin: string;
  /** Ticker jak w pliku Bossy pod legacyIsin (np. `HUUUGE_IPO`). */
  legacyTicker: string;
  /** Docelowy ISIN pod którym papier dalej jest notowany. */
  canonicalIsin: string;
  /** Ticker który ma być użyty dla wszystkich wierszy po podmienianiu (np. `HUUUGE-C`). */
  canonicalTicker: string;
  /** Powód mapowania (redomiciliacja, fuzja, itd.). */
  reason: string;
  /** Link do komunikatu korporacyjnego dla weryfikacji. */
  source?: string;
}

export const ISIN_ALIASES_MAP: IsinAliasEntry[] = [
  {
    legacyIsin: 'PLHGE0000020',
    legacyTicker: 'HUUUGE_IPO',
    canonicalIsin: 'US44853H1086',
    canonicalTicker: 'HUUUGE-C',
    reason:
      'Reorganizacja — Huuuge Games S.A. (PL) przeniosła domicile do Huuuge Inc. (USA); akcjonariusze otrzymali akcje nowej jednostki 1:1.',
    source: 'https://huuugegames.com/investors',
  },
];

/**
 * Zastosuj alias jeśli ISIN jest w mapie. Zwraca nowe wartości (isin, ticker)
 * jeśli wpis znaleziono, inaczej zwraca oryginalne.
 */
export function applyIsinAlias(
  isin: string,
  paperName: string,
): { isin: string; paperName: string; aliasApplied: boolean } {
  const entry = ISIN_ALIASES_MAP.find((e) => e.legacyIsin === isin && e.legacyTicker === paperName);
  if (!entry) return { isin, paperName, aliasApplied: false };
  return { isin: entry.canonicalIsin, paperName: entry.canonicalTicker, aliasApplied: true };
}
