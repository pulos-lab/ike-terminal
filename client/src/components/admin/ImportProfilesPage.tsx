import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { AdminProfileSummary, ImportProfileStatus } from 'shared';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/loading-spinner';
import { LintsPanel } from '@/components/import/generic/LintsPanel';

const STATUS_LABELS: Record<ImportProfileStatus, string> = {
  pending: 'Oczekuje',
  approved: 'Zatwierdzony',
  rejected: 'Odrzucony',
  superseded: 'Zastąpiony',
};

const STATUS_BADGE: Record<ImportProfileStatus, string> = {
  pending: 'border-warning/50 text-warning',
  approved: 'border-success/50 text-success',
  rejected: 'border-destructive/50 text-destructive',
  superseded: 'border-border text-muted-foreground',
};

const GENERATED_BY_LABELS: Record<string, string> = {
  llm: 'AI',
  manual: 'Użytkownik',
  admin: 'Admin',
};

const FILTERS: Array<{ value: ImportProfileStatus | 'all'; label: string }> = [
  { value: 'pending', label: 'Oczekujące' },
  { value: 'approved', label: 'Zatwierdzone' },
  { value: 'all', label: 'Wszystkie' },
];

function formatDate(iso: string): string {
  return new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).toLocaleString('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ImportProfilesPage() {
  const [filter, setFilter] = useState<ImportProfileStatus | 'all'>('pending');
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-import-profiles', filter],
    queryFn: () => api.adminListImportProfiles(filter === 'all' ? undefined : filter),
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

  const profiles = data?.profiles ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Profile importu</h1>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={filter === f.value ? 'default' : 'outline'}
              className="h-8 text-xs"
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {banner && (
        <div className="rounded-md bg-success/10 border border-success/20 px-4 py-3 text-sm text-success">
          {banner}
        </div>
      )}

      {!profiles.length ? (
        <EmptyState message="Brak profili w tym widoku. Nowe profile pojawiają się, gdy użytkownicy importują nieznane formaty CSV." />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">Utworzony</TableHead>
                <TableHead>Broker (etykieta)</TableHead>
                <TableHead className="w-[90px]">Wersja</TableHead>
                <TableHead className="w-[110px]">Status</TableHead>
                <TableHead className="w-[150px]">Źródło</TableHead>
                <TableHead className="w-[110px]">Importy</TableHead>
                <TableHead className="w-[100px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map((p) => (
                <ProfileRow key={p.id} profile={p} onReview={() => setReviewId(p.id)} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {reviewId && (
        <ReviewDialog
          profileId={reviewId}
          onClose={() => setReviewId(null)}
          onActionDone={(message) => {
            setBanner(message);
            setReviewId(null);
          }}
        />
      )}
    </div>
  );
}

function ProfileRow({
  profile: p,
  onReview,
}: {
  profile: AdminProfileSummary;
  onReview: () => void;
}) {
  return (
    <TableRow>
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
        {formatDate(p.createdAt)}
      </TableCell>
      <TableCell className="text-sm font-medium">
        {p.brokerLabel || <span className="text-muted-foreground">(bez etykiety)</span>}
        <span className="ml-2 font-mono text-[10px] text-muted-foreground">
          {p.fingerprint.slice(0, 8)}…
        </span>
      </TableCell>
      <TableCell className="text-xs">v{p.version}</TableCell>
      <TableCell>
        <Badge variant="outline" className={`text-xs ${STATUS_BADGE[p.status]}`}>
          {STATUS_LABELS[p.status]}
        </Badge>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {GENERATED_BY_LABELS[p.generatedBy] ?? p.generatedBy}
        {p.llmModel && (
          <span className="block text-[10px]">
            {p.llmModel}
            {p.llmConfidence != null && ` · pewność ${(p.llmConfidence * 100).toFixed(0)}%`}
          </span>
        )}
      </TableCell>
      <TableCell className="text-xs">
        {p.batchCount}
        {p.needsReimportCount > 0 && (
          <span className="ml-1 text-warning">({p.needsReimportCount} do re-importu)</span>
        )}
      </TableCell>
      <TableCell>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onReview}>
          Przejrzyj
        </Button>
      </TableCell>
    </TableRow>
  );
}

