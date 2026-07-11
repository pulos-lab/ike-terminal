import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { OperationTypeAlias, UnknownTypeReport } from 'shared';
import { BROKER_LABELS, type BrokerType } from 'shared';
import { api } from '@/lib/api-client';
import { errorToast } from '@/lib/error-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/loading-spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Ban, Check, Loader2, X } from 'lucide-react';

// Panel admina: zgłoszenia nieznanych typów operacji (skrzynki "Do wyjaśnienia"
// użytkowników) + mapa aliasów konsumowana przez parsery. Approve zgłoszenia =
// alias approved → od następnego importu typ działa dla wszystkich bez deployu.

const REPORTS_KEY = ['admin-type-reports'] as const;
const ALIASES_KEY = ['admin-type-aliases'] as const;

const REPORT_STATUS_BADGE: Record<
  string,
  { label: string; variant: 'warning' | 'success' | 'secondary' | 'destructive' }
> = {
  open: { label: 'Otwarte', variant: 'warning' },
  approved: { label: 'Zatwierdzone', variant: 'success' },
  rejected: { label: 'Odrzucone', variant: 'destructive' },
  wont_fix: { label: 'Poza zakresem', variant: 'secondary' },
};

const CLASSIFIED_AS_LABELS: Record<string, string> = {
  trade: 'kupno/sprzedaż',
  dividend: 'dywidenda',
  deposit: 'wpłata/wypłata',
  cost: 'opłata/koszt',
  fx: 'wymiana walut',
};

const OPERATION_TYPE_LABELS_PL: Record<string, string> = {
  deposit: 'Wpłata',
  withdrawal: 'Wypłata',
  dividend: 'Dywidenda',
  fee: 'Opłata',
  trade_fee: 'Koszt pozycji',
  commission_refund: 'Zwrot prowizji',
  capital_return: 'Zwrot kapitału',
  other: 'Inna operacja',
};

function brokerLabel(broker: string): string {
  if (broker === 'generic') return 'Import uniwersalny';
  return BROKER_LABELS[broker as BrokerType] ?? broker;
}

