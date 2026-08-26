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
  /**
   * Górna granica daty transakcji (ISO YYYY-MM-DD, włącznie), do której alias
   * obowiązuje. Chroni przed kolizją w przyszłości, gdy zwolniony identyfikator
   * (np. ticker PDA po asymilacji) zostanie kiedyś przydzielony innej spółce —
   * bez granicy alias po cichu przepisywałby jej transakcje. Wiersz bez znanej
   * daty jest aliasowany (fail-open w stronę znanego przypadku).
   */
  appliesUntil?: string;
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
  // Rex Concepts: PDA (prawa do akcji) z IPO notowane na GPW jako REXA od 06.2026,
  // asymilacja PDA→akcje (REX) ~03.07.2026. XTB nie księguje żadnego wiersza konwersji
  // (operacja bezgotówkowa), więc zakupy PDA wisiały jako osobna, martwa wycenowo
  // pozycja REXA obok REX. Konwersja PDA→akcje jest zawsze 1:1, ciągłość kosztu
  // zachowana. Dwa wpisy, bo przestrzeń kluczy jest de facto zależna od parsera:
  // wbudowany parser XTB aplikuje alias PO normalizacji sufiksu (.PL→.WA), silnik
  // generic — na surowym symbolu z pliku. Formy Bossa/mBank (prawdziwe ISIN-y PDA)
  // dopisać, gdy pojawią się w realnym zgłoszeniu.
  {
    legacyIsin: 'REXA.WA',
    legacyTicker: 'REXA.WA',
    canonicalIsin: 'REX.WA',
    canonicalTicker: 'REX.WA',
    reason:
      'Konwersja PDA→akcje po IPO Rex Concepts S.A. (GPW); ticker PDA REXA wygasł wraz z asymilacją ~2026-07-03.',
    source: 'https://www.biznesradar.pl/notowania/REX',
    appliesUntil: '2026-12-31',
  },
  {
    legacyIsin: 'REXA.PL',
    legacyTicker: 'REXA.PL',
    canonicalIsin: 'REX.PL',
    canonicalTicker: 'REX.PL',
    reason:
      'Jak wyżej — forma surowego symbolu XTB (przed normalizacją .PL→.WA) dla plików idących przez silnik generic.',
    source: 'https://www.biznesradar.pl/notowania/REX',
    appliesUntil: '2026-12-31',
  },
  // Żabka Group: przydział z IPO (10.2024) ING księguje w historii transakcji pod
  // tickerem PDA ZKA1, a sprzedaż po debiucie już jako ZABKA — bez wiersza konwersji.
  // Asymilacja PDA→akcje zawsze 1:1, ciągłość kosztu zachowana. Forma pseudo-ISIN
  // (isin = ticker), bo parser ING transakcji nie zna prawdziwych ISIN-ów; przy imporcie
  // z plikiem historii finansowej join po numerze zlecenia i tak doszyje LU2910446546.
  {
    legacyIsin: 'ZKA1',
    legacyTicker: 'ZKA1',
    canonicalIsin: 'ZABKA',
    canonicalTicker: 'ZABKA',
    reason:
      'Przydział z IPO Żabka Group (10.2024) księgowany przez ING pod tickerem PDA ZKA1; asymilacja PDA→akcje ZABKA 1:1.',
    source: 'https://www.biznesradar.pl/notowania/ZABKA',
    appliesUntil: '2025-12-31',
  },
];

/**
 * Zastosuj alias jeśli ISIN jest w mapie. Zwraca nowe wartości (isin, ticker)
 * jeśli wpis znaleziono, inaczej zwraca oryginalne.
 *
 * `txDate` (opcjonalna, ISO — sam dzień lub pełny timestamp) jest porównywana
 * z `appliesUntil` wpisu: transakcja datowana PO granicy nie jest aliasowana.
 * Data w innym formacie lub brak daty → granica nie blokuje (fail-open).
 */
export function applyIsinAlias(
  isin: string,
  paperName: string,
  txDate?: string,
): { isin: string; paperName: string; aliasApplied: boolean } {
  const entry = ISIN_ALIASES_MAP.find((e) => e.legacyIsin === isin && e.legacyTicker === paperName);
  if (!entry) return { isin, paperName, aliasApplied: false };
  if (entry.appliesUntil && txDate && /^\d{4}-\d{2}-\d{2}/.test(txDate)) {
    if (txDate.slice(0, 10) > entry.appliesUntil) return { isin, paperName, aliasApplied: false };
  }
  return { isin: entry.canonicalIsin, paperName: entry.canonicalTicker, aliasApplied: true };
}
