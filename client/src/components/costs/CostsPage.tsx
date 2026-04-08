import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { usePortfolio } from '@/lib/portfolio-context';
import { QUERY_KEYS } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { formatCurrency, formatDate } from '@/lib/formatters';

interface FeeEntry {
  id: number;
  date: string;
  amount: number;
  currency: string;
  description: string;
  source: string;
}

export function CostsPage() {
  const { activeId } = usePortfolio();
  const { data, isLoading } = useQuery({
    queryKey: [...QUERY_KEYS.fees, activeId],
    queryFn: () => api.getFees(),
  });

  if (isLoading) return <LoadingSpinner />;

  const fees: FeeEntry[] = data?.fees || [];
  const total = data?.total || 0;

  // Group by description for summary (normalize DEGIRO Exchange Connection Fee variants)
  const summary = fees.reduce<Record<string, { count: number; total: number; currency: string }>>((acc, f) => {
    const key = f.description.startsWith('DEGIRO Exchange Connection Fee')
      ? 'DEGIRO Exchange Connection Fee'
      : f.description;
    if (!acc[key]) acc[key] = { count: 0, total: 0, currency: f.currency };
    acc[key].count++;
    acc[key].total += f.amount;
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Inne koszty</h1>

      <div className="grid gap-4 md:grid-cols-3">
        {Object.entries(summary).map(([desc, s]) => (
          <Card key={desc}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{desc}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-xl font-bold">{formatCurrency(s.total, s.currency)}</div>
              <p className="text-xs text-muted-foreground">{s.count} operacji</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Historia kosztow</span>
            <span className="text-sm font-normal text-muted-foreground">
              Razem: {formatCurrency(total, 'EUR')}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {fees.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">Brak operacji kosztowych</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data</TableHead>
                  <TableHead>Opis</TableHead>
                  <TableHead className="text-right">Kwota</TableHead>
                  <TableHead>Waluta</TableHead>
                  <TableHead>Zrodlo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fees.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell>{formatDate(f.date)}</TableCell>
                    <TableCell>{f.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(f.amount, f.currency)}</TableCell>
                    <TableCell>{f.currency}</TableCell>
                    <TableCell className="text-muted-foreground">{f.source}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
