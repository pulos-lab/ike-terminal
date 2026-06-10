import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/loading-spinner';

const CATEGORY_LABELS: Record<string, string> = {
  import: 'Import',
  wykres: 'Wykres',
  portfel: 'Portfel',
  transakcje: 'Transakcje',
  dywidendy: 'Dywidendy',
  waluty: 'Waluty',
  inne: 'Inne',
};

export function BugReportsPage() {
  const {
    data: reports,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['bug-reports'],
    queryFn: api.getBugReports,
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground p-6">Ładowanie...</div>;
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
          {error instanceof Error ? error.message : 'Brak dostępu'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Zgłoszenia błędów</h1>
        <span className="text-sm text-muted-foreground">{reports?.length || 0} zgłoszeń</span>
      </div>

      {!reports?.length ? (
        <EmptyState message="Brak zgłoszeń. Użytkownicy mogą je wysyłać z menu „Zgłoś błąd”." />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Data</TableHead>
                <TableHead className="w-[100px]">Kategoria</TableHead>
                <TableHead>Opis</TableHead>
                <TableHead className="w-[180px]">Email</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(r.createdAt + 'Z').toLocaleString('pl-PL', {
                      day: '2-digit',
                      month: '2-digit',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">
                      {CATEGORY_LABELS[r.category] || r.category}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm max-w-md">
                    <p className="whitespace-pre-wrap break-words">{r.description}</p>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.userEmail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
