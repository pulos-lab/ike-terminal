import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, AlertTriangle, CheckCircle, Info, Loader2, Sparkles } from 'lucide-react';
import { api } from '@/lib/api-client';
import type {
  GenericAnalyzeResult,
  GenericPreviewResult,
  GenericSheetAnalysis,
  GenericSheetProfileInput,
  SkipReason,
} from 'shared';
import {
  buildProfileFromDraft,
  suggestDraft,
  type ProfileDraft,
} from '@/lib/generic-profile-builder';
import { MappingEditor } from './MappingEditor';
import { PreviewTable } from './PreviewTable';
import { SKIP_REASON_LABELS } from '@/lib/import-labels';

/**
 * Kreator importu uniwersalnego (CSV lub XLSX). Plik to ZBIÓR TABEL: CSV ma
 * jedną, XLSX ma jedną per arkusz z danymi. Każda tabela dostaje swój profil
 * (z biblioteki / AI / ręcznie); profile gotowe z biblioteki nie wymagają
 * mapowania. Kroki:
 *   1. Analiza (wykrycie arkuszy + profili z biblioteki),
 *   2. Mapowanie kolumn — per tabela, sekwencyjnie (gdy brak profilu),
 *   3. Podgląd (OBOWIĄZKOWY, SCALONY ze wszystkich arkuszy),
 *   4. Import — wszystkie arkusze w jeden atomowy import.
 */

type Step = 'analyzing' | 'mapping' | 'previewing' | 'preview' | 'importing' | 'done' | 'blocked';

interface Message {
  kind: 'success' | 'warn' | 'error' | 'info';
  text: string;
}

/** Jedna tabela do zmapowania + jej rozwiązany profil. */
interface SheetWork {
  analysis: GenericSheetAnalysis;
  /** Rozwiązany profil: z biblioteki (profileId) albo zbudowany (profileJson). */
  resolved?: { profileId?: string; profileJson?: unknown };
}

interface Props {
  file: File | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Z wyniku analyze zbuduj jednolitą listę tabel (CSV → 1 element). */
function toSheetWorks(result: GenericAnalyzeResult): SheetWork[] {
  if (result.format === 'xlsx' && result.sheets) {
    return result.sheets.map((s) => ({ analysis: s, resolved: undefined }));
  }
  // CSV: pola płaskie → jedna tabela bez nazwy arkusza.
  const flat: GenericSheetAnalysis = {
    sheet: undefined,
    fingerprint: result.fingerprint ?? '',
    delimiter: result.delimiter ?? ';',
    headerRowIndex: result.headerRowIndex ?? 0,
    headers: result.headers ?? [],
    sampleRows: result.sampleRows ?? [],
    profile: result.profile,
    suggestions: result.suggestions,
  };
  return [{ analysis: flat, resolved: undefined }];
}

export function GenericImportWizard({ file, open, onOpenChange }: Props) {
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>('analyzing');
  const [sheets, setSheets] = useState<SheetWork[]>([]);
  /** Indeks tabeli aktualnie mapowanej. */
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [preview, setPreview] = useState<GenericPreviewResult | null>(null);
  const [mappingErrors, setMappingErrors] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [skippedSheets, setSkippedSheets] = useState<string[]>([]);
  /** Zgoda na wysłanie ZREDAGOWANEJ próbki do usługi AI (per arkusz). */
  const [aiConsent, setAiConsent] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiElapsed, setAiElapsed] = useState(0);
  const aiTimerRef = useRef<number | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const isXlsx = sheets.length > 1 || sheets.some((s) => s.analysis.sheet !== undefined);
  const current = sheets[cursor];

