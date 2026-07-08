import type { Position } from 'shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { PLBadge, plColor } from '@/components/ui/pl-badge';
import { CcyChip } from '@/components/ui/ccy-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertTriangle } from 'lucide-react';
import { formatCurrency, formatNumber, formatPLN, formatQuantity } from '@/lib/formatters';

/**
 * Karta „Opcje" w zakładce Portfel — wydzielona sekcja dla pozycji category='option'
 * (wzorzec karty „Wolna gotówka"). Ujemna ilość = pozycja krótka (wystawiona opcja),
 * ujemna wartość = zobowiązanie odkupu. DTE = dni do wygaśnięcia.
 */

function daysToExpiry(expiry: string): number {
  const today = new Date().toISOString().slice(0, 10);
  return Math.round(
    (new Date(`${expiry}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

/** "DKNG 60 PUT 2022-05-20" z optionMeta; fallback: paperName (symbol IBKR jest czytelny). */
function optionLabel(pos: Position): string {
  const meta = pos.optionMeta;
  if (!meta) return pos.paperName;
  return `${meta.underlying} ${formatNumber(meta.strike)} ${meta.optionType === 'C' ? 'CALL' : 'PUT'}`;
}

export function PortfolioOptionsCard({
  positions,
  totalValuePln,
}: {
  positions: Position[];
  totalValuePln: number;
}) {
  if (positions.length === 0) return null;
  const optionsValuePln = positions.reduce((s, p) => s + p.currentValuePln, 0);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Opcje
          <span className="ml-2 text-muted-foreground font-normal">
            ({positions.length} {positions.length === 1 ? 'pozycja' : 'pozycje'} |{' '}
            {formatPLN(optionsValuePln)})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Instrument</TableHead>
                <TableHead>Wygasa</TableHead>
                <TableHead className="text-right">DTE</TableHead>
                <TableHead className="text-right">Ilość</TableHead>
                <TableHead className="text-right">Śr. premia</TableHead>
                <TableHead className="text-right">Kurs</TableHead>
                <TableHead className="text-right">Wartość (PLN)</TableHead>
                <TableHead className="text-right">P/L</TableHead>
                <TableHead className="text-right">P/L %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.map((pos) => {
                const isShort = pos.shares < 0;
                const dte = pos.optionMeta ? daysToExpiry(pos.optionMeta.expiry) : null;
                return (
                  <TableRow key={pos.isin}>
                    <TableCell className="font-mono font-medium whitespace-nowrap">
                      {optionLabel(pos)}
                      {isShort && (
                        <Badge variant="outline" className="ml-2 text-red-600 border-red-300">
                          SHORT
                        </Badge>
                      )}
                      {pos.expiryPassed && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <AlertTriangle className="h-4 w-4 text-amber-500 inline ml-1 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-[280px]">
                            Opcja po dacie wygaśnięcia, a pozycja wciąż otwarta — prawdopodobnie
                            brakuje wiersza wygaśnięcia/wykonania w zaimportowanych wyciągach.
                            Zaimportuj nowszy Activity Statement albo dodaj transakcję zamykającą
                            ręcznie.
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {pos.optionMeta?.expiry ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {dte === null ? (
                        '—'
                      ) : dte < 0 ? (
                        <Badge variant="outline" className="text-red-600 border-red-300">
                          po terminie
                        </Badge>
                      ) : dte <= 7 ? (
                        <Badge variant="outline" className="text-amber-600 border-amber-300">
                          {dte} dni
                        </Badge>
                      ) : (
                        `${dte} dni`
                      )}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${isShort ? 'text-red-600 font-medium' : ''}`}
                    >
                      {formatQuantity(pos.shares)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(pos.avgBuyPrice)}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="tabular-nums">
                        {pos.currentPrice ? formatNumber(pos.currentPrice) : '—'}
                      </span>
                      <CcyChip ccy={pos.currency} className="ml-1.5" />
                      {pos.priceManual && (
                        <span
                          className="ml-1 text-[10px] text-muted-foreground/60"
                          title="Cena z ostatniej transakcji — kontrakt bez aktualnych notowań (np. Eurex)"
                        >
                          ⚠
                        </span>
                      )}
                    </TableCell>
                    <TableCell
                      className={`text-right font-medium tabular-nums ${pos.currentValuePln < 0 ? 'text-red-600' : ''}`}
                    >
                      {formatPLN(pos.currentValuePln)}
                    </TableCell>
                    <TableCell className={`text-right font-medium ${plColor(pos.profitLossPct)}`}>
                      {formatCurrency(pos.profitLoss, pos.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      <PLBadge value={pos.profitLossPct} />
                    </TableCell>
                  </TableRow>
                );
              })}
              <TableRow className="border-t-2 font-semibold">
                <TableCell colSpan={6} className="text-right">
                  Razem
                </TableCell>
                <TableCell
                  className={`text-right tabular-nums ${optionsValuePln < 0 ? 'text-red-600' : ''}`}
                >
                  {formatPLN(optionsValuePln)}
                </TableCell>
                <TableCell colSpan={2} className="text-right text-muted-foreground font-normal">
                  {totalValuePln > 0
                    ? `${((optionsValuePln / totalValuePln) * 100).toFixed(1)}% portfela`
                    : ''}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
