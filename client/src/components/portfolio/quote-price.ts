import type { LiveFxRates, TransactionWithMeta } from 'shared';

export interface QuotePrice {
  price: number;
  total: number;
  currency: string;
  /** true = przeliczone DZISIEJSZYM kursem FX (brak kursu brokera z dnia
   *  transakcji) — kwota szacunkowa, UI sygnalizuje tyldą. */
  approx: boolean;
}

/**
 * Kwoty wiersza transakcji w walucie NOTOWANIA tickera.
 *
 * Bossa/mBank zagranica księgują cenę w PLN (auto-FX brokera), a endpoint
 * /portfolio/transactions nadpisuje `currency` walutą notowań z ticker_map —
 * surowe kwoty zostają w PLN. Przeliczamy: kursem brokera (fxRate, konwencja
 * payment-per-quote) gdy jest, inaczej dzisiejszym kursem z /prices/live —
 * ta sama konwencja co avgBuyPrice w silniku pozycji (fxRates dnia bieżącego).
 * Bez dostępnego kursu pokazujemy kwoty uczciwie w walucie rozliczenia.
 */
export function toQuotePrice(tx: TransactionWithMeta, fx?: LiveFxRates): QuotePrice {
  const plnBooked =
    (tx.source === 'bossa' || tx.source === 'mbank') &&
    !!tx.paymentCurrency &&
    tx.paymentCurrency !== tx.currency;
  if (!plnBooked) {
    return { price: tx.price, total: tx.total, currency: tx.currency, approx: false };
  }
  if (tx.fxRate && tx.fxRate > 0) {
    return {
      price: tx.price / tx.fxRate,
      total: tx.total / tx.fxRate,
      currency: tx.currency,
      approx: false,
    };
  }
  const rate =
    tx.paymentCurrency === 'PLN'
      ? (fx as Record<string, number> | undefined)?.[`${tx.currency}PLN`]
      : undefined;
  if (rate && rate > 0) {
    return { price: tx.price / rate, total: tx.total / rate, currency: tx.currency, approx: true };
  }
  return { price: tx.price, total: tx.total, currency: tx.paymentCurrency!, approx: false };
}
