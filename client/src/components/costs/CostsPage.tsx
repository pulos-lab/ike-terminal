import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { usePortfolio } from '@/lib/portfolio-context';
import { QUERY_KEYS } from '@/lib/query-keys';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LoadingSpinner } from '@/components/ui/loading-spinner';
import { CcyChip } from '@/components/ui/ccy-chip';
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

  // Group by cost type for summary tiles (e.g. "swap", "rollover", "Withholding tax")
  const summary = fees.reduce<Record<string, { count: number; total: number; currency: string }>>((acc, f) => {
    let key: string;
    if (f.description.startsWith('DEGIRO Exchange Connection Fee')) {
      key = 'DEGIRO Exchange Connection Fee';
    } else if (f.description.startsWith('Free-funds Interest Tax')) {
      key = 'Free-funds Interest Tax';
    } else if (f.description.includes(':')) {
      key = f.description.split(':')[0].trim();
    } else {
      key = f.description;
    }
    if (!acc[key]) acc[key] = { count: 0, total: 0, currency: f.currency };
    acc[key].count++;
    acc[key].total += f.amount;
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      <div className="grid gap-2 md:grid-cols-3">
        {Object.entries(summary).map(([desc, s]) => (
          <div key={desc} className="rounded-xl bg-card border border-border px-4 py-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
              {desc}
            </p>
            <p className="text-base font-bold tabular-nums tracking-tight">
              {formatCurrency(s.total, s.currency)}
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">
              {s.count} operacji
            </p>
          </div>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span className="text-base">Historia kosztów</span>
            <span className="text-sm font-normal text-muted-foreground tabular-nums">
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
                  <TableHead>Źródło</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fees.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="tabular-nums">{formatDate(f.date)}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{f.description}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(f.amount, f.currency)}</TableCell>
                    <TableCell><CcyChip ccy={f.currency} /></TableCell>
                    <TableCell className="text-muted-foreground text-xs">{f.source}</TableCell>
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