  // Analiza przy zamontowaniu — rodzic remountuje kreator na każde otwarcie.
  useEffect(() => {
    if (!open || !file) return;
    let cancelled = false;

    (async () => {
      const result = await api.genericAnalyze(file);
      if (cancelled) return;

      if (result.error) {
        setMessages([{ kind: 'error', text: result.error }]);
        setStep('blocked');
        return;
      }
      if (result.known) {
        setMessages([
          {
            kind: 'info',
            text: 'Ten plik obsługuje zwykły import — zamknij kreator i wybierz właściwego brokera w oknie importu.',
          },
        ]);
        setStep('blocked');
        return;
      }

      const works = toSheetWorks(result);
      setSkippedSheets(result.skippedSheets ?? []);
      // Auto-rozwiąż arkusze, które mają profil w bibliotece (exact-match).
      for (const w of works) {
        if (w.analysis.profile) w.resolved = { profileId: w.analysis.profile.summary.id };
      }
      setSheets(works);

      const intro: Message[] = [];
      if (result.format === 'xlsx') {
        intro.push({
          kind: 'info',
          text:
            `Plik XLSX — wykryto ${works.length} ${works.length === 1 ? 'arkusz z danymi' : 'arkusze z danymi'}: ` +
            works.map((w) => `„${w.analysis.sheet}"`).join(', ') +
            '. Zaimportujemy wszystkie.' +
            (result.skippedSheets?.length
              ? ` Pominięto arkusze bez tabeli: ${result.skippedSheets.map((s) => `„${s}"`).join(', ')}.`
              : ''),
        });
      }
      setMessages(intro);
      await proceedFrom(works, 0);
    })().catch((err) => {
      if (cancelled) return;
      setMessages([{ kind: 'error', text: `Błąd analizy pliku: ${(err as Error).message}` }]);
      setStep('blocked');
    });

    return () => {
      cancelled = true;
    };
    // Analiza tylko przy otwarciu/zmianie pliku — proceedFrom celowo poza deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file]);

  /** Znajdź pierwszą nierozwiązaną tabelę od `from`; wejdź w jej mapowanie albo (gdy brak) w podgląd. */
  async function proceedFrom(works: SheetWork[], from: number) {
    const next = works.findIndex((w, i) => i >= from && !w.resolved);
    if (next === -1) {
      await runMergedPreview(works);
      return;
    }
    enterMapping(works, next);
  }

  function enterMapping(works: SheetWork[], idx: number) {
    const a = works[idx].analysis;
    setCursor(idx);
    setDraft(
      suggestDraft(a.headers, a.sampleRows, {
        delimiter: a.delimiter,
        headerRowIndex: a.headerRowIndex,
      }),
    );
    setMappingErrors([]);
    setAiConsent(false);
    setAiError(null);
    setStep('mapping');
  }

  /** Zapisz rozwiązany profil bieżącej tabeli i przejdź dalej (kolejna tabela / podgląd). */
  async function resolveAndAdvance(resolved: { profileId?: string; profileJson?: unknown }) {
    const updated = sheets.map((w, i) => (i === cursor ? { ...w, resolved } : w));
    setSheets(updated);
    await proceedFrom(updated, cursor + 1);
  }

  function handleSheetMapped() {
    if (!file || !draft) return;
    setMappingErrors([]);
    const built = buildProfileFromDraft(draft);
    if (!built.ok) {
      setMappingErrors(built.errors ?? []);
      return;
    }
    void resolveAndAdvance({ profileJson: built.profile });
  }

  /** Generacja mapowania przez AI dla BIEŻĄCEJ tabeli (wymaga zgody). */
  async function handleGenerateAi() {
    if (!file || !aiConsent || aiBusy || !current) return;
    setAiBusy(true);
    setAiError(null);
    setAiElapsed(0);
    const startedAt = Date.now();
    aiTimerRef.current = window.setInterval(
      () => setAiElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    try {
      const result = await api.genericGenerateProfile(file, current.analysis.sheet);
      if (result.error || !result.summary) {
        setAiError(result.error ?? 'Nieznany błąd generatora');
        return;
      }
      setMessages([
        {
          kind: 'info',
          text:
            (current.analysis.sheet ? `Arkusz „${current.analysis.sheet}": ` : '') +
            `mapowanie wygenerowane automatycznie (pewność ${(result.confidence * 100).toFixed(0)}%).`,
        },
      ]);
      await resolveAndAdvance({ profileId: result.summary.id });
    } finally {
      if (aiTimerRef.current !== null) window.clearInterval(aiTimerRef.current);
      aiTimerRef.current = null;
      setAiBusy(false);
    }
  }

  /** Podgląd SCALONY ze wszystkich tabel — CSV przez single-profile, XLSX przez sheets. */
  async function runMergedPreview(works: SheetWork[]) {
    setStep('previewing');
    let result: GenericPreviewResult & { error?: string };
    if (isXlsx) {
      result = await api.genericPreviewSheets(file!, toSheetInputs(works));
    } else {
      const r = works[0].resolved!;
      result = r.profileId
        ? // profil z biblioteki — preview po jego JSON-ie z analizy
          await api.genericPreview(file!, works[0].analysis.profile!.profileJson)
        : await api.genericPreview(file!, r.profileJson);
    }
    if (!result.ok) {
      setMappingErrors(result.errors ?? [result.error ?? 'Nieznany błąd podglądu']);
      // Wróć do mapowania pierwszej tabeli (np. profil z biblioteki nieaktualny).
      enterMapping(works, 0);
      return;
    }
    setPreview(result);
    setStep('preview');
  }

  async function handleImport() {
    if (!file) return;
    setStep('importing');
    const result = isXlsx
      ? await api.genericCommitSheets(file, toSheetInputs(sheets))
      : sheets[0].resolved!.profileId
        ? await api.genericCommit(file, { profileId: sheets[0].resolved!.profileId })
        : await api.genericCommit(file, { profile: sheets[0].resolved!.profileJson });

    const msgs: Message[] = [];
    if (result.success) {
      const parts: string[] = [];
      if (result.transactionsImported > 0) parts.push(`${result.transactionsImported} transakcji`);
      if (result.operationsImported > 0) parts.push(`${result.operationsImported} operacji`);
      msgs.push({
        kind: 'success',
        text:
          parts.length > 0
            ? `Zaimportowano ${parts.join(' i ')}`
            : 'Plik przetworzony — brak nowych pozycji',
      });
      if (result.profileStatus === 'pending') {
        msgs.push({
          kind: 'info',
          text: 'Profil mapowania oczekuje na zatwierdzenie przez administratora — dane są już w portfelu. Kolejne pliki w tym formacie zaimportują się automatycznie.',
        });
      }
      if (result.tickersResolved) {
        msgs.push({ kind: 'info', text: `Rozpoznano ${result.tickersResolved} nowych papierów` });
      }
      if (result.tickersUnresolved?.length) {
        msgs.push({ kind: 'warn', text: `Nie rozpoznano: ${result.tickersUnresolved.join(', ')}` });
      }
      if (result.duplicatesSkipped) {
        msgs.push({ kind: 'warn', text: `Pominięto ${result.duplicatesSkipped} duplikatów` });
      }
      for (const w of result.warnings ?? []) msgs.push({ kind: 'warn', text: w });
      const visibleSkipped = (result.skipped ?? []).filter((s) => s.reason !== 'duplicate');
      if (visibleSkipped.length > 0) {
        const lines = visibleSkipped
          .slice(0, 20)
          .map(
            (s) =>
              `${s.paperName ? `${s.paperName} ` : ''}(wiersz ${s.row}) — ${SKIP_REASON_LABELS[s.reason as SkipReason] ?? s.reason}`,
          );
        msgs.push({
          kind: 'warn',
          text: `Pominięto ${visibleSkipped.length} wierszy:\n${lines.join('\n')}`,
        });
      }
      void queryClient.invalidateQueries();
    } else {
      msgs.push({
        kind: 'error',
        text: `Błąd importu: ${result.errors?.join('; ') || result.error || 'nieznany błąd'}`,
      });
    }
    setMessages(msgs);
    setStep('done');
  }

  const stepLabel: Record<Step, string> = {
    analyzing: 'Analiza pliku…',
    mapping: 'Mapowanie kolumn',
    previewing: 'Generowanie podglądu…',
    preview: 'Podgląd przed importem',
    importing: 'Importowanie…',
    done: 'Wynik importu',
    blocked: 'Analiza pliku',
  };

  return (
    <Dialog open={open} onOpenChange={(v) => onOpenChange(v)}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Import uniwersalny
            <Badge variant="info">beta</Badge>
          </DialogTitle>
          <DialogDescription>
            {file ? `Plik: ${file.name} · ` : ''}
            {stepLabel[step]}
            {step === 'mapping' && isXlsx && current
              ? ` · arkusz ${cursor + 1}/${sheets.length}: „${current.analysis.sheet}"`
              : ''}
          </DialogDescription>
        </DialogHeader>

        {(step === 'analyzing' || step === 'previewing' || step === 'importing') && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {stepLabel[step]}
          </div>
        )}

        {step === 'mapping' && draft && current && (
          <div className="space-y-4">
            {isXlsx && (
              <p className="text-xs text-muted-foreground">
                Mapujesz arkusz <span className="font-medium">„{current.analysis.sheet}"</span> (
                {cursor + 1} z {sheets.length}). Po zmapowaniu przejdziemy do kolejnego, a podgląd
                pokaże dane ze wszystkich arkuszy razem.
              </p>
            )}

            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2.5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-primary" />
                Automatyczne mapowanie (AI)
              </div>
              <p className="text-xs text-muted-foreground">
                Zamiast mapować ręcznie, możesz wygenerować mapowanie automatycznie. Do usługi AI
                (serwer w UE) trafią{' '}
                <span className="font-medium">
                  wyłącznie zredagowane fragmenty {isXlsx ? 'tego arkusza' : 'pliku'}: nazwy kolumn,
                  poniższa próbka, listy unikalnych wartości kolumn (np. typy operacji) oraz
                  pojedyncze wiersze potrzebne do poprawy mapowania — wszystko po tej samej redakcji
                </span>{' '}
                — nigdy cały plik ani dane osobowe (numery rachunków, nazwiska i e-maile są
                maskowane).
              </p>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Zobacz dokładnie, co zostanie wysłane
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">
                  {[
                    current.analysis.headers.join(current.analysis.delimiter),
                    ...current.analysis.sampleRows.map((r) => r.join(current.analysis.delimiter)),
                  ].join('\n')}
                </pre>
              </details>
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={aiConsent}
                  onChange={(e) => setAiConsent(e.target.checked)}
                />
                <span>
                  Zgadzam się na wysłanie powyższej zredagowanej próbki do usługi AI w celu
                  wygenerowania mapowania.
                </span>
              </label>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={!aiConsent || aiBusy}
                  onClick={handleGenerateAi}
                >
                  {aiBusy ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                      Generowanie… {aiElapsed}s
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                      Wygeneruj mapowanie (AI)
                    </>
                  )}
                </Button>
                {aiError && (
                  <span className="text-xs text-warning flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    {aiError}
                  </span>
                )}
              </div>
              {aiBusy && (
                <p className="text-xs text-muted-foreground">
                  AI analizuje strukturę i sprawdza wynik na realnej próbce. Proste formaty zajmują
                  ok. minuty; przy złożonych model dostaje feedback i poprawia mapowanie — to może
                  potrwać do kilku minut. Możesz nie zamykać tego okna i poczekać.
                </p>
              )}
            </div>

            <MappingEditor draft={draft} sampleRows={current.analysis.sampleRows} onChange={setDraft} />
            {mappingErrors.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-1">
                {mappingErrors.map((e, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                    <span>{e}</span>
                  </div>
                ))}
              </div>
            )}
            <MessagesList messages={messages} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Anuluj
              </Button>
              <Button onClick={handleSheetMapped}>
                {isXlsx && cursor < sheets.length - 1 ? 'Dalej (kolejny arkusz)' : 'Pokaż podgląd'}
              </Button>
            </div>
          </div>
        )}

