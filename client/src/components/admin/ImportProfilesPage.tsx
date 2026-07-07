import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api-client';
import type {
  AdminProfileSummary,
  ImportProfile,
  ImportProfileStatus,
  RowClass,
  RowTrace,
} from 'shared';
import {
  appendClassifyRule,
  buildClassBreakdown,
  buildMappingTables,
  buildSkipGroups,
  inferDiscriminatorCol,
  mappedClasses,
  rowAnnotations,
  unhandledDiscriminatorValues,
  type FieldStatus,
} from '@/lib/admin-review';
import {
  ROW_CLASS_LABELS,
  buildProfileFromDraft,
  draftFromProfile,
  type ProfileDraft,
} from '@/lib/generic-profile-builder';
import { MappingEditor } from '@/components/import/generic/MappingEditor';
import { SKIP_REASON_LABELS } from '@/lib/import-labels';
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
          onSwitchVersion={(newId) => setReviewId(newId)}
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
  onSwitchVersion,
}: {
  profileId: string;
  onClose: () => void;
  onActionDone: (message: string) => void;
  onSwitchVersion: (newId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [editedJson, setEditedJson] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<'visual' | 'json'>('visual');
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  const [copiedSample, setCopiedSample] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

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
      setEditedJson(null);
      setEditError(null);
      setSavedMsg(`Zapisano jako nową wersję v${r.profile.version} — przeglądasz ją poniżej.`);
      setTimeout(() => setSavedMsg(null), 5000);
      // Dialog zostaje OTWARTY i przełącza się na nową wersję (świeży dry-run),
      // żeby admin mógł iterować (kolejna reguła) i na końcu zatwierdzić.
      onSwitchVersion(r.profile.id);
    },
    onError: (err) => setEditError(err instanceof Error ? err.message : 'Błąd zapisu'),
  });

  const p = data?.profile;
  const profileJson = editedJson ?? (p ? JSON.stringify(p.profile, null, 2) : '');
  // Klasa per wiersz próbki (zip pozycyjny) — do kolumny „Typ" + wyróżnienia skipów.
  const sampleAnnos = data?.dryRun?.ok ? rowAnnotations(data.dryRun.rowTraces ?? []) : [];

  // Reverse-map: profil → draft formularza (gdy się da). Profile zbyt złożone
  // (regex/oneOf) → ok:false → wymuszamy edytor JSON. Przy zmianie wersji (Fix 2)
  // p się zmienia → draft i tryb przeliczają się od nowa.
  const reverse = useMemo(
    () =>
      p
        ? draftFromProfile(p.profile, {
            headers: p.headerNames,
            delimiter: p.delimiter,
            headerRowIndex: 0,
          })
        : null,
    [p],
  );
  useEffect(() => {
    setDraft(reverse?.ok ? (reverse.draft ?? null) : null);
    setEditMode(reverse?.ok ? 'visual' : 'json');
    setDraftErrors([]);
  }, [reverse]);

  const handleSaveEdit = () => {
    setEditError(null);
    try {
      saveEdit.mutate(JSON.parse(profileJson));
    } catch (err) {
      // Komunikat parsera wskazuje pozycję błędu — bez niego szukanie literówki
      // w długim profilu to zgadywanka.
      setEditError(`To nie jest poprawny JSON: ${(err as Error).message}`);
    }
  };

  const handleSaveVisual = () => {
    if (!draft) return;
    setDraftErrors([]);
    const built = buildProfileFromDraft(draft);
    if (!built.ok) {
      setDraftErrors(built.errors ?? ['Nie udało się zbudować profilu.']);
      return;
    }
    saveEdit.mutate(built.profile);
  };

  const jumpToEditor = () => {
    setEditMode('json');
    setTimeout(
      () => editorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }),
      0,
    );
  };

  const copySampleCsv = () => {
    if (!p?.sampleRows) return;
    const csv = [
      p.headerNames.join(p.delimiter),
      ...p.sampleRows.map((r) => r.join(p.delimiter)),
    ].join('\n');
    void navigator.clipboard?.writeText(csv);
    setCopiedSample(true);
    setTimeout(() => setCopiedSample(false), 1500);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[95vw] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Review profilu {p?.brokerLabel ? `„${p.brokerLabel}"` : ''} v{p?.version ?? '…'}
          </DialogTitle>
          <DialogDescription>
            Próbka jest zredagowana (bez danych osobowych). Zatwierdzenie nowej wersji oznaczy
            wcześniejsze importy tego formatu do ponownego przetworzenia.
          </DialogDescription>
        </DialogHeader>

        {savedMsg && (
          <div className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs text-success">
            {savedMsg}
          </div>
        )}

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
                <div className="mt-2">
                  <div className="mb-1 flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[11px]"
                      onClick={copySampleCsv}
                    >
                      {copiedSample ? 'Skopiowano ✓' : 'Kopiuj surowy CSV'}
                    </Button>
                  </div>
                  <div className="max-h-56 overflow-auto rounded border">
                    <table className="w-full border-collapse font-mono text-[10px]">
                      <thead className="sticky top-0 bg-muted">
                        <tr>
                          <th className="border-b border-border px-1.5 py-1 text-right font-normal text-muted-foreground">
                            #
                          </th>
                          <th className="whitespace-nowrap border-b border-l border-border px-2 py-1 text-left font-semibold">
                            Typ
                          </th>
                          {p.headerNames.map((h, i) => (
                            <th
                              key={i}
                              className="whitespace-nowrap border-b border-l border-border px-2 py-1 text-left font-semibold"
                            >
                              {h || `(kol. ${i + 1})`}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {p.sampleRows.map((row, ri) => {
                          const anno = sampleAnnos[ri];
                          return (
                            <tr
                              key={ri}
                              className={`odd:bg-muted/30${anno?.isSkip ? ' text-muted-foreground' : ''}`}
                            >
                              <td className="px-1.5 py-0.5 text-right text-muted-foreground">
                                {ri + 1}
                              </td>
                              <td className="whitespace-nowrap border-l border-border/50 px-2 py-0.5">
                                {anno?.isSkip ? (
                                  <span className="text-warning">
                                    pominięto
                                    {anno.skipReason
                                      ? `: ${SKIP_REASON_LABELS[anno.skipReason]}`
                                      : ''}
                                  </span>
                                ) : (
                                  (anno?.label ?? '')
                                )}
                              </td>
                              {p.headerNames.map((_, ci) => (
                                <td
                                  key={ci}
                                  className="whitespace-nowrap border-l border-border/50 px-2 py-0.5"
                                >
                                  {row[ci] ?? ''}
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
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

            {data.dryRun?.ok && data.dryRun.rowTraces && data.dryRun.rowTraces.length > 0 && (
              <MappingReview
                profile={p.profile as ImportProfile}
                headerNames={p.headerNames}
                sampleRows={p.sampleRows ?? []}
                rowTraces={data.dryRun.rowTraces}
              />
            )}

            {data.dryRun?.ok && <LintsPanel lints={data.dryRun.lints} />}

            {data.dryRun?.ok && data.dryRun.rowTraces && data.dryRun.rowTraces.length > 0 && (
              <SkipActions
                profile={p.profile as ImportProfile}
                headerNames={p.headerNames}
                sampleRows={p.sampleRows ?? []}
                rowTraces={data.dryRun.rowTraces}
                busy={saveEdit.isPending}
                onApply={(next) => saveEdit.mutate(next)}
                onJumpToEditor={jumpToEditor}
              />
            )}

            <div ref={editorRef} className="rounded-md border p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-semibold">Popraw mapowanie</span>
                <div className="ml-auto flex gap-1">
                  <Button
                    size="sm"
                    variant={editMode === 'visual' ? 'default' : 'outline'}
                    className="h-6 text-[11px]"
                    disabled={!reverse?.ok}
                    onClick={() => setEditMode('visual')}
                  >
                    Wizualnie
                  </Button>
                  <Button
                    size="sm"
                    variant={editMode === 'json' ? 'default' : 'outline'}
                    className="h-6 text-[11px]"
                    onClick={() => setEditMode('json')}
                  >
                    JSON
                  </Button>
                </div>
              </div>

              {reverse && !reverse.ok && (
                <p className="mb-2 text-xs text-warning">
                  Tego profilu nie da się edytować wizualnie
                  {reverse.reason ? ` (${reverse.reason})` : ''} — użyj edytora JSON.
                </p>
              )}
              {editMode === 'visual' && reverse?.ok && reverse.lossy.length > 0 && (
                <div className="mb-2 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
                  <p>
                    Edytor wizualny nie pokazuje niektórych elementów profilu — po zapisie wizualnym{' '}
                    <strong>przepadną</strong>: {reverse.lossy.join(', ')}. Jeśli chcesz je
                    zachować, edytuj w JSON.
                  </p>
                </div>
              )}

              {editMode === 'visual' && draft ? (
                <>
                  <MappingEditor
                    draft={draft}
                    sampleRows={p.sampleRows ?? []}
                    onChange={setDraft}
                  />
                  {draftErrors.length > 0 && (
                    <ul className="mt-2 list-disc pl-4 text-xs text-destructive">
                      {draftErrors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 h-8 text-xs"
                    disabled={saveEdit.isPending}
                    onClick={handleSaveVisual}
                  >
                    {saveEdit.isPending ? 'Zapisywanie…' : 'Zapisz korektę (nowa wersja pending)'}
                  </Button>
                </>
              ) : (
                <>
                  <textarea
                    className="w-full h-64 rounded border bg-background p-2 font-mono text-[11px] leading-relaxed"
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
                </>
              )}
            </div>

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

const STATUS_ICON: Record<FieldStatus, { sym: string; cls: string; title: string }> = {
  ok: { sym: '✓', cls: 'text-success', title: 'OK' },
  uncertain: { sym: '⚠', cls: 'text-warning', title: 'do sprawdzenia' },
  missing: { sym: '✗', cls: 'text-destructive', title: 'brak mapowania' },
};

/** Rozbicie klasyfikacji + tabela kolumna→pole — z `rowTraces` i JSON-a profilu. */
function MappingReview({
  profile,
  headerNames,
  sampleRows,
  rowTraces,
}: {
  profile: ImportProfile;
  headerNames: string[];
  sampleRows: string[][];
  rowTraces: RowTrace[];
}) {
  const breakdown = buildClassBreakdown(rowTraces);
  const tables = buildMappingTables(profile, headerNames, sampleRows, rowTraces);

  return (
    <div className="space-y-3">
      <div>
        <p className="mb-1 text-xs font-semibold">Rozpoznane typy wierszy</p>
        <div className="flex flex-wrap gap-1.5">
          {breakdown.map((c) => (
            <Badge
              key={c.emitted}
              variant={
                c.target === 'transaction'
                  ? 'info'
                  : c.target === 'operation'
                    ? 'success'
                    : 'warning'
              }
              className="text-[10px]"
            >
              {c.label} ×{c.count}
            </Badge>
          ))}
        </div>
      </div>

      {tables.map((t) => (
        <details key={t.emitted} open className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold">Mapowanie: {t.label}</summary>
          {/* Bez w-full: tabela dopasowuje się do treści (inaczej przy szerokim oknie
              kolumny rozjeżdżają się i powstaje pusta przerwa „Źródło"↔„Przykłady"). */}
          <table className="mt-2 text-[11px]">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="pr-2 font-medium">Pole</th>
                <th className="pr-2 font-medium">Źródło</th>
                <th className="pr-2 font-medium">Przykłady (z próbki)</th>
                <th className="w-6 font-medium" />
              </tr>
            </thead>
            <tbody>
              {t.fields.map((f) => (
                <tr key={f.field} className="border-t border-border/50 align-top">
                  <td className="py-1 pr-2 font-medium">{f.field}</td>
                  <td className="py-1 pr-2 text-muted-foreground">{f.source}</td>
                  <td className="py-1 pr-2 font-mono text-[10px] text-muted-foreground">
                    {f.examples.join(', ') || '—'}
                  </td>
                  <td className={`py-1 text-center ${STATUS_ICON[f.status].cls}`}>
                    <span title={STATUS_ICON[f.status].title}>{STATUS_ICON[f.status].sym}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}
    </div>
  );
}

const SKIP_BADGE: Record<'unknown' | 'mapping' | 'gentle', 'info' | 'warning' | 'muted'> = {
  unknown: 'info',
  mapping: 'warning',
  gentle: 'muted',
};

/** Pominięte wiersze pogrupowane po powodzie + jednoklik / skok do edytora. */
function SkipActions({
  profile,
  headerNames,
  sampleRows,
  rowTraces,
  busy,
  onApply,
  onJumpToEditor,
}: {
  profile: ImportProfile;
  headerNames: string[];
  sampleRows: string[][];
  rowTraces: RowTrace[];
  busy: boolean;
  onApply: (next: ImportProfile) => void;
  onJumpToEditor: () => void;
}) {
  const groups = buildSkipGroups(rowTraces);
  const discr = inferDiscriminatorCol(profile);
  const unhandled = unhandledDiscriminatorValues(profile, headerNames, sampleRows);
  const classes = mappedClasses(profile);
  const [emit, setEmit] = useState<RowClass>(classes[0] ?? 'other');
  const canAddRule = discr != null && unhandled.length > 0 && classes.length > 0;

  if (groups.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md border px-3 py-2">
      <p className="text-xs font-semibold">Pominięte wiersze — jak je obsłużyć</p>
      {groups.map((g) => (
        <div
          key={g.reason}
          className="border-t border-border/50 pt-2 text-xs first:border-0 first:pt-0"
        >
          <Badge variant={SKIP_BADGE[g.category]} className="text-[10px]">
            {SKIP_REASON_LABELS[g.reason]} ×{g.count}
          </Badge>

          {g.category === 'gentle' && (
            <p className="mt-1 text-muted-foreground">
              Celowo pomijane — profil działa zgodnie z zamierzeniem.
            </p>
          )}

          {g.category === 'mapping' && (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">Prawdopodobnie złe mapowanie kolumny.</span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[11px]"
                onClick={onJumpToEditor}
              >
                Popraw w edytorze
              </Button>
            </div>
          )}

          {g.category === 'unknown' &&
            (canAddRule ? (
              <div className="mt-1 space-y-1">
                <p className="text-muted-foreground">
                  Nierozpoznane wartości:{' '}
                  <span className="font-mono">
                    {unhandled.slice(0, 5).join(', ')}
                    {unhandled.length > 5 ? '…' : ''}
                  </span>
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted-foreground">To jest:</span>
                  <select
                    value={emit}
                    onChange={(e) => setEmit(e.target.value as RowClass)}
                    className="h-6 rounded border bg-background px-1 text-[11px]"
                  >
                    {classes.map((c) => (
                      <option key={c} value={c}>
                        {ROW_CLASS_LABELS[c]}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[11px]"
                    disabled={busy}
                    onClick={() =>
                      onApply(appendClassifyRule(profile, { col: discr, values: unhandled, emit }))
                    }
                  >
                    Dodaj regułę
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-[11px]"
                    disabled={busy}
                    onClick={() =>
                      onApply(
                        appendClassifyRule(profile, {
                          col: discr,
                          values: unhandled,
                          emit: 'skip',
                          skipReason: 'summary_row',
                        }),
                      )
                    }
                  >
                    Oznacz jako pominięcie
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">Nierozpoznane wiersze.</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[11px]"
                  onClick={onJumpToEditor}
                >
                  Popraw w edytorze
                </Button>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
