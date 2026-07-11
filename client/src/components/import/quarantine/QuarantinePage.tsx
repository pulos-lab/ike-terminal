import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { QuarantineRow, QuarantineStatus, BrokerType } from 'shared';
import { BROKER_LABELS } from 'shared';
import { api } from '@/lib/api-client';
import { errorToast } from '@/lib/error-toast';
import { QUERY_KEYS } from '@/lib/query-keys';
import { SKIP_REASON_LABELS } from '@/lib/import-labels';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/loading-spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CheckCircle2, ChevronDown, ChevronUp, EyeOff, Inbox, Tag, Trash2 } from 'lucide-react';
import { AddTransactionDialog } from '@/components/transactions/AddTransactionDialog';
import { AddDividendDialog } from '@/components/dividends/AddDividendDialog';
import { AddDepositDialog } from '@/components/cash/AddDepositDialog';
import { AddFxExchangeDialog } from '@/components/currency/AddFxExchangeDialog';
import { AddCostDialog } from '@/components/corrections-and-costs/AddCostDialog';

// Skrzynka "Do wyjaśnienia" — wiersze importu, których parser nie rozpoznał.
// Surowa treść żyje wyłącznie w bazie portfela użytkownika; stąd można wiersz
// zignorować (a w kolejnych iteracjach: sklasyfikować ręcznie albo zgłosić).

export const QUARANTINE_QUERY_KEY = ['import-quarantine'] as const;

const STATUS_TABS: Array<{ value: QuarantineStatus; label: string }> = [
  { value: 'pending', label: 'Oczekujące' },
  { value: 'resolved', label: 'Rozstrzygnięte' },
  { value: 'ignored', label: 'Zignorowane' },
  { value: 'reported', label: 'Zgłoszone' },
];

const STATUS_BADGE: Record<
  QuarantineStatus,
  { label: string; variant: 'warning' | 'success' | 'info' | 'secondary' }
> = {
  pending: { label: 'Do wyjaśnienia', variant: 'warning' },
  resolved: { label: 'Rozstrzygnięty', variant: 'success' },
  ignored: { label: 'Zignorowany', variant: 'secondary' },
  reported: { label: 'Zgłoszony', variant: 'info' },
};

function sourceLabel(source: string): string {
  if (source === 'generic') return 'Import uniwersalny';
  return BROKER_LABELS[source as BrokerType] ?? source;
}