        {step === 'preview' && preview && (
          <div className="space-y-4">
            <MessagesList messages={messages} />
            {preview.sheetSummaries && preview.sheetSummaries.length > 1 && (
              <div className="rounded-md border border-border bg-muted/20 p-2.5 text-xs space-y-1">
                <span className="font-medium">Wkład arkuszy:</span>
                {preview.sheetSummaries.map((s, i) => (
                  <div key={i} className="text-muted-foreground">
                    „{s.sheet}": {s.transactions} transakcji, {s.operations} operacji
                    {s.skipped > 0 ? `, ${s.skipped} pominiętych` : ''}
                  </div>
                ))}
              </div>
            )}
            <PreviewTable result={preview} />
            {(preview.warnings ?? []).length > 0 && (
              <div className="space-y-1">
                {preview.warnings!.slice(0, 10).map((w, i) => (
                  <div key={i} className="flex items-start gap-2 text-xs text-warning">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-between gap-2">
              <Button variant="outline" onClick={() => enterMapping(sheets, 0)}>
                Wróć do mapowania
              </Button>
              <Button
                onClick={handleImport}
                disabled={
                  (preview.transactions?.total ?? 0) + (preview.operations?.total ?? 0) === 0
                }
              >
                Importuj
              </Button>
            </div>
          </div>
        )}

        {(step === 'done' || step === 'blocked') && (
          <div className="space-y-4">
            <MessagesList messages={messages} />
            {skippedSheets.length > 0 && step === 'done' && (
              <p className="text-xs text-muted-foreground">
                Pominięto arkusze bez tabeli danych: {skippedSheets.map((s) => `„${s}"`).join(', ')}.
              </p>
            )}
            <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>
              Zamknij
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** SheetWork[] → wejście dla preview/commit (XLSX). */
function toSheetInputs(works: SheetWork[]): GenericSheetProfileInput[] {
  return works
    .filter((w) => w.resolved)
    .map((w) => ({
      sheet: w.analysis.sheet,
      profileId: w.resolved!.profileId,
      profileJson: w.resolved!.profileJson,
    }));
}

function MessagesList({ messages }: { messages: Message[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="space-y-2">
      {messages.map((m, i) => {
        const isLong = m.text.split('\n').length > 10;
        return (
          <div key={i} className="flex items-start gap-2 text-sm">
            {m.kind === 'error' ? (
              <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            ) : m.kind === 'warn' ? (
              <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            ) : m.kind === 'info' ? (
              <Info className="h-4 w-4 text-info shrink-0 mt-0.5" />
            ) : (
              <CheckCircle className="h-4 w-4 text-success shrink-0 mt-0.5" />
            )}
            <span
              className={[
                'whitespace-pre-line min-w-0',
                isLong ? 'max-h-60 overflow-y-auto pr-2 block' : '',
                m.kind === 'warn' ? 'text-warning' : '',
                m.kind === 'info' ? 'text-info' : '',
                m.kind === 'error' ? 'text-destructive' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {m.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
