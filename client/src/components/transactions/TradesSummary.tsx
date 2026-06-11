import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { formatPLN, formatNumber } from '@/lib/formatters';
import { plColor } from '@/components/ui/pl-badge';
import { cn } from '@/lib/utils';
import type { Position } from 'shared';

interface Props {
  tab: 'all' | 'open' | 'closed';
  positions: Position[];
  /** Closed tab date filter (mirrored from ClosedTradesPage, lifted up in TradesPage) */
  closedDateRange?: string;
  closedCustomFrom?: string;
  closedCustomTo?: string;
}

export function TradesSummary({
  tab,
  positions,
  closedDateRange,
  closedCustomFrom,
  closedCustomTo,
}: Props) {
  if (tab === 'all') return <AllTilesView />;
  if (tab === 'closed')
    return (
      <ClosedTilesView
        dateRange={closedDateRange ?? 'ALL'}
        customFrom={closedCustomFrom ?? ''}
        customTo={closedCustomTo ?? ''}
      />
    );
  return <OpenTilesView positions={positions} />;
}

// ═══════════════════════ WSZYSTKIE ═══════════════════════

function AllTilesView() {
  const { data } = useQuery({
    queryKey: QUERY_KEYS.transactions,
    queryFn: () => api.getTransactions(),
  });

  const stats = useMemo(() => {
    const txs = data?.transactions || [];
    const buys = txs.filter((t) => t.side === 'K').length;
    const sells = txs.filter((t) => t.side === 'S').length;
    // Agregaty PLN tylko z transakcji przeliczalnych — wiersze w walucie obcej
    // bez kursu FX pomijamy zamiast sumować surowe kwoty jak złotówki.
    let turnover = 0;
    let commissionPln = 0;
    let unconvertible = 0;
    for (const t of txs) {
      const fx = fxFor(t);
      if (fx == null) {
        unconvertible += 1;
        continue;
      }
      turnover += (t.total ?? 0) * fx;
      commissionPln += (t.commission ?? 0) * fx;
    }
    const commissionPct = turnover > 0 ? (commissionPln / turnover) * 100 : 0;
    const tickers = new Set(txs.map((t) => t.ticker)).size;
    const currencies = new Set(txs.map((t) => t.currency)).size;
    const categories = new Set(txs.map((t) => t.category || 'stock')).size;
    return {
      count: txs.length,
      buys,
      sells,
      turnover,
      commissionPln,
      commissionPct,
      unconvertible,
      tickers,
      currencies,
      categories,
    };
  }, [data]);

  return (
    <Grid>
      <Tile
        label="Transakcji"
        value={String(stats.count)}
        sub={`${stats.buys} kupno · ${stats.sells} sprzedaż`}
      />
      <Tile
        label="Obrót"
        value={formatPLN(stats.turnover)}
        sub={
          stats.unconvertible > 0
            ? `łącznie (bez ${stats.unconvertible} poz. bez kursu)`
            : 'łącznie'
        }
      />
      <Tile
        label="Prowizje"
        value={formatPLN(stats.commissionPln)}
        sub={`${stats.commissionPct.toFixed(2)}% obrotu`}
      />
      <Tile
        label="Instrumentów"
        value={String(stats.tickers)}
        sub={`${stats.currencies} walut · ${stats.categories} kategorii`}
      />
    </Grid>
  );
}

// ═══════════════════════ OTWARTE ═══════════════════════

