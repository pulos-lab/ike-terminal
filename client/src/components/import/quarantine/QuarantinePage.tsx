import { useMemo, useState } from 'react';
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
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  EyeOff,
  Flag,
  Inbox,
  Layers,
  Loader2,
  Tag,
  Trash2,
} from 'lucide-react';
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
import { AddTransactionDialog } from '@/components/transactions/AddTransactionDialog';
import { AddDividendDialog } from '@/components/dividends/AddDividendDialog';
import { AddDepositDialog } from '@/components/cash/AddDepositDialog';
import { AddFxExchangeDialog } from '@/components/currency/AddFxExchangeDialog';
import { AddCostDialog, ADD_CATEGORIES } from '@/components/corrections-and-costs/AddCostDialog';

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

// ── Grupowanie identycznych typów + klasyfikacja zbiorcza ────────────────────
//
// Ten sam nierozpoznany typ potrafi trafić do skrzynki kilkanaście razy (np.
// dywidendy partial filli). Wiersze o wspólnym (source, reason, rawType) są
// grupowane w jedną kartę, a po sklasyfikowaniu pierwszego wiersza aplikacja
// proponuje zastosowanie tej samej klasyfikacji do pozostałych — każdy wiersz
// z WŁASNĄ datą/kwotą/symbolem z podpowiedzi pliku.

/** Rodzaje wpisów tworzalne zbiorczo z samych podpowiedzi (data/kwota/symbol/
 * waluta). Transakcje i wymiany walut wymagają danych, których hint nie niesie
 * (ilość/cena, para walut) — te klasyfikuje się pojedynczo. */
const BULK_KINDS = ['dividend', 'deposit', 'cost'] as const;
type BulkKind = (typeof BULK_KINDS)[number];
const isBulkKind = (k: ClassifyKind): k is BulkKind =>
  (BULK_KINDS as readonly string[]).includes(k);

/** Klucz grupowania — identyczny typ z tego samego źródła; wiersze bez rawType
 * nie grupują się (nie ma podstawy do „to samo"). */
function groupKey(row: QuarantineRow): string | null {
  return row.rawType ? `${row.source}|${row.reason}|${row.rawType}` : null;
}

/** Polska liczba mnoga: 1 wiersz / 2 wiersze / 5 wierszy. */
function rowsWord(n: number): string {
  if (n === 1) return 'wiersz';
  const d = n % 10;
  const h = n % 100;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? 'wiersze' : 'wierszy';
}

type CostCategory = (typeof ADD_CATEGORIES)[number];

/** Czy wiersz ma komplet podpowiedzi do zbiorczego utworzenia wpisu danego rodzaju. */
function bulkEligible(row: QuarantineRow, kind: BulkKind): boolean {
  const h = row.hint;
  if (!h?.date || h.amount === undefined) return false;
  if (kind === 'dividend') return Boolean(h.symbol && h.currency);
  return true;
}

/** Tworzy wpis z podpowiedzi wiersza — DOKŁADNIE ta sama semantyka co prefill
 * odpowiedniego dialogu (dywidenda: kwota bez znaku; wpłata: kierunek po znaku;
 * koszt: znak per kategoria jak w AddCostDialog). Zwraca id nowego wpisu. */
async function createEntryFromHint(
  row: QuarantineRow,
  kind: BulkKind,
  costCategory: CostCategory,
): Promise<number> {
  const h = row.hint!;
  if (kind === 'dividend') {
    const res = await api.createDividend({
      date: h.date!,
      ticker: h.symbol!,
      amount: Math.abs(h.amount!),
      currency: h.currency!,
    });
    return res.id;
  }
  if (kind === 'deposit') {
    const res = await api.createDeposit(
      { date: h.date!, amount: Math.abs(h.amount!) },
      h.amount! < 0 ? 'withdrawal' : 'deposit',
    );
    return res.id;
  }
  const raw = h.amount!;
  const abs = Math.abs(raw);
  const signedAmount = raw < 0 ? raw : costCategory.defaultSign === 'negative' ? -abs : abs;
  const res = await api.createAdditionalCost({
    date: h.date!,
    category: costCategory.category,
    subkind: costCategory.subkind,
    amount: signedAmount,
    currency: h.currency,
    description: h.description,
  });
  return res.id;
}

