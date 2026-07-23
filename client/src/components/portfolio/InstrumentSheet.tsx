import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import type { Position } from 'shared';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge } from '@/components/ui/pl-badge';
import { CcyChip } from '@/components/ui/ccy-chip';
import { formatNumber, formatQuantity } from '@/lib/formatters';
import { InstrumentChart } from './InstrumentChart';
import { InstrumentTxList } from './InstrumentTxList';

/**
 * Panel boczny instrumentu: wykres kursu z markerami K/S + lista transakcji.
 * Otwierany klikiem w wiersz pozycji — tabela zostaje widoczna pod spodem;
 * pełny widok z URL dostępny linkiem „Strona instrumentu".
 */
export function InstrumentSheet({
  position,
  open,
  onOpenChange,
}: {
  position: Position | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* sm:max-w-2xl — prefiks sm: konieczny, default to sm:max-w-sm */}
      <SheetContent side="right" className="sm:max-w-2xl w-full overflow-y-auto">
        {position && (
          <>
            <SheetHeader className="pb-0">
              <SheetTitle className="flex items-center gap-2 min-w-0">
                <span className="font-mono">{position.ticker}</span>
                <CategoryBadge category={position.category} />
                <span className="truncate text-sm font-normal text-muted-foreground">
                  {position.paperName}
                </span>
              </SheetTitle>
              <SheetDescription className="flex items-center justify-between gap-2">
                <span>
                  Kurs z transakcjami: kupno (▲), sprzedaż (▼), dywidenda (●), split/spin-off (▪)
                </span>
                {/* mr-6: nie nachodzimy na wbudowany przycisk X w rogu panelu */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 gap-1.5 text-muted-foreground mr-6"
                  onClick={() => {
                    onOpenChange(false);
                    navigate(`/app/instrument/${encodeURIComponent(position.isin)}`);
                  }}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Strona instrumentu
                </Button>
              </SheetDescription>
            </SheetHeader>
            <div className="px-4 flex flex-col gap-4">
              <InstrumentChart
                isin={position.isin}
                avgBuyPrice={position.avgBuyPrice}
                height={300}
              />
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
                <span>
                  Ilość:{' '}
                  <strong className="text-foreground tabular-nums">
                    {formatQuantity(position.shares)}
                  </strong>
                </span>
                <span>
                  Śr. cena:{' '}
                  <strong className="text-foreground tabular-nums">
                    {formatNumber(position.avgBuyPrice)}
                  </strong>
                </span>
                <span>
                  Kurs:{' '}
                  <strong className="text-foreground tabular-nums">
                    {position.currentPrice ? formatNumber(position.currentPrice) : '—'}
                  </strong>{' '}
                  <CcyChip ccy={position.currency} />
                </span>
                <span className="flex items-center gap-1.5">
                  P/L: <PLBadge value={position.profitLossPct} />
                </span>
              </div>
              <div>
                <h3 className="text-sm font-medium mb-1">Transakcje</h3>
                <InstrumentTxList isin={position.isin} />
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