function OpenTilesView({ positions }: { positions: Position[] }) {
  const stats = useMemo(() => {
    const totalValue = positions.reduce((s, p) => s + p.currentValuePln, 0);
    const totalPL = positions.reduce((s, p) => s + p.profitLossPln, 0);
    const invested = totalValue - totalPL;
    const plPct = invested > 0 ? (totalPL / invested) * 100 : 0;
    const currencies = new Set(positions.map((p) => p.currency));

    // Najlepsza / Najgorsza by profitLossPct
    let best: Position | null = null;
    let worst: Position | null = null;
    for (const p of positions) {
      if (!best || p.profitLossPct > best.profitLossPct) best = p;
      if (!worst || p.profitLossPct < worst.profitLossPct) worst = p;
    }

    return {
      count: positions.length,
      totalValue,
      totalPL,
      plPct,
      invested,
      currencies: currencies.size,
      best,
      worst,
    };
  }, [positions]);

  return (
    <Grid>
      <Tile label="Pozycji" value={String(stats.count)} sub={`${stats.currencies} walut`} />
      <Tile label="Wartość" value={formatPLN(stats.totalValue)} />
      <Tile
        label="P/L niezrealizowany"
        value={formatPLN(stats.totalPL)}
        valueClass={plColor(stats.totalPL)}
        sub={
          stats.invested > 0
            ? `${stats.plPct >= 0 ? '+' : ''}${stats.plPct.toFixed(2)}%`
            : undefined
        }
        subClass={plColor(stats.plPct)}
      />
      <BestWorstTile best={stats.best} worst={stats.worst} />
    </Grid>
  );
}

