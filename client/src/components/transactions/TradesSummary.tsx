import { useMemo } from 'react';
import { formatPLN } from '@/lib/formatters';
import { plColor } from '@/components/ui/pl-badge';

interface Position {
  shares: number;
  currentValuePln: number;
  profitLossPln: number;
  currency: string;
}

interface Props {
  positions: Position[];
}

export function TradesSummary({ positions }: Props) {
  const stats = useMemo(() => {
    const totalValue = positions.reduce((s, p) => s + p.currentValuePln, 0);
    const totalPL = positions.reduce((s, p) => s + p.profitLossPln, 0);
    const invested = totalValue - totalPL;
    const plPct = invested > 0 ? (totalPL / invested) * 100 : 0;
    const currencies = new Set(positions.map((p) => p.currency));
    return {
      count: positions.length,
      totalValue,
      totalPL,
      plPct,
      invested,
      currencies: currencies.size,
    };
  }, [positions]);

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
      <Tile label="Pozycji" value={String(stats.count)} sub={`${stats.currencies} walut`} />
      <Tile label="Wartość" value={formatPLN(stats.totalValue)} />
      <Tile
        label="P/L niezrealizowany"
        value={formatPLN(stats.totalPL)}
        valueClass={plColor(stats.totalPL)}
        sub={stats.invested > 0 ? `${stats.plPct >= 0 ? '+' : ''}${stats.plPct.toFixed(2)}%` : undefined}
        subClass={plColor(stats.plPct)}
      />
      <Tile label="Kategorie" value={categoriesLabel(positions)} />
    </div>
  );
}

function categoriesLabel(positions: Array<{ category?: string }>): string {
  const stock = positions.filter((p) => p.category === 'stock' || !p.category).length;
  const etf = positions.filter((p) => p.category === 'etf').length;
  const cfd = positions.filter((p) => p.category === 'cfd').length;
  const parts: string[] = [];
  if (stock) parts.push(`${stock}× stock`);
  if (etf) parts.push(`${etf}× etf`);
  if (cfd) parts.push(`${cfd}× cfd`);
  return parts.join(' · ') || '—';
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
      <p className={`text-sm md:text-base font-bold tabular-nums tracking-tight ${valueClass ?? ''}`}>
        {value}
      </p>
      {sub && (
        <p className={`text-[10px] md:text-xs text-muted-foreground mt-0.5 ${subClass ?? ''}`}>
          {sub}
        </p>
      )}
    </div>
  );
}