function ReviewDialog({
  profileId,
  onClose,
  onActionDone,
}: {
  profileId: string;
  onClose: () => void;
  onActionDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [editedJson, setEditedJson] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-import-profile', profileId],
    queryFn: () => api.adminGetImportProfile(profileId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-import-profiles'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-import-profile', profileId] });
  };

  const approve = useMutation({
    mutationFn: () => api.adminApproveImportProfile(profileId, note.trim() || undefined),
    onSuccess: (r) => {
      invalidate();
      onActionDone(
        r.flaggedBatches > 0
          ? `Profil zatwierdzony. Oznaczono ${r.flaggedBatches} importów do ponownego przetworzenia.`
          : 'Profil zatwierdzony.',
      );
    },
  });

  const reject = useMutation({
    mutationFn: () => api.adminRejectImportProfile(profileId, note.trim() || undefined),
    onSuccess: () => {
      invalidate();
      onActionDone('Profil odrzucony.');
    },
  });

  const saveEdit = useMutation({
    mutationFn: (profile: unknown) => api.adminUpdateImportProfile(profileId, profile),
    onSuccess: (r) => {
      invalidate();
      onActionDone(`Zapisano korektę jako nową wersję v${r.profile.version} (oczekuje).`);
    },
    onError: (err) => setEditError(err instanceof Error ? err.message : 'Błąd zapisu'),
  });

  const p = data?.profile;
  const profileJson = editedJson ?? (p ? JSON.stringify(p.profile, null, 2) : '');

  const handleSaveEdit = () => {
    setEditError(null);
    try {
      saveEdit.mutate(JSON.parse(profileJson));
    } catch {
      setEditError('To nie jest poprawny JSON.');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Review profilu {p?.brokerLabel ? `„${p.brokerLabel}"` : ''} v{p?.version ?? '…'}
          </DialogTitle>
          <DialogDescription>
            Próbka jest zredagowana (bez danych osobowych). Zatwierdzenie nowej wersji oznaczy
            wcześniejsze importy tego formatu do ponownego przetworzenia.
          </DialogDescription>
        </DialogHeader>

        {isLoading || !data || !p ? (
          <div className="text-sm text-muted-foreground py-8">Ładowanie...</div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                Status: <b className="text-foreground">{STATUS_LABELS[p.status]}</b>
              </span>
              <span className="text-muted-foreground">
                Źródło:{' '}
                <b className="text-foreground">
                  {GENERATED_BY_LABELS[p.generatedBy] ?? p.generatedBy}
                  {p.llmModel ? ` (${p.llmModel})` : ''}
                </b>
              </span>
              <span className="text-muted-foreground">
                Fingerprint: <span className="font-mono">{p.fingerprint.slice(0, 16)}…</span>
              </span>
              <span className="text-muted-foreground">
                Importy: <b className="text-foreground">{p.batchCount}</b>
                {p.needsReimportCount > 0 && ` (${p.needsReimportCount} do re-importu)`}
              </span>
              {p.reviewNote && (
                <span className="col-span-2 text-muted-foreground">Nota: {p.reviewNote}</span>
              )}
            </div>

            {data.diff && data.diff.changedSections.length > 0 && (
              <div className="rounded-md border border-info/30 bg-info/5 px-3 py-2 text-xs">
                Zmiany względem zatwierdzonej v{data.diff.againstVersion}:{' '}
                {data.diff.changedSections.map((s) => (
                  <Badge key={s} variant="outline" className="ml-1 text-[10px]">
                    {s}
                  </Badge>
                ))}
              </div>
            )}

            {p.sampleRows && (
              <details open>
                <summary className="cursor-pointer text-xs font-semibold">
                  Zredagowana próbka ({p.sampleRows.length} wierszy)
                </summary>
                <pre className="mt-2 max-h-44 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">
                  {[
                    p.headerNames.join(p.delimiter),
                    ...p.sampleRows.map((r) => r.join(p.delimiter)),
                  ].join('\n')}
                </pre>
              </details>
            )}

            {data.dryRun && (
              <div className="rounded-md border px-3 py-2 text-xs">
                <span className="font-semibold">Dry-run na próbce: </span>
                {data.dryRun.ok ? (
                  <>
                    transakcje {data.dryRun.transactions?.total ?? 0}, operacje{' '}
                    {data.dryRun.operations?.total ?? 0}, pominięte{' '}
                    {(data.dryRun.transactions?.skipped.length ?? 0) +
                      (data.dryRun.operations?.skipped.length ?? 0)}
                  </>
                ) : (
                  <span className="text-destructive">
                    profil nie wykonał się: {data.dryRun.errors?.join('; ')}
                  </span>
                )}
              </div>
            )}

            {data.dryRun?.ok && <LintsPanel lints={data.dryRun.lints} />}

            <details>
              <summary className="cursor-pointer text-xs font-semibold">
                Profil (JSON) — edytuj, aby zapisać korektę jako nową wersję
              </summary>
              <textarea
                className="mt-2 w-full h-64 rounded border bg-background p-2 font-mono text-[11px] leading-relaxed"
                value={profileJson}
                onChange={(e) => setEditedJson(e.target.value)}
                spellCheck={false}
              />
              {editError && <p className="mt-1 text-xs text-destructive">{editError}</p>}
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-8 text-xs"
                disabled={editedJson === null || saveEdit.isPending}
                onClick={handleSaveEdit}
              >
                {saveEdit.isPending ? 'Zapisywanie…' : 'Zapisz korektę (nowa wersja pending)'}
              </Button>
            </details>

            {data.audit.length > 0 && (
              <details>
                <summary className="cursor-pointer text-xs font-semibold">
                  Historia ({data.audit.length})
                </summary>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {data.audit.map((a) => (
                    <li key={a.id}>
                      {formatDate(a.createdAt)} — {a.action}
                      {a.diff != null && (
                        <span className="font-mono text-[10px]"> {JSON.stringify(a.diff)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {p.status === 'pending' && (
              <div className="flex items-end gap-2 border-t pt-3">
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground">Nota (opcjonalna)</label>
                  <Input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="np. poprawiono mapowanie waluty"
                    className="h-8 text-xs"
                  />
                </div>
                <Button
                  size="sm"
                  className="h-8 text-xs"
                  disabled={approve.isPending || reject.isPending}
                  onClick={() => approve.mutate()}
                >
                  {approve.isPending ? 'Zatwierdzanie…' : 'Zatwierdź'}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-8 text-xs"
                  disabled={approve.isPending || reject.isPending}
                  onClick={() => reject.mutate()}
                >
                  Odrzuć
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