function formatAmount(amount: number, currency?: string): string {
  const num = amount.toLocaleString('pl-PL', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${num} ${currency}` : num;
}

/** Rodzaj wpisu wybierany w pickerze "Sklasyfikuj" — mapuje na istniejący dialog dodawania. */
type ClassifyKind = 'trade' | 'dividend' | 'deposit' | 'cost' | 'fx';

const CLASSIFY_OPTIONS: Array<{ kind: ClassifyKind; label: string }> = [
  { kind: 'trade', label: 'Kupno / sprzedaż papieru' },
  { kind: 'dividend', label: 'Dywidenda' },
  { kind: 'deposit', label: 'Wpłata / wypłata' },
  { kind: 'cost', label: 'Opłata / odsetki / inne' },
  { kind: 'fx', label: 'Wymiana walut' },
];

function QuarantineCard({
  row,
  onClassify,
}: {
  row: QuarantineRow;
  onClassify: (kind: ClassifyKind) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: QUARANTINE_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.importStatus });
  };

  const ignoreMutation = useMutation({
    mutationFn: () => api.ignoreQuarantineRow(row.id),
    onSuccess: () => {
      toast.success('Wiersz zignorowany');
      invalidate();
    },
    onError: (err) => errorToast('Nie udało się zignorować wiersza', err),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteQuarantineRow(row.id),
    onSuccess: () => {
      toast.success('Wiersz usunięty ze skrzynki');
      invalidate();
    },
    onError: (err) => errorToast('Nie udało się usunąć wiersza', err),
  });

  const badge = STATUS_BADGE[row.status];
  const hint = row.hint;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {row.rawType && (
            <Badge variant="outline" className="font-mono text-xs">
              {row.rawType}
            </Badge>
          )}
          <Badge variant={badge.variant}>{badge.label}</Badge>
          <span className="text-xs text-muted-foreground">
            {sourceLabel(row.source)}
            {row.fileName ? ` · ${row.fileName}` : ''} · wiersz {row.rowNum} ·{' '}
            {SKIP_REASON_LABELS[row.reason] ?? row.reason}
          </span>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {hint?.date && (
            <span>
              <span className="text-muted-foreground">Data: </span>
              {hint.date}
            </span>
          )}
          {hint?.amount !== undefined && (
            <span>
              <span className="text-muted-foreground">Kwota: </span>
              {formatAmount(hint.amount, hint.currency)}
            </span>
          )}
          {hint?.symbol && (
            <span>
              <span className="text-muted-foreground">Symbol: </span>
              {hint.symbol}
            </span>
          )}
          {hint?.description && (
            <span className="max-w-full truncate">
              <span className="text-muted-foreground">Opis: </span>
              {hint.description}
            </span>
          )}
        </div>

        {row.userNote && (
          <p className="text-xs text-muted-foreground italic">Notatka: {row.userNote}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((e) => !e)}
            className="text-xs"
          >
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            {expanded ? 'Ukryj surowy wiersz' : 'Pokaż surowy wiersz'}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {(row.status === 'pending' || row.status === 'reported') && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" className="text-xs">
                      <Tag className="h-3.5 w-3.5" />
                      Sklasyfikuj
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {CLASSIFY_OPTIONS.map((o) => (
                      <DropdownMenuItem key={o.kind} onSelect={() => onClassify(o.kind)}>
                        {o.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => ignoreMutation.mutate()}
                  disabled={ignoreMutation.isPending}
                  className="text-xs"
                >
                  <EyeOff className="h-3.5 w-3.5" />
                  Zignoruj
                </Button>
              </>
            )}
            {row.status !== 'pending' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                title="Usuń wpis ze skrzynki"
                className="text-xs text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {expanded && (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              {row.headers && (
                <TableHeader>
                  <TableRow>
                    {row.headers.map((h, i) => (
                      <TableHead key={i} className="text-xs whitespace-nowrap">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
              )}
              <TableBody>
                <TableRow>
                  {row.cells.map((c, i) => (
                    <TableCell key={i} className="text-xs font-mono whitespace-nowrap">
                      {c || <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  ))}
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function QuarantinePage() {
  const [status, setStatus] = useState<QuarantineStatus>('pending');
  /** Trwający flow klasyfikacji: wiersz + wybrany rodzaj wpisu (otwarty dialog). */
  const [classify, setClassify] = useState<{ row: QuarantineRow; kind: ClassifyKind } | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: [...QUARANTINE_QUERY_KEY, status],
    queryFn: () => api.getQuarantine(status),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: QUARANTINE_QUERY_KEY });
    queryClient.invalidateQueries({ queryKey: QUERY_KEYS.importStatus });
  };

  // Resolve wołany PO udanym zapisie wpisu przez dialog — jeśli sam resolve
  // padnie, wpis w portfelu już jest, a wiersz zostaje pending (nieszkodliwe:
  // można go wtedy zignorować ręcznie).
  const resolveMutation = useMutation({
    mutationFn: (args: { rowId: number; kind: 'transaction' | 'cash_operation'; refId?: number }) =>
      api.resolveQuarantineRow(args.rowId, { kind: args.kind, refId: args.refId }),
    onSuccess: () => {
      toast.success('Wiersz rozstrzygnięty — wpis jest już w portfelu');
      invalidate();
    },
    onError: (err) =>
      errorToast('Wpis dodany do portfela, ale nie udało się oznaczyć wiersza', err),
  });

  const handleCreated = (kind: 'transaction' | 'cash_operation', refId?: number) => {
    if (!classify) return;
    resolveMutation.mutate({ rowId: classify.row.id, kind, refId });
  };

  const hint = classify?.row.hint;

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive">
          {error instanceof Error ? error.message : 'Nie udało się pobrać skrzynki'}
        </div>
      </div>
    );
  }

  const counts = data?.counts;
  const rows = data?.rows ?? [];

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold">Do wyjaśnienia</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Wiersze z importów, których nie udało się automatycznie rozpoznać. Możesz je przejrzeć
          i zdecydować, co z nimi zrobić — surowa treść pozostaje wyłącznie w Twoim portfelu.
        </p>
      </div>

      <Tabs value={status} onValueChange={(v) => setStatus(v as QuarantineStatus)}>
        <TabsList>
          {STATUS_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
              {counts && counts[t.value] > 0 && (
                <span className="ml-1.5 text-xs text-muted-foreground">{counts[t.value]}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8">Ładowanie...</div>
      ) : rows.length === 0 ? (
        status === 'pending' ? (
          <EmptyState
            icon={CheckCircle2}
            message="Wszystko wyjaśnione — żaden wiersz z importów nie czeka na Twoją decyzję."
          />
        ) : (
          <EmptyState icon={Inbox} message="Brak wierszy w tym widoku." />
        )
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <QuarantineCard
              key={row.id}
              row={row}
              onClassify={(kind) => setClassify({ row, kind })}
            />
          ))}
        </div>
      )}

      {/* Dialogi klasyfikacji — reużyte dialogi ręcznego dodawania z prefill
          z hinta wiersza; key wymusza świeży stan per wiersz. Po udanym zapisie
          onCreated → resolve wiersza. */}
      <AddTransactionDialog
        key={`trade-${classify?.row.id ?? 'none'}`}
        open={classify?.kind === 'trade'}
        onClose={() => setClassify(null)}
        defaultValues={{ date: hint?.date, ticker: hint?.symbol }}
        onCreated={(id) => handleCreated('transaction', id)}
      />
      <AddDividendDialog
        key={`dividend-${classify?.row.id ?? 'none'}`}
        open={classify?.kind === 'dividend'}
        onClose={() => setClassify(null)}
        defaultValues={{
          date: hint?.date,
          ticker: hint?.symbol,
          amount: hint?.amount !== undefined ? Math.abs(hint.amount) : undefined,
          currency: hint?.currency,
        }}
        onCreated={(id) => handleCreated('cash_operation', id)}
      />
      <AddDepositDialog
        key={`deposit-${classify?.row.id ?? 'none'}`}
        open={classify?.kind === 'deposit'}
        onClose={() => setClassify(null)}
        defaultValues={{
          date: hint?.date,
          amount: hint?.amount !== undefined ? Math.abs(hint.amount) : undefined,
          type: hint?.amount !== undefined && hint.amount < 0 ? 'withdrawal' : 'deposit',
        }}
        onCreated={(id) => handleCreated('cash_operation', id)}
      />
      <AddCostDialog
        key={`cost-${classify?.row.id ?? 'none'}`}
        open={classify?.kind === 'cost'}
        onClose={() => setClassify(null)}
        onSuccess={invalidate}
        defaultCurrency={hint?.currency ?? 'PLN'}
        defaultValues={{
          date: hint?.date,
          amount: hint?.amount,
          currency: hint?.currency,
          description: hint?.description,
        }}
        onCreated={(id) => handleCreated('cash_operation', id)}
      />
      <AddFxExchangeDialog
        key={`fx-${classify?.row.id ?? 'none'}`}
        open={classify?.kind === 'fx'}
        onClose={() => setClassify(null)}
        defaultValues={{
          date: hint?.date,
          amountFrom: hint?.amount !== undefined ? Math.abs(hint.amount) : undefined,
          currencyFrom: hint?.currency,
        }}
        onCreated={() => handleCreated('cash_operation')}
      />
    </div>
  );
}