/** Formularz approve — wybór targetu aliasu z walidowanym katalogiem z serwera. */
function ApproveDialog({
  report,
  onClose,
}: {
  report: UnknownTypeReport | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [targetKind, setTargetKind] = useState<string>('cash_operation');
  const [parserType, setParserType] = useState<string>('');
  const [operationType, setOperationType] = useState<string>('other');
  const [sign, setSign] = useState<string>('file');
  const [note, setNote] = useState('');

  const { data: catalog } = useQuery({
    queryKey: ['admin-type-alias-catalog'],
    queryFn: api.adminTypeAliasCatalog,
    staleTime: Infinity,
  });
  const parserTypes = report ? (catalog?.parserTypes[report.broker] ?? []) : [];

  const approveMutation = useMutation({
    mutationFn: () => {
      const targetValue =
        targetKind === 'parser_type'
          ? parserType
          : targetKind === 'cash_operation'
            ? JSON.stringify({ operationType, sign })
            : undefined;
      return api.adminApproveTypeReport(report!.id, {
        targetKind,
        targetValue,
        note: note.trim() || undefined,
      });
    },
    onSuccess: () => {
      toast.success('Alias zatwierdzony — kolejne importy rozpoznają ten typ automatycznie');
      queryClient.invalidateQueries({ queryKey: REPORTS_KEY });
      queryClient.invalidateQueries({ queryKey: ALIASES_KEY });
      onClose();
    },
    onError: (err) => errorToast('Nie udało się zatwierdzić', err),
  });

  const canSubmit =
    targetKind === 'ignore' ||
    (targetKind === 'parser_type' && parserType) ||
    (targetKind === 'cash_operation' && operationType);

  return (
    <Dialog open={report !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Zatwierdź alias typu</DialogTitle>
          <DialogDescription>
            {report && (
              <>
                <span className="font-mono">{report.rawType}</span> ({brokerLabel(report.broker)}) —
                wybierz, jak parser ma traktować ten typ przy kolejnych importach.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">Rodzaj mapowania *</label>
            <Select value={targetKind} onValueChange={setTargetKind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cash_operation">
                  Operacja gotówkowa (bez logiki parsera)
                </SelectItem>
                {parserTypes.length > 0 && (
                  <SelectItem value="parser_type">
                    Typ parsera (pełne parsowanie wiersza)
                  </SelectItem>
                )}
                <SelectItem value="ignore">Ignoruj (wiersz nieistotny)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {targetKind === 'parser_type' && (
            <div>
              <label className="text-xs text-muted-foreground">Kanoniczny typ parsera *</label>
              <Select value={parserType} onValueChange={setParserType}>
                <SelectTrigger>
                  <SelectValue placeholder="Wybierz typ…" />
                </SelectTrigger>
                <SelectContent>
                  {parserTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {targetKind === 'cash_operation' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground">Typ operacji *</label>
                <Select value={operationType} onValueChange={setOperationType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(catalog?.operationTypes ?? []).map((t) => (
                      <SelectItem key={t} value={t}>
                        {OPERATION_TYPE_LABELS_PL[t] ?? t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Znak kwoty</label>
                <Select value={sign} onValueChange={setSign}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="file">Jak w pliku</SelectItem>
                    <SelectItem value="+">Zawsze dodatni</SelectItem>
                    <SelectItem value="-">Zawsze ujemny</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div>
            <label className="text-xs text-muted-foreground">Notatka (opcjonalnie)</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={approveMutation.isPending}>
            Anuluj
          </Button>
          <Button
            onClick={() => approveMutation.mutate()}
            disabled={!canSubmit || approveMutation.isPending}
          >
            {approveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Zatwierdź alias
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReportCard({ report, onApprove }: { report: UnknownTypeReport; onApprove: () => void }) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: REPORTS_KEY });

  const rejectMutation = useMutation({
    mutationFn: () => api.adminRejectTypeReport(report.id),
    onSuccess: () => {
      toast.success('Zgłoszenie odrzucone');
      invalidate();
    },
    onError: (err) => errorToast('Nie udało się odrzucić', err),
  });
  const wontFixMutation = useMutation({
    mutationFn: () => api.adminWontFixTypeReport(report.id),
    onSuccess: () => {
      toast.success('Oznaczono jako poza zakresem');
      invalidate();
    },
    onError: (err) => errorToast('Nie udało się oznaczyć', err),
  });

  const badge = REPORT_STATUS_BADGE[report.status] ?? REPORT_STATUS_BADGE.open;
  const lastSuggestion = report.suggestions[report.suggestions.length - 1];

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs">
            {report.rawType}
          </Badge>
          <Badge variant={badge.variant}>{badge.label}</Badge>
          {report.kind === 'unsupported' && <Badge variant="info">Feature gap</Badge>}
          <span className="text-xs text-muted-foreground">
            {brokerLabel(report.broker)} · {report.occurrenceCount}× · {report.reporterCount}{' '}
            {report.reporterCount === 1 ? 'użytkownik' : 'użytkowników'}
          </span>
        </div>

        {lastSuggestion?.classifiedAs && (
          <p className="text-sm">
            <span className="text-muted-foreground">Sklasyfikowane przez użytkownika jako: </span>
            {CLASSIFIED_AS_LABELS[lastSuggestion.classifiedAs] ?? lastSuggestion.classifiedAs}
          </p>
        )}
        {report.suggestions
          .filter((s) => s.note)
          .slice(-3)
          .map((s, i) => (
            <p key={i} className="text-xs text-muted-foreground italic">
              „{s.note}"
            </p>
          ))}
        {report.reviewNote && (
          <p className="text-xs text-muted-foreground">Notatka review: {report.reviewNote}</p>
        )}

        {report.sampleCells && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((e) => !e)}
            className="text-xs"
          >
            {expanded ? 'Ukryj próbkę' : 'Pokaż zredagowaną próbkę'}
          </Button>
        )}
        {expanded && report.sampleCells && (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              {report.headers && (
                <TableHeader>
                  <TableRow>
                    {report.headers.map((h, i) => (
                      <TableHead key={i} className="text-xs whitespace-nowrap">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
              )}
              <TableBody>
                <TableRow>
                  {report.sampleCells.map((c, i) => (
                    <TableCell key={i} className="text-xs font-mono whitespace-nowrap">
                      {c || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  ))}
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}

        {report.status === 'open' && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={onApprove} className="text-xs">
              <Check className="h-3.5 w-3.5" />
              Zatwierdź alias
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => rejectMutation.mutate()}
              disabled={rejectMutation.isPending}
              className="text-xs"
            >
              <X className="h-3.5 w-3.5" />
              Odrzuć
            </Button>
            {report.kind === 'unsupported' && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => wontFixMutation.mutate()}
                disabled={wontFixMutation.isPending}
                className="text-xs"
              >
                <Ban className="h-3.5 w-3.5" />
                Poza zakresem
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AliasesSection() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ALIASES_KEY, queryFn: () => api.adminListTypeAliases() });

  const revokeMutation = useMutation({
    mutationFn: (id: number) => api.adminRevokeTypeAlias(id),
    onSuccess: () => {
      toast.success('Alias wyłączony (działa tylko na przyszłe importy)');
      queryClient.invalidateQueries({ queryKey: ALIASES_KEY });
    },
    onError: (err) => errorToast('Nie udało się wyłączyć aliasu', err),
  });

  const aliases = data?.aliases ?? [];
  if (aliases.length === 0) {
    return <EmptyState message="Brak aliasów — zatwierdź pierwsze zgłoszenie powyżej." />;
  }

  const describeTarget = (a: OperationTypeAlias): string => {
    if (a.targetKind === 'ignore') return 'ignoruj';
    if (a.targetKind === 'parser_type') return `typ parsera: ${a.targetValue}`;
    try {
      const t = JSON.parse(a.targetValue ?? '{}');
      return `operacja: ${OPERATION_TYPE_LABELS_PL[t.operationType] ?? t.operationType}${
        t.sign && t.sign !== 'file' ? ` (znak ${t.sign})` : ''
      }`;
    } catch {
      return a.targetValue ?? '';
    }
  };

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Broker</TableHead>
            <TableHead>Typ z pliku</TableHead>
            <TableHead>Mapowanie</TableHead>
            <TableHead>Status</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {aliases.map((a) => (
            <TableRow key={a.id}>
              <TableCell className="text-sm">{brokerLabel(a.broker)}</TableCell>
              <TableCell className="font-mono text-xs">{a.rawType}</TableCell>
              <TableCell className="text-sm">{describeTarget(a)}</TableCell>
              <TableCell>
                <Badge variant={a.status === 'approved' ? 'success' : 'secondary'}>
                  {a.status}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                {a.status === 'approved' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => revokeMutation.mutate(a.id)}
                    disabled={revokeMutation.isPending}
                    className="text-xs text-muted-foreground hover:text-destructive"
                  >
                    Wyłącz
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function TypeAliasesPage() {
  const [statusFilter, setStatusFilter] = useState<'open' | 'all'>('open');
  const [approving, setApproving] = useState<UnknownTypeReport | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: [...REPORTS_KEY, statusFilter],
    queryFn: () =>
      api.adminListTypeReports(statusFilter === 'open' ? { status: 'open' } : undefined),
  });

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
          {error instanceof Error ? error.message : 'Brak dostępu'}
        </div>
      </div>
    );
  }

  const reports = data?.reports ?? [];

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">Typy operacji — zgłoszenia i aliasy</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Nieznane typy operacji zgłoszone ze skrzynek „Do wyjaśnienia". Zatwierdzenie aliasu
          sprawia, że kolejne importy wszystkich użytkowników rozpoznają typ automatycznie — bez
          wdrożenia.
        </p>
      </div>

      <div className="space-y-3">
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'open' | 'all')}>
          <TabsList>
            <TabsTrigger value="open">Otwarte</TabsTrigger>
            <TabsTrigger value="all">Wszystkie</TabsTrigger>
          </TabsList>
        </Tabs>

        {isLoading ? (
          <div className="text-sm text-muted-foreground py-6">Ładowanie...</div>
        ) : reports.length === 0 ? (
          <EmptyState message="Brak zgłoszeń — użytkownicy zgłaszają nieznane typy ze skrzynki „Do wyjaśnienia”." />
        ) : (
          <div className="space-y-3">
            {reports.map((r) => (
              <ReportCard key={r.id} report={r} onApprove={() => setApproving(r)} />
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Aliasy</h2>
        <AliasesSection />
      </div>

      <ApproveDialog
        key={approving?.id ?? 'none'}
        report={approving}
        onClose={() => setApproving(null)}
      />
    </div>
  );
}