function BestWorstTile({ best, worst }: { best: Position | null; worst: Position | null }) {
  if (!best || !worst || best.ticker === worst.ticker) {
    return (
      <Tile
        label="Najlepsza · Najgorsza"
        value={best ? best.ticker : '—'}
        sub={
          best
            ? `${best.profitLossPct >= 0 ? '+' : ''}${best.profitLossPct.toFixed(2)}%`
            : undefined
        }
        subClass={best ? plColor(best.profitLossPct) : ''}
      />
    );
  }
  return (
    <div className="rounded-xl bg-card border border-border px-3 py-2.5 md:px-4 md:py-3">
      <p className="text-[10px] md:text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
        Najlepsza · Najgorsza
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="font-mono text-xs font-semibold truncate">{best.ticker}</p>
          <p className="text-sm md:text-base font-bold tabular-nums tracking-tight text-gain">
            +{best.profitLossPct.toFixed(2)}%
          </p>
        </div>
        <div className="border-l border-border/60 pl-2">
          <p className="font-mono text-xs font-semibold truncate">{worst.ticker}</p>
          <p className="text-sm md:text-base font-bold tabular-nums tracking-tight text-loss">
            {worst.profitLossPct.toFixed(2)}%
          </p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════ ZAMKNIĘTE ═══════════════════════

function ClosedTilesView({
  dateRange,
  customFrom,
  customTo,
}: {
  dateRange: string;
  customFrom: string;
  customTo: string;
}) {
  const { data } = useQuery({
    queryKey: QUERY_KEYS.closedTrades,
    queryFn: () => api.getClosedTrades(),
  });

  const stats = useMemo(() => {
    let trades = data?.trades || [];
    // Apply the same date filter used by ClosedTradesPage (file linie ~124-148)
    if (dateRange !== 'ALL') {
      let fromDate: string | undefined;
      let toDate: string | undefined;
      if (dateRange === 'CUSTOM') {
        fromDate = customFrom || undefined;
        toDate = customTo || undefined;
      } else {
        fromDate = `${dateRange}-01-01`;
        toDate = `${dateRange}-12-31`;
      }
      if (fromDate) trades = trades.filter((t) => t.sellDate.slice(0, 10) >= fromDate!);
      if (toDate) trades = trades.filter((t) => t.sellDate.slice(0, 10) <= toDate!);
    }
    // Suma w PLN: serwer przelicza każdą nogę po kursie z jej dnia (profitLossPln)
    // i zwraca costBasisPln (z nominałem obligacji / notionalem CFD). Pozycje bez
    // kursu pomijamy i raportujemy w sub zamiast sumować surowe kwoty jak złotówki.
    let totalPnl = 0;
    let totalCost = 0;
    let unconvertible = 0;
    for (const t of trades) {
      const pln = t.profitLossPln ?? (t.currency === 'PLN' ? t.profitLoss : null);
      if (pln == null) {
        unconvertible += 1;
        continue;
      }
      totalPnl += pln;
      totalCost +=
        t.costBasisPln ??
        (t.currency === 'PLN' ? (t.buyPrice ?? 0) * (t.quantity ?? 0) + (t.buyCommission ?? 0) : 0);
    }
    const pnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
    const profitable = trades.filter((t) => t.profitLoss > 0).length;
    const losers = trades.filter((t) => t.profitLoss < 0).length;
    const winRate = trades.length > 0 ? (profitable / trades.length) * 100 : 0;
    const holdDays = trades.map((t) => t.holdingDays).filter((d) => d >= 0);
    const avgHold = holdDays.length > 0 ? holdDays.reduce((s, d) => s + d, 0) / holdDays.length : 0;
    const minHold = holdDays.length > 0 ? Math.min(...holdDays) : 0;
    const maxHold = holdDays.length > 0 ? Math.max(...holdDays) : 0;
    const uniqueTickers = new Set(trades.map((t) => t.ticker)).size;
    return {
      count: trades.length,
      uniqueTickers,
      totalPnl,
      pnlPct,
      unconvertible,
      profitable,
      losers,
      winRate,
      avgHold,
      minHold,
      maxHold,
    };
  }, [data, dateRange, customFrom, customTo]);

  return (
    <Grid>
      <Tile label="Zamknięć" value={String(stats.count)} sub={`${stats.uniqueTickers} tickerów`} />
      <Tile
        label="P/L zrealizowany"
        value={formatPLN(stats.totalPnl)}
        valueClass={plColor(stats.totalPnl)}
        sub={
          [
            stats.pnlPct !== 0 ? `${stats.pnlPct >= 0 ? '+' : ''}${stats.pnlPct.toFixed(2)}%` : '',
            stats.unconvertible > 0 ? `bez ${stats.unconvertible} poz. bez kursu` : '',
          ]
            .filter(Boolean)
            .join(' · ') || undefined
        }
        subClass={stats.unconvertible > 0 ? undefined : plColor(stats.pnlPct)}
      />
      <Tile
        label="Win rate"
        value={`${stats.winRate.toFixed(0)}%`}
        valueClass={
          stats.winRate >= 50 ? 'text-gain' : stats.winRate >= 40 ? 'text-foreground' : 'text-loss'
        }
        sub={`${stats.profitable} zyskownych · ${stats.losers} stratnych`}
      />
      <Tile
        label="Śr. czas trzymania"
        value={`${formatNumber(stats.avgHold, 0)} dni`}
        sub={stats.count > 0 ? `min ${stats.minHold} · max ${stats.maxHold}` : undefined}
      />
    </Grid>
  );
}

// ═══════════════════════ Shared primitives ═══════════════════════

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">{children}</div>;
}

interface TileProps {
  label: string;
  value: string;
  valueClass?: string;
  sub?: string;
  subClass?: string;
}

function Tile({ label, value, valueClass, sub, subClass }: TileProps) {
  return (
    <div className="rounded-xl bg-card border border-border px-3 py-2.5 md:px-4 md:py-3">
      <p className="text-[10px] md:text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
        {label}
      </p>
      <p className={cn('text-sm md:text-base font-bold tabular-nums tracking-tight', valueClass)}>
        {value}
      </p>
      {sub && (
        <p className={cn('text-[10px] md:text-xs text-muted-foreground mt-0.5', subClass)}>{sub}</p>
      )}
    </div>
  );
}

// PLN conversion helper — consistent with TradesFeed.valuePln.
// `null` = waluta obca bez kursu FX, nie da się przeliczyć (wiersz pomijamy w agregatach).
function fxFor(tx: { currency: string; fxRate?: number }): number | null {
  if (tx.currency === 'PLN') return 1;
  if (tx.fxRate && tx.fxRate > 0) return tx.fxRate;
  return null;
}