/** Stan otwartej propozycji klasyfikacji zbiorczej (po udanym resolve 1. wiersza). */
interface BulkOffer {
  /** Pozostałe oczekujące wiersze tej samej grupy. */
  rows: QuarantineRow[];
  kind: BulkKind;
  /** Wiersz właśnie sklasyfikowany — po zamknięciu dialogu przechodzi w pętlę nauki. */
  classifiedRow: QuarantineRow;
}

/**
 * Dialog „Zastosuj do pozostałych" — podgląd wierszy grupy z wartościami,
 * które zostaną użyte; dla kosztów dodatkowo wybór kategorii (jak w
 * AddCostDialog). Wykonanie sekwencyjne: utworzenie wpisu → resolve wiersza;
 * błąd jednego wiersza nie przerywa reszty (wiersz zostaje pending).
 */
function BulkApplyDialog({
  offer,
  onClose,
  onFinished,
}: {
  offer: BulkOffer | null;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [categoryValue, setCategoryValue] = useState<string>('fee');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const running = progress !== null;

  const category = ADD_CATEGORIES.find((c) => c.value === categoryValue) ?? ADD_CATEGORIES[0];
  const eligible = offer ? offer.rows.filter((r) => bulkEligible(r, offer.kind)) : [];
  const skippedCount = (offer?.rows.length ?? 0) - eligible.length;
  const kindLabel = offer
    ? (CLASSIFY_OPTIONS.find((o) => o.kind === offer.kind)?.label ?? offer.kind)
    : '';

  const run = async () => {
    if (!offer) return;
    setProgress({ done: 0, total: eligible.length });
    let ok = 0;
    let failed = 0;
    for (const row of eligible) {
      try {
        const refId = await createEntryFromHint(row, offer.kind, category);
        await api.resolveQuarantineRow(row.id, { kind: 'cash_operation', refId });
        ok++;
      } catch {
        // Wiersz zostaje pending — można go sklasyfikować pojedynczo.
        failed++;
      }
      setProgress({ done: ok + failed, total: eligible.length });
    }
    setProgress(null);
    const parts = [`Zastosowano do ${ok} ${rowsWord(ok)}`];
    if (skippedCount > 0) parts.push(`pominięto ${skippedCount} (niekompletne dane)`);
    if (failed > 0) parts.push(`błędy: ${failed}`);
    if (failed > 0) toast.warning(parts.join(', '));
    else toast.success(parts.join(', '));
    onFinished();
    onClose();
  };

  return (
    <Dialog open={offer !== null} onOpenChange={(o) => !o && !running && onClose()}>
      {/* Szerokość z prefiksem sm: (footgun tailwind-merge); min-w-0 dla tabeli. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Zastosować do pozostałych {rowsWord(offer?.rows.length ?? 0)}?</DialogTitle>
          <DialogDescription>
            W skrzynce {offer && offer.rows.length === 1 ? 'został jeszcze' : 'zostały jeszcze'}{' '}
            {offer?.rows.length} {rowsWord(offer?.rows.length ?? 0)} typu{' '}
            <span className="font-mono text-xs">{offer?.classifiedRow.rawType}</span>. Mogę
            sklasyfikować je tak samo ({kindLabel.toLowerCase()}) — każdy wiersz z własną datą,
            kwotą i symbolem z pliku.
          </DialogDescription>
        </DialogHeader>

        {offer && (
          <div className="space-y-3 min-w-0">
            {offer.kind === 'cost' && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Kategoria:</span>
                <Select value={categoryValue} onValueChange={setCategoryValue} disabled={running}>
                  <SelectTrigger size="sm" className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ADD_CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="rounded-md border overflow-x-auto max-h-64 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Data</TableHead>
                    <TableHead className="text-xs text-right">Kwota</TableHead>
                    <TableHead className="text-xs">Symbol</TableHead>
                    <TableHead className="text-xs">Opis</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {offer.rows.map((r) => {
                    const ok = bulkEligible(r, offer.kind);
                    return (
                      <TableRow key={r.id} className={ok ? undefined : 'opacity-50'}>
                        <TableCell className="text-xs whitespace-nowrap">
                          {r.hint?.date ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs text-right whitespace-nowrap font-mono">
                          {r.hint?.amount !== undefined
                            ? formatAmount(r.hint.amount, r.hint.currency)
                            : '—'}
                        </TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {r.hint?.symbol ?? '—'}
                        </TableCell>
                        <TableCell className="text-xs max-w-56 truncate">
                          {ok ? (r.hint?.description ?? '—') : 'pominięty — niekompletne dane'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={running}>
            Nie, tylko ten jeden
          </Button>
          <Button onClick={run} disabled={running || eligible.length === 0}>
            {running && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {progress
              ? `Klasyfikuję… ${progress.done}/${progress.total}`
              : `Zastosuj do ${eligible.length} ${rowsWord(eligible.length)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dialog zgody na zgłoszenie typu do globalnej bazy — pokazuje DOKŁADNIE to,
 * co zostanie wysłane (zredagowana próbka z serwera; kwoty/identyfikatory
 * wrażliwe zamienione na ***). Dwa tryby:
 *  - unsupported: user klika "Zgłoś" na oczekującym wierszu ("nie wiem"),
 *  - classified: proponowany po udanej klasyfikacji (uczy parser na przyszłość).
 */
function ReportConsentDialog({
  row,
  classifiedAs,
  onClose,
  onReported,
}: {
  row: QuarantineRow | null;
  /** Ustawione = tryb 'classified' (po klasyfikacji); brak = 'unsupported'. */
  classifiedAs?: string;
  onClose: () => void;
  onReported: () => void;
}) {
  const [note, setNote] = useState('');

  const { data: preview, isLoading: previewLoading } = useQuery({
    queryKey: ['quarantine-report-preview', row?.id],
    queryFn: () => api.getQuarantineReportPreview(row!.id),
    enabled: row !== null,
  });

  const reportMutation = useMutation({
    mutationFn: () => api.reportQuarantineRow(row!.id, { note: note.trim() || undefined, classifiedAs }),
    onSuccess: () => {
      toast.success('Zgłoszenie wysłane — dziękujemy, to pomaga ulepszać import');
      onReported();
      onClose();
    },
    onError: (err) => errorToast('Nie udało się wysłać zgłoszenia', err),
  });

  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && !reportMutation.isPending && onClose()}>
      {/* Szerokość z prefiksem sm: (footgun tailwind-merge). DialogContent jest
          gridem — treść z szeroką tabelą MUSI mieć min-w-0, inaczej min-content
          tabeli rozpycha dialog poza max-w zamiast przewijać się w kontenerze. */}
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {classifiedAs ? 'Zgłoś typ do ulepszenia importu' : 'Zgłoś nierozpoznany wiersz'}
          </DialogTitle>
          <DialogDescription>
            {classifiedAs
              ? 'Dzięki zgłoszeniu administrator może nauczyć import rozpoznawać ten typ automatycznie — dla Ciebie i innych użytkowników.'
              : 'Zgłoszenie trafi do administratora jako sygnał, że aplikacja może nie obsługiwać tego typu operacji.'}{' '}
            Wysyłane są wyłącznie poniższe, zredagowane dane (numery rachunków, e-maile i
            identyfikatory są maskowane) — nic więcej.
          </DialogDescription>
        </DialogHeader>

        {previewLoading || !preview ? (
          <div className="text-sm text-muted-foreground py-4">Przygotowuję podgląd…</div>
        ) : (
          <div className="space-y-3 min-w-0">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge variant="outline" className="font-mono text-xs">
                {preview.rawType}
              </Badge>
              <span className="text-muted-foreground">broker: {sourceLabel(preview.broker)}</span>
              {classifiedAs && (
                <span className="text-muted-foreground">
                  sklasyfikowano jako:{' '}
                  {CLASSIFY_OPTIONS.find((o) => o.kind === classifiedAs)?.label ?? classifiedAs}
                </span>
              )}
            </div>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {preview.headers.map((h, i) => (
                      <TableHead key={i} className="text-xs whitespace-nowrap">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    {preview.sampleCells.map((c, i) => (
                      <TableCell key={i} className="text-xs font-mono whitespace-nowrap">
                        {c || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableBody>
              </Table>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                Notatka dla administratora (opcjonalnie — np. co ten wiersz oznacza u brokera)
              </label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                rows={2}
                className="mt-1 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={reportMutation.isPending}>
            Nie teraz
          </Button>
          <Button
            onClick={() => reportMutation.mutate()}
            disabled={!preview || reportMutation.isPending}
          >
            {reportMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Wyślij zgłoszenie
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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
  onReport,
}: {
  row: QuarantineRow;
  onClassify: (kind: ClassifyKind) => void;
  onReport: () => void;
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
                {row.status === 'pending' && row.rawType && (
                  <Button variant="outline" size="sm" onClick={onReport} className="text-xs">
                    <Flag className="h-3.5 w-3.5" />
                    Zgłoś
                  </Button>
                )}
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

/**
 * Karta grupy identycznych wierszy (wspólny source/reason/rawType, ≥2 sztuki).
 * Nagłówek z agregatami (liczba, zakres dat, suma przy jednolitej walucie)
 * i akcjami zbiorczymi; wiersze rozwijane na żądanie — każdy zachowuje pełne
 * akcje pojedyncze. „Sklasyfikuj wszystkie" otwiera dialog dla PIERWSZEGO
 * wiersza (weryfikacja/edycja pól), a po zapisie proponuje zastosowanie do
 * reszty (BulkApplyDialog).
 */
function QuarantineGroupCard({
  rows,
  onClassify,
  onReport,
  onIgnoreAll,
  ignoringAll,
}: {
  rows: QuarantineRow[];
  onClassify: (row: QuarantineRow, kind: ClassifyKind) => void;
  onReport: (row: QuarantineRow) => void;
  onIgnoreAll: (rows: QuarantineRow[]) => void;
  ignoringAll: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const first = rows[0];

  const dates = rows
    .map((r) => r.hint?.date)
    .filter((d): d is string => Boolean(d))
    .sort();
  const dateRange =
    dates.length === 0
      ? null
      : dates[0] === dates[dates.length - 1]
        ? dates[0]
        : `${dates[0]} – ${dates[dates.length - 1]}`;
  // Suma tylko przy komplecie kwot w jednej walucie — inaczej myli.
  const currencies = new Set(rows.map((r) => r.hint?.currency).filter(Boolean));
  const amounts = rows.map((r) => r.hint?.amount).filter((a): a is number => a !== undefined);
  const sum =
    currencies.size === 1 && amounts.length === rows.length
      ? amounts.reduce((s, a) => s + a, 0)
      : null;

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          {first.rawType && (
            <Badge variant="outline" className="font-mono text-xs">
              {first.rawType}
            </Badge>
          )}
          <Badge variant="warning">
            {rows.length} {rowsWord(rows.length)}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {sourceLabel(first.source)} · {SKIP_REASON_LABELS[first.reason] ?? first.reason}
          </span>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          {dateRange && (
            <span>
              <span className="text-muted-foreground">Daty: </span>
              {dateRange}
            </span>
          )}
          {sum !== null && (
            <span>
              <span className="text-muted-foreground">Suma: </span>
              {formatAmount(sum, first.hint?.currency)}
            </span>
          )}
        </div>

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
            {expanded ? 'Ukryj wiersze' : `Pokaż wszystkie (${rows.length})`}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="text-xs">
                  <Tag className="h-3.5 w-3.5" />
                  Sklasyfikuj wszystkie
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {CLASSIFY_OPTIONS.map((o) => (
                  <DropdownMenuItem key={o.kind} onSelect={() => onClassify(first, o.kind)}>
                    {o.label}
                    {!isBulkKind(o.kind) && (
                      <span className="text-xs text-muted-foreground">(pojedynczo)</span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onIgnoreAll(rows)}
              disabled={ignoringAll}
              className="text-xs"
            >
              {ignoringAll ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <EyeOff className="h-3.5 w-3.5" />
              )}
              Zignoruj wszystkie
            </Button>
          </div>
        </div>

        {expanded && (
          <div className="space-y-3 border-l-2 border-muted pl-3">
            {rows.map((row) => (
              <QuarantineCard
                key={row.id}
                row={row}
                onClassify={(kind) => onClassify(row, kind)}
                onReport={() => onReport(row)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Sekcja "Do wyjaśnienia" — renderowana na hubie /app/import (dawniej osobna
 * strona /app/import/inbox, ta trasa robi teraz redirect). Self-contained:
 * własne query, mutacje i dialogi klasyfikacji/zgłoszeń.
 */
export function QuarantineSection() {
  const [status, setStatus] = useState<QuarantineStatus>('pending');
  /** Trwający flow klasyfikacji: wiersz + wybrany rodzaj wpisu (otwarty dialog). */
  const [classify, setClassify] = useState<{ row: QuarantineRow; kind: ClassifyKind } | null>(null);
  /** Otwarty dialog zgody na zgłoszenie (classifiedAs = tryb po klasyfikacji). */
  const [reporting, setReporting] = useState<{
    row: QuarantineRow;
    classifiedAs?: ClassifyKind;
  } | null>(null);
  /** Otwarta propozycja zastosowania klasyfikacji do reszty grupy. */
  const [bulkOffer, setBulkOffer] = useState<BulkOffer | null>(null);
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
    mutationFn: (args: {
      row: QuarantineRow;
      classifiedAs: ClassifyKind;
      kind: 'transaction' | 'cash_operation';
      refId?: number;
      /** Pozostałe wiersze tej samej grupy — kandydaci do klasyfikacji zbiorczej. */
      remaining: QuarantineRow[];
    }) => api.resolveQuarantineRow(args.row.id, { kind: args.kind, refId: args.refId }),
    onSuccess: (_, vars) => {
      toast.success('Wiersz rozstrzygnięty — wpis jest już w portfelu');
      invalidate();
      if (isBulkKind(vars.classifiedAs) && vars.remaining.length > 0) {
        // Najpierw propozycja „zastosuj do pozostałych"; pętla nauki (zgłoszenie
        // typu do admina) otworzy się po zamknięciu tego dialogu — closeBulkOffer.
        setBulkOffer({ rows: vars.remaining, kind: vars.classifiedAs, classifiedRow: vars.row });
      } else if (vars.row.rawType) {
        // Pętla nauki: zaproponuj zgłoszenie typu do admina (dialog z podglądem
        // zredagowanych danych — nic nie wychodzi bez jawnego kliknięcia).
        setReporting({ row: vars.row, classifiedAs: vars.classifiedAs });
      }
    },
    onError: (err) =>
      errorToast('Wpis dodany do portfela, ale nie udało się oznaczyć wiersza', err),
  });

  const handleCreated = (kind: 'transaction' | 'cash_operation', refId?: number) => {
    if (!classify) return;
    // Kandydaci do bulk liczeni TERAZ (przed invalidate) z bieżącej listy —
    // pozostałe oczekujące wiersze o tym samym kluczu grupy.
    const key = groupKey(classify.row);
    const remaining = key
      ? (data?.rows ?? []).filter((r) => r.id !== classify.row.id && groupKey(r) === key)
      : [];
    resolveMutation.mutate({ row: classify.row, classifiedAs: classify.kind, kind, refId, remaining });
  };

  /** Zamknięcie dialogu bulk (zastosowano albo „tylko ten jeden") → pętla nauki. */
  const closeBulkOffer = () => {
    const offer = bulkOffer;
    setBulkOffer(null);
    if (offer?.classifiedRow.rawType) {
      setReporting({ row: offer.classifiedRow, classifiedAs: offer.kind });
    }
  };

  // Zbiorcze ignorowanie grupy — sekwencyjnie po istniejącym endpoincie /:id/ignore;
  // błąd w środku pętli zostawia resztę pending (invalidate pokaże stan faktyczny).
  const ignoreAllMutation = useMutation({
    mutationFn: async (rowsToIgnore: QuarantineRow[]) => {
      let ok = 0;
      for (const r of rowsToIgnore) {
        await api.ignoreQuarantineRow(r.id);
        ok++;
      }
      return ok;
    },
    onSuccess: (ok) => {
      toast.success(`Zignorowano ${ok} ${rowsWord(ok)}`);
      invalidate();
    },
    onError: (err) => {
      errorToast('Nie udało się zignorować wszystkich wierszy', err);
      invalidate();
    },
  });

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

  // Grupowanie identycznych typów — tylko zakładka „Oczekujące" (tam są akcje
  // zbiorcze); kolejność pierwszego wystąpienia zachowana, grupy 1-elementowe
  // renderują się jak zwykłe pojedyncze wiersze.
  const items = useMemo(() => {
    const order: Array<{ single: QuarantineRow } | { group: QuarantineRow[] }> = [];
    if (status !== 'pending') {
      return rows.map((row) => ({ single: row }));
    }
    const byKey = new Map<string, QuarantineRow[]>();
    for (const row of rows) {
      const key = groupKey(row);
      if (!key) {
        order.push({ single: row });
        continue;
      }
      const existing = byKey.get(key);
      if (existing) {
        existing.push(row);
        continue;
      }
      const list = [row];
      byKey.set(key, list);
      order.push({ group: list });
    }
    return order;
  }, [rows, status]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Do wyjaśnienia</h2>
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
          {items.map((item) =>
            'single' in item ? (
              <QuarantineCard
                key={item.single.id}
                row={item.single}
                onClassify={(kind) => setClassify({ row: item.single, kind })}
                onReport={() => setReporting({ row: item.single })}
              />
            ) : item.group.length === 1 ? (
              <QuarantineCard
                key={item.group[0].id}
                row={item.group[0]}
                onClassify={(kind) => setClassify({ row: item.group[0], kind })}
                onReport={() => setReporting({ row: item.group[0] })}
              />
            ) : (
              <QuarantineGroupCard
                key={`g-${item.group[0].id}`}
                rows={item.group}
                onClassify={(row, kind) => setClassify({ row, kind })}
                onReport={(row) => setReporting({ row })}
                onIgnoreAll={(groupRows) => ignoreAllMutation.mutate(groupRows)}
                ignoringAll={ignoreAllMutation.isPending}
              />
            ),
          )}
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

      <BulkApplyDialog
        key={`bulk-${bulkOffer?.classifiedRow.id ?? 'none'}`}
        offer={bulkOffer}
        onClose={closeBulkOffer}
        onFinished={invalidate}
      />

      <ReportConsentDialog
        key={`report-${reporting?.row.id ?? 'none'}-${reporting?.classifiedAs ?? ''}`}
        row={reporting?.row ?? null}
        classifiedAs={reporting?.classifiedAs}
        onClose={() => setReporting(null)}
        onReported={invalidate}
      />
    </div>
  );
}
