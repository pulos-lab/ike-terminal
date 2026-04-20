import { Button } from '@/components/ui/button';
import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { formatNumber, formatCurrency, formatQuantity, formatDate } from '@/lib/formatters';
import { TrendingDown } from 'lucide-react';

interface BuyLot {
  quantity: number;
  price: number;
  commission: number;
  date: string;
  currency: string;
}

interface Position {
  paperName: string;
  ticker: string;
  shares: number;
  avgBuyPrice: number;
  currentPrice: number | null;
  currentValuePln: number;
  profitLoss: number;
  profitLossPct: number;
  currency: string;
  category?: 'stock' | 'etf' | 'cfd';
  buyLots?: BuyLot[];
}

interface Props {
  position: Position;
  onSell: () => void;
}

export function PositionCardMobile({ position, onSell }: Props) {
  const lots = position.buyLots || [];
  const buyDates = lots.map((l) => l.date).sort();
  const minBuyDate = buyDates[0] || '';
  const maxBuyDate = buyDates[buyDates.length - 1] || '';
  const sameBuyDate = minBuyDate.slice(0, 10) === maxBuyDate.slice(0, 10);
  const dateLabel = minBuyDate
    ? sameBuyDate
      ? formatDate(minBuyDate)
      : `${formatDate(minBuyDate)} – ${formatDate(maxBuyDate)}`
    : '—';

  return (
    <div className="rounded-xl border border-border bg-card p-3 flex gap-3 items-center">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="font-mono font-semibold text-sm">{position.ticker}</span>
          <CategoryBadge category={position.category} />
          {lots.length > 1 && (
            <span className="text-[10px] text-muted-foreground">({lots.length})</span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {formatQuantity(position.shares)} × {formatNumber(position.avgBuyPrice)} · {dateLabel}
        </p>
      </div>

      <div className="text-right flex-shrink-0">
        <p className="font-semibold text-sm tabular-nums">
          {formatNumber(position.currentValuePln)} zł
        </p>
        <p className={`text-[11px] tabular-nums font-medium ${plColor(position.profitLossPct)}`}>
          {formatCurrency(position.profitLoss, position.currency)}
        </p>
        <div className="mt-1 flex justify-end">
          <PLBadge value={position.profitLossPct} />
        </div>
      </div>

      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onSell}
        className="text-muted-foreground hover:text-red-500 flex-shrink-0"
        aria-label="Sprzedaj"
      >
        <TrendingDown className="h-4 w-4" />
      </Button>
    </div>
  );
}
