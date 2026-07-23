import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { formatDate, formatNumber, formatQuantity, formatCurrency } from '@/lib/formatters';

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
        // Bossa/mBank zagranica: endpoint nadpisuje `currency` walutą notowań,
        // ale kwoty wiersza (price/total) pozostają w PLN — etykietujemy
        // walutą rozliczenia, żeby nie pokazywać kwot PLN jako USD.
        const totalCcy =
          (tx.source === 'bossa' || tx.source === 'mbank') &&
          tx.paymentCurrency &&
          tx.paymentCurrency !== tx.currency
            ? tx.paymentCurrency
            : tx.currency;
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
            <div className="text-right tabular-nums">
              <span>
                {formatQuantity(tx.quantity)} szt. @ {formatNumber(tx.price)}
              </span>
              <span className="ml-2 text-muted-foreground">
                {formatCurrency(tx.total, totalCcy)}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
