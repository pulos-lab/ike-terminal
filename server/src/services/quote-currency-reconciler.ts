import { getAllTransactions, updateTransaction } from '../db/transactions-repo.js';
import { getTickerMap } from '../db/ticker-map-repo.js';

/**
 * Uzgodnienie ETYKIETY waluty notowania transakcji z walutą z ticker_map (Yahoo).
 *
 * Parser XTB wykrywa przewalutowanie z kwot (|Amount| vs qty×cena) i nadaje
 * walutę notowania z suffixu symbolu — etykietę pierwszego rzutu, która bywa
 * błędna (ISAC.UK/EIMI.UK to klasy USD na LSE, suffix mapuje na GBP). Po
 * resolveUnknownIsins ticker_map ma walutę faktycznie zwróconą przez Yahoo —
 * ten krok poprawia samą etykietę `currency`. Cena, value/total i fxRate są
 * NIETKNIĘTE: implikowany kurs liczony jest z kwot i nie zależy od etykiety.
 *
 * Kandydaci: paymentCurrency ≠ currency (wiersz z wykrytym przewalutowaniem),
 * source xtb/generic. fxRate nie jest wymagany — sprzedaż bez sparowanego
 * P/L dostaje etykietę z pamięci symbolu (suffixową) i bez relabelu zostałaby
 * w innej walucie niż kupna tego samego ISIN-u (mieszane legi FIFO, księgowanie
 * po złym kursie dziennym — realny przypadek: sprzedaże CNDX.UK/VUAA.UK w
 * eksportach IKE_*). Guard source: transakcje ręczne/mBank/Bossa nie są
 * relabelowane (currency usera/reconcilera płatności jest wiążące).
 * GBP/GBp/GBX traktujemy jako jedną rodzinę (skala pensów to inny problem —
 * cen nie przeliczamy na podstawie samej etykiety). Idempotentne: drugi
 * przebieg nie znajduje rozjazdów; updateTransaction bumpuje dataVersion.
 */

/** Źródła, których etykieta waluty pochodzi z heurystyki parsera (suffix),
 *  a nie z pliku brokera czy decyzji użytkownika. */
const RELABEL_SOURCES = new Set(['xtb', 'generic']);

export interface QuoteReconcileResult {
  updatedCount: number;
  warnings: string[];
}

/** GBX/GBp → GBP; reszta uppercase. */
function normalizeQuoteCurrency(c: string): string {
  const u = c.toUpperCase().trim();
  return u === 'GBX' || u === 'GBP' ? 'GBP' : u;
}

export function reconcileQuoteCurrencies(portfolioId: string): QuoteReconcileResult {
  const transactions = getAllTransactions(portfolioId);
  const tickerMap = getTickerMap(portfolioId);
  const warnings: string[] = [];
  const conflicted = new Set<string>();
  let updatedCount = 0;

  for (const tx of transactions) {
    if (tx.id === undefined) continue;
    if (!RELABEL_SOURCES.has(tx.source)) continue;
    if (!tx.paymentCurrency || tx.paymentCurrency === tx.currency) continue;

    const entry = tickerMap.get(tx.isin);
    if (!entry?.currency) continue;

    const entryNorm = normalizeQuoteCurrency(entry.currency);
    const txNorm = normalizeQuoteCurrency(tx.currency);
    if (entryNorm === txNorm) continue;

    if (entryNorm === normalizeQuoteCurrency(tx.paymentCurrency)) {
      // Sprzeczność: parser wykrył przewalutowanie z kwot, a Yahoo twierdzi,
      // że instrument notowany jest w walucie rozliczenia. Nie nadpisujemy —
      // zostaje etykieta z suffixu + warning do ręcznej weryfikacji.
      conflicted.add(tx.paperName);
      continue;
    }

    // Etykieta z suffixu ≠ notowanie wg Yahoo → poprawiamy samą etykietę.
    // GBp zapisujemy w formie znormalizowanej (GBP) — ceny transakcji nie są
    // w pensach, a silnik porównuje waluty po tej samej normalizacji.
    if (updateTransaction(tx.id, { currency: entryNorm }, portfolioId)) {
      updatedCount++;
    }
  }

  if (conflicted.size > 0) {
    warnings.push(
      `Wykryto przewalutowanie w kwotach XTB, ale wg notowań instrument jest w walucie ` +
        `rozliczenia: ${[...conflicted].sort().join(', ')} — zweryfikuj te transakcje ręcznie.`,
    );
  }

  return { updatedCount, warnings };
}
