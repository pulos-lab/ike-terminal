import type { PublicPositionsResponse } from 'shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PLBadge } from '@/components/ui/pl-badge';
import { CcyChip } from '@/components/ui/ccy-chip';
import { CategoryBadge } from '@/components/ui/category-badge';
import { formatCurrency, formatNumber, formatPercent, formatQuantity } from '@/lib/formatters';

/**
 * Tabela otwartych pozycji w widoku publicznym — lekka wersja PortfolioPage,
 * bez owner-only afordancji (kolumny konfigurowane, alerty splitów, edycja).
 * Kolumny kwotowe renderowane tylko gdy payload je zawiera (showAmounts).
 */
export function PublicPositionsTable({
  data,
  showAmounts,
}: {
  data: PublicPositionsResponse;
  showAmounts: boolean;
}) {
  const { positions, cashPositions, baseCurrency } = data;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Otwarte pozycje</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticker</TableHead>
                <TableHead className="max-w-[200px]">Nazwa</TableHead>
                {showAmounts && <TableHead className="text-right">Ilość</TableHead>}
                <TableHead className="text-right">Kurs</TableHead>
                {showAmounts && <TableHead className="text-right">Wartość</TableHead>}
                <TableHead className="text-right">Zmiana</TableHead>
                {showAmounts && <TableHead className="text-right">P/L</TableHead>}
                <TableHead className="text-right">P/L %</TableHead>
                <TableHead className="text-right">Udział</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.map((pos) => (
                <TableRow key={pos.isin}>
                  <TableCell className="font-medium whitespace-nowrap">
                    {pos.ticker}
                    <CategoryBadge category={pos.category} />
                  </TableCell>
                  <TableCell
                    className="max-w-[200px] truncate text-muted-foreground"
                    title={pos.paperName}
                  >
                    {pos.paperName}
                  </TableCell>
                  {showAmounts && (
                    <TableCell className="text-right tabular-nums">
                      {pos.shares != null ? formatQuantity(pos.shares) : '—'}
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums whitespace-nowrap">
                    {pos.currentPrice != null ? formatNumber(pos.currentPrice) : '—'}{' '}
                    <CcyChip ccy={pos.currency} />
                  </TableCell>
                  {showAmounts && (
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      {pos.currentValuePln != null
                        ? formatCurrency(pos.currentValuePln, baseCurrency)
                        : '—'}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    {pos.dailyChangePct != null ? <PLBadge value={pos.dailyChangePct} /> : '—'}
                  </TableCell>
                  {showAmounts && (
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      {pos.profitLoss != null ? formatCurrency(pos.profitLoss, pos.currency) : '—'}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    <PLBadge value={pos.profitLossPct} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatPercent(pos.weight).replace('+', '')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {cashPositions.length > 0 && (
          <div className="mt-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              Wolna gotówka
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Waluta</TableHead>
                  {showAmounts && <TableHead className="text-right">Saldo</TableHead>}
                  <TableHead className="text-right">Udział w portfelu</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cashPositions.map((cp) => (
                  <TableRow key={cp.currency}>
                    <TableCell>
                      <CcyChip ccy={cp.currency} />
                    </TableCell>
                    {showAmounts && (
                      <TableCell className="text-right tabular-nums">
                        {cp.balance != null ? formatCurrency(cp.balance, cp.currency) : '—'}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {formatPercent(cp.weight).replace('+', '')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
