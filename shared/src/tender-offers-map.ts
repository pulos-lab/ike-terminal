/**
 * Mapa cen historycznych wezwań skupu akcji (tender offers) na GPW/NewConnect.
 *
 * Analogicznie do `nc-ticker-map.ts` i `cfd-ticker-map.ts` — statyczna wiedza o rynku
 * rozszerzana ręcznymi PR-ami gdy napotkane są nowe wezwania. Ceny pochodzą z komunikatów
 * ESPI spółek (link w polu `source`).
 *
 * Klucz dopasowania: `(ticker, date)` gdzie `date` = ISO `YYYY-MM-DD` — data rozliczenia
 * wezwania (nie data ogłoszenia), zgodna z `"Rozliczenie oferty TICKER"` w pliku operacji
 * Bossy.
 *
 * Gdy wezwanie jest w mapie, parser emituje `RedemptionMarker` z wypełnionym `tenderPrice`,
 * a reconciliation tworzy syntetyczną sprzedaż `qty = amount / tenderPrice`. Wiersz deposit
 * i jego siostrzana prowizja są pomijane (source-of-truth = sprzedaż).
 *
 * Gdy wezwanie NIE jest w mapie, parser zostawia wiersze jako `deposit` + `fee` i emituje
 * warning z prośbą o ręczne dodanie sprzedaży w panelu Transakcje (lub dopisanie wezwania tutaj).
 */

export interface TenderOfferEntry {
  ticker: string;
  /** ISO date of settlement (YYYY-MM-DD) — matches date on the "Rozliczenie oferty" row. */
  date: string;
  /** Cena per akcja zadeklarowana w wezwaniu (PLN). */
  pricePerShare: number;
  /** Link do komunikatu ESPI / artykułu dla weryfikacji. */
  source?: string;
  /** Opcjonalny opis (np. "buy-back #3"). */
  note?: string;
}

export const TENDER_OFFER_MAP: TenderOfferEntry[] = [
  // GAMIVO — trzy fale skupu akcji własnych
  {
    ticker: 'GAMIVO',
    date: '2024-06-14',
    pricePerShare: 100,
    source: 'https://www.stockwatch.pl/wiadomosci/gamivo-rozpoczelo-skup-akcji-wlasnych-po-100-zl-za-sztuke,akcje,307306',
    note: 'Skup akcji własnych — pierwsza fala po 100 zł',
  },
  {
    ticker: 'GAMIVO',
    date: '2025-04-11',
    pricePerShare: 35,
    source: 'https://biznes.pap.pl/wiadomosci/firmy/gamivo-zaprasza-do-skladania-ofert-sprzedazy-do-99142-akcji-w-cenie-35-zlszt',
    note: 'Skup akcji własnych po 35 zł',
  },
  {
    ticker: 'GAMIVO',
    date: '2025-06-26',
    pricePerShare: 35,
    source: 'https://biznes.pap.pl/wiadomosci/firmy/gamivo-sa-102025-zaproszenie-do-skladania-ofert-sprzedazy-akcji',
    note: 'Skup akcji własnych — kolejna fala po 35 zł',
  },

  // TSGAMES (Ten Square Games) — buy-back 2024
  {
    ticker: 'TSGAMES',
    date: '2024-02-27',
    pricePerShare: 120,
    source: 'https://www.bankier.pl/wiadomosc/TEN-SQUARE-GAMES-S-A-Zaproszenie-do-skladania-ofert-sprzedazy-akcji-8693049.html',
    note: 'Buy-back po 120 zł/szt',
  },

  // MOSTALZAB (Mostostal Zabrze) — buy-back 2026
  {
    ticker: 'MOSTALZAB',
    date: '2026-04-13',
    pricePerShare: 11.50,
    source: 'https://www.stockwatch.pl/wiadomosci/mostostal-zabrze-buy-back-skup-akcji-2026,akcje,368301',
    note: 'Buy-back 691k akcji po 11,50 zł',
  },
];

/**
 * Wyszukaj cenę wezwania dla pary (ticker, date).
 * Zwraca `null` jeśli wezwanie nie jest znane — wtedy caller powinien użyć fallback ścieżki
 * (zostawić wiersz jako deposit + warning).
 */
export function lookupTenderPrice(ticker: string, date: string): TenderOfferEntry | null {
  const isoDate = date.slice(0, 10); // tolerant na "YYYY-MM-DDTHH:MM:SS"
  return TENDER_OFFER_MAP.find(e => e.ticker === ticker && e.date === isoDate) ?? null;
}
