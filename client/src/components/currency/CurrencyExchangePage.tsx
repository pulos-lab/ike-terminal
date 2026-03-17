import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatNumber, formatDate } from '@/lib/formatters';
import { Loader2 } from 'lucide-react';

export function CurrencyExchangePage() {
  const { data, isLoading } = useQuery({
    queryKey: ['portfolio', 'fx-history'],
    queryFn: api.getFxHistory,
  });

  const { data: pricesData } = useQuery({
    queryKey: ['prices', 'live'],
    queryFn: api.getLivePrices,
    staleTime: 5 * 60 * 1000,
  });

  const fx = pricesData?.fx;
  const usdEur = fx?.USDPLN && fx?.EURPLN ? fx.USDPLN / fx.EURPLN : null;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Historia wymian walut</h1>

      {fx && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-sm text-muted-foreground">USD/PLN</div>
              <div className="text-2xl font-bold font-mono">{formatNumber(fx.USDPLN, 4)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-sm text-muted-foreground">EUR/PLN</div>
              <div className="text-2xl font-bold font-mono">{formatNumber(fx.EURPLN, 4)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <div className="text-sm text-muted-foreground">USD/EUR</div>
              <div className="text-2xl font-bold font-mono">{usdEur ? formatNumber(usdEur, 4) : '—'}</div>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Wymiany PLN/USD</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : data?.exchanges?.length ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data</TableHead>
                    <TableHead>Para</TableHead>
                    <TableHead className="text-right">Kurs</TableHead>
                    <TableHead className="text-right">Kwota (PLN)</TableHead>
                    <TableHead className="text-right">Kwota (USD)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.exchanges.map((ex: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell>{formatDate(ex.date)}</TableCell>
                      <TableCell className="font-mono">{ex.pair}</TableCell>
                      <TableCell className="text-right font-medium">{formatNumber(ex.rate, 4)}</TableCell>
                      <TableCell className="text-right text-red-400">-{formatNumber(ex.amountFrom)}</TableCell>
                      <TableCell className="text-right text-green-500">+{formatNumber(ex.amountTo)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-12 text-muted-foreground">Brak danych.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
