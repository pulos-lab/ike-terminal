import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CategoryBadge } from '@/components/ui/category-badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { CcyChip } from '@/components/ui/ccy-chip';
import { formatCurrency, formatNumber, formatQuantity } from '@/lib/formatters';
import { InstrumentChart } from './InstrumentChart';
import { InstrumentTxList } from './InstrumentTxList';

/**
 * WARIANT C (prototyp): dedykowana strona instrumentu (/app/instrument/:isin) —
 * duży wykres z markerami K/S, kafle statystyk pozycji i pełna lista transakcji.
 */
export function InstrumentPage() {
  const { isin = '' } = useParams();
  const navigate = useNavigate();

  const { data: positionsData } = useQuery({
    queryKey: QUERY_KEYS.positions,
    queryFn: api.getPositions,
  });

  const { data: history } = useQuery({
    queryKey: QUERY_KEYS.instrumentHistory(isin),
    queryFn: () => api.getInstrumentHistory(isin),
    staleTime: 12 * 60 * 60 * 1000,
    enabled: !!isin,
  });

  const position = useMemo(
    () => positionsData?.positions.find((p) => p.isin === isin) ?? null,
    [positionsData?.positions, isin],
  );

  const ticker = position?.ticker ?? history?.ticker ?? '';
  const name = position?.paperName ?? history?.name ?? '';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => navigate(-1)}
          title="Wróć"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="flex items-center gap-2 min-w-0 text-lg font-semibold">
          <span className="font-mono">{ticker}</span>
          {position && <CategoryBadge category={position.category} />}
          <span className="truncate text-sm font-normal text-muted-foreground">{name}</span>
        </h1>
      </div>

      {position && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatTile label="Ilość" value={formatQuantity(position.shares)} />
          <StatTile label="Śr. cena nabycia" value={formatNumber(position.avgBuyPrice)} />
          <StatTile
            label="Kurs"
            value={
              <>
                {position.currentPrice ? formatNumber(position.currentPrice) : '—'}{' '}
                <CcyChip ccy={position.currency} />
              </>
            }
          />
          <StatTile
            label="P/L"
            value={
              <span className={plColor(position.profitLoss)}>
                {formatCurrency(position.profitLoss, position.currency)}
              </span>
            }
          />
          <StatTile label="P/L %" value={<PLBadge value={position.profitLossPct} />} />
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            Kurs z transakcjami
            <span className="ml-2 text-muted-foreground font-normal">
              (▲ kupno, ▼ sprzedaż{history ? ` | źródło: ${history.source}` : ''})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <InstrumentChart
            isin={isin}
            avgBuyPrice={position?.avgBuyPrice}
            height={460}
            showRangePresets
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Transakcje</CardTitle>
        </CardHeader>
        <CardContent>
          <InstrumentTxList isin={isin} />
        </CardContent>
      </Card>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}
