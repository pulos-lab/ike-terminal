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
 * Kandydaci: fxRate > 0 i paymentCurrency ≠ currency (tylko wiersze z wykrytym
 * przewalutowaniem — samoograniczające, niezależne od source). GBP/GBp/GBX
 * traktujemy jako jedną rodzinę (skala pensów to inny problem — cen nie
 * przeliczamy na podstawie samej etykiety). Idempotentne: drugi przebieg nie
 * znajduje rozjazdów; updateTransaction bumpuje dataVersion.
 */

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
    if (!(tx.fxRate && tx.fxRate > 0)) continue;
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
