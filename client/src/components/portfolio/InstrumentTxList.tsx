import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { formatDate, formatNumber, formatQuantity, formatCurrency } from '@/lib/formatters';
import { toQuotePrice } from './quote-price';

/**
 * Zwięzła lista transakcji jednego instrumentu (do panelu bocznego / strony
 * instrumentu). Dane z tego samego cache co panel Transakcje — zero dodatkowych
 * requestów.
 */
export function InstrumentTxList({ isin, className }: { isin: string; className?: string }) {
  const { data } = useQuery({
    queryKey: QUERY_KEYS.transactions,
    queryFn: api.getTransactions,
  });

  // Dzisiejsze kursy FX — do przeliczenia kwot PLN (Bossa/mBank zagranica)
  // na walutę notowania tickera; serwer ma je w cache po załadowaniu pozycji.
  const { data: livePrices } = useQuery({
    queryKey: QUERY_KEYS.livePrices,
    queryFn: api.getLivePrices,
    staleTime: 5 * 60 * 1000,
  });

  const txs = useMemo(
    () =>
      (data?.transactions ?? [])
        .filter((t) => t.isin === isin)
        .sort((a, b) => b.date.localeCompare(a.date)),
    [data?.transactions, isin],
  );

  if (!txs.length) {
    return <p className="text-sm text-muted-foreground">Brak transakcji dla tego instrumentu.</p>;
  }

  return (
    <div className={className}>
      {txs.map((tx) => {
        const isBuy = tx.side === 'K';
        // Kwoty w walucie notowania tickera (kupno w PLN z auto-przewalutowaniem
        // Bossa/mBank → przeliczenie; "~" = dzisiejszy kurs, nie z dnia transakcji)
        const qp = toQuotePrice(tx, livePrices?.fx);
        const approxMark = qp.approx ? '~' : '';
        return (
          <div
            key={tx.id ?? `${tx.date}-${tx.side}-${tx.quantity}`}
            className="flex items-center justify-between gap-3 py-1.5 border-b border-border/60 last:border-b-0 text-sm"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] font-semibold ${
                  isBuy ? 'bg-gain/15 text-gain' : 'bg-loss/15 text-loss'
                }`}
              >
                {tx.side}
              </span>
              <span className="text-muted-foreground tabular-nums">{formatDate(tx.date)}</span>
            </div>
            <div
              className="text-right tabular-nums"
              title={
                qp.approx
                  ? 'Kwoty przeliczone dzisiejszym kursem FX (transakcja rozliczona w PLN przez auto-przewalutowanie brokera)'
                  : undefined
              }
            >
              <span>
                {formatQuantity(tx.quantity)} szt. @ {approxMark}
                {formatNumber(qp.price)}
              </span>
              <span className="ml-2 text-muted-foreground">
                {approxMark}
                {formatCurrency(qp.total, qp.currency)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
