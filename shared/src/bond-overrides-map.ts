import type { BondMapEntry } from './bond-map-data.js';

/**
 * Ręczne wpisy obligacji Catalyst, których scraper NIE złapie automatycznie.
 *
 * Wyszukiwarka obligacje.pl listuje tylko serie AKTUALNIE notowane, więc obligacja
 * wykupiona (zwłaszcza przedterminowo), która nigdy nie była notowana w oknie żadnego
 * przebiegu scrapera, nie trafia do wygenerowanego `bond-map-data.ts`. Import jej transakcji
 * (kupno, wykup, kupon, premia) rozjeżdża się wtedy: `isBondInstrument` → false, kupno wyceniane
 * jak akcja, wykup/kupon → nierozpoznane. Strona detalu (`obligacje.pl/pl/obligacja/<TICKER>`)
 * nadal istnieje i ma komplet danych — stąd wpisy uzupełniamy ręcznie stąd.
 *
 * Ta mapa jest NADRZĘDNA nad wygenerowanym `bond-map-data.ts` (merge w `bond-map.ts`,
 * overrides wygrywają) i NIE jest ruszana przez regenerację scraperem — wzorzec jak
 * `spin-offs-map.ts` / `tender-offers-map.ts`. Utrzymywana ręcznie.
 *
 * Docelowo (#167): tabela w `price_history.db` zasilana on-demand z detalu obligacji
 * + upsertem scrapera (wykupione zostają), z tą mapą jako seed/fallback.
 */
export const BOND_OVERRIDES: Record<string, BondMapEntry> = {
  // Best S.A. — wykup przedterminowy 2026-04-16; nigdy nienotowana w przebiegu scrapera.
  // Źródło: https://obligacje.pl/pl/obligacja/BST0728
  BST0728: {
    isin: 'PLBEST000390',
    ticker: 'BST0728',
    name: 'Best S.A.',
    nominal: 100,
    currency: 'PLN',
    maturityDate: '2026-04-16',
    segment: 'corporate',
    couponType: 'floating',
  },
};
