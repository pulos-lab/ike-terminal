import { useEffect, useState } from 'react';
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
import type { GenericAnalyzeResult, GenericPreviewResult, SkipReason } from 'shared';
import {
  buildProfileFromDraft,
  suggestDraft,
  type ProfileDraft,
} from '@/lib/generic-profile-builder';
import { MappingEditor } from './MappingEditor';
import { PreviewTable } from './PreviewTable';
import { SKIP_REASON_LABELS } from '@/lib/import-labels';

/**
 * Kreator importu uniwersalnego — ścieżka dla plików, których nie rozpoznaje
 * żaden parser wbudowany. Kroki:
 *   1. Analiza (fingerprint + profil z biblioteki / heurystyczny prefill),
 *   2. Mapowanie kolumn (gdy brak profilu w bibliotece) — MappingEditor,
 *   3. Podgląd (OBOWIĄZKOWY — nic nie trafia do bazy przed akceptacją),
 *   4. Import + podsumowanie.
 * Profil z biblioteki (fingerprint exact-match) przeskakuje od razu do podglądu.
 */

type Step = 'analyzing' | 'mapping' | 'previewing' | 'preview' | 'importing' | 'done' | 'blocked';

interface Message {
  kind: 'success' | 'warn' | 'error' | 'info';
  text: string;
}

interface Props {
  file: File | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function GenericImportWizard({ file, open, onOpenChange }: Props) {
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>('analyzing');
  const [analysis, setAnalysis] = useState<GenericAnalyzeResult | null>(null);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  /** Profil użyty w podglądzie — ten sam JSON idzie potem do commita. */
  const [activeProfile, setActiveProfile] = useState<unknown>(null);
  /** Id profilu z biblioteki, jeśli używamy go bez zmian. */
  const [libraryProfileId, setLibraryProfileId] = useState<string | null>(null);
  const [preview, setPreview] = useState<GenericPreviewResult | null>(null);
  const [mappingErrors, setMappingErrors] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  /** Zgoda na wysłanie ZREDAGOWANEJ próbki do usługi AI (wymagana per import). */
  const [aiConsent, setAiConsent] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Analiza przy zamontowaniu — rodzic renderuje kreator warunkowo (remount na
  // każde otwarcie), więc stan startowy zawsze jest świeży i bez resetów w efekcie.
  useEffect(() => {
    if (!open || !file) return;
    let cancelled = false;

    (async () => {
      const result = await api.genericAnalyze(file);
      if (cancelled) return;
      setAnalysis(result);

      if (result.error) {
        setMessages([{ kind: 'error', text: result.error }]);
        setStep('blocked');
        return;
      }
      if (result.known) {
        setMessages([
          {
            kind: 'info',
            text: 'Ten plik obsługuje zwykły import — zamknij kreator i użyj pola „Transakcje" w oknie importu.',
          },
        ]);
        setStep('blocked');
        return;
      }

      if (result.profile) {
        // Format znany bibliotece — od razu podgląd z gotowym profilem.
        setLibraryProfileId(result.profile.summary.id);
        setActiveProfile(result.profile.profileJson);
        await runPreview(file, result.profile.profileJson);
        return;
      }

      // Nieznany format — edytor mapowania z heurystycznym prefillem.
      setDraft(
        suggestDraft(result.headers ?? [], result.sampleRows ?? [], {
          delimiter: result.delimiter ?? ';',
          headerRowIndex: result.headerRowIndex ?? 0,
        }),
      );
      if (result.suggestions?.length) {
        setMessages([
          {
            kind: 'info',
            text:
              `W bibliotece istnieje podobny format (${result.suggestions[0].summary.brokerLabel ?? 'bez nazwy'}, ` +
              `podobieństwo ${Math.round(result.suggestions[0].similarity * 100)}%) — ten plik ma jednak inny układ kolumn, więc wymaga własnego mapowania.`,
          },
        ]);
      }
      setStep('mapping');
    })().catch((err) => {
      if (cancelled) return;
      setMessages([{ kind: 'error', text: `Błąd analizy pliku: ${(err as Error).message}` }]);
      setStep('blocked');
    });

    return () => {
      cancelled = true;
    };
  }, [open, file]);

  // Zwykłe deklaracje funkcji (hoisting) — bez useCallback: kreator nie przekazuje
  // ich do memoizowanych dzieci, a remount przy każdym otwarciu czyści stan.
  async function runPreview(f: File, profile: unknown) {
    setStep('previewing');
    const result = await api.genericPreview(f, profile);
    if (!result.ok) {
      setMappingErrors(result.errors ?? [result.error ?? 'Nieznany błąd podglądu']);
      setStep('mapping');
      return;
    }
    setPreview(result);
    setStep('preview');
  }

  async function handleShowPreview() {
    if (!file || !draft) return;
    setMappingErrors([]);
    const built = buildProfileFromDraft(draft);
    if (!built.ok) {
      setMappingErrors(built.errors ?? []);
      return;
    }
    setLibraryProfileId(null); // profil zbudowany ręcznie — pójdzie inline
    setActiveProfile(built.profile);
    await runPreview(file, built.profile);
  }

  /**
   * Generacja mapowania przez AI — wymaga zaznaczonej zgody. Backend wysyła do
   * usługi AI wyłącznie nagłówki + zredagowaną próbkę (tę samą, którą pokazuje
   * podgląd payloadu poniżej) i zapisuje profil jako 'pending' w bibliotece;
   * import pójdzie po profileId, więc proweniencja (model, pewność) zostaje.
   */
  async function handleGenerateAi() {
    if (!file || !aiConsent || aiBusy) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await api.genericGenerateProfile(file);
      if (result.error || !result.summary) {
        setAiError(result.error ?? 'Nieznany błąd generatora');
        return;
      }
      setLibraryProfileId(result.summary.id);
      setActiveProfile(result.profileJson);
      setMessages([
        {
          kind: 'info',
          text:
            `Mapowanie wygenerowane automatycznie (pewność ${(result.confidence * 100).toFixed(0)}%) — ` +
            'sprawdź podgląd przed importem.',
        },
      ]);
      await runPreview(file, result.profileJson);
    } finally {
      setAiBusy(false);
    }
  }

  async function handleImport() {
    if (!file || !activeProfile) return;
    setStep('importing');
    const result = await api.genericCommit(
      file,
      libraryProfileId ? { profileId: libraryProfileId } : { profile: activeProfile },
    );

    const msgs: Message[] = [];
    if (result.success) {
      const parts: string[] = [];
      if (result.transactionsImported > 0) parts.push(`${result.transactionsImported} transakcji`);
      if (result.operationsImported > 0) parts.push(`${result.operationsImported} operacji`);
      msgs.push({
        kind: 'success',
        text: parts.length > 0 ? `Zaimportowano ${parts.join(' i ')}` : 'Plik przetworzony — brak nowych pozycji',
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
      queryClient.invalidateQueries();
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
          </DialogDescription>
        </DialogHeader>

        {(step === 'analyzing' || step === 'previewing' || step === 'importing') && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {stepLabel[step]}
          </div>
        )}

        {step === 'mapping' && draft && analysis && (
          <div className="space-y-4">
            {libraryProfileNote()}

            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2.5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="h-4 w-4 text-primary" />
                Automatyczne mapowanie (AI)
              </div>
              <p className="text-xs text-muted-foreground">
                Zamiast mapować ręcznie, możesz wygenerować mapowanie automatycznie. Do usługi AI
                (serwer w UE) trafią <span className="font-medium">wyłącznie nazwy kolumn,
                poniższa zredagowana próbka oraz krótkie listy unikalnych wartości kolumn
                (np. typy operacji) — po tej samej redakcji</span> — nigdy cały plik ani dane
                osobowe (numery rachunków, nazwiska i e-maile są maskowane).
              </p>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Zobacz dokładnie, co zostanie wysłane
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">
                  {[
                    (analysis.headers ?? []).join(analysis.delimiter ?? ';'),
                    ...(analysis.sampleRows ?? []).map((r) =>
                      r.join(analysis.delimiter ?? ';'),
                    ),
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
                      Generowanie…
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
            </div>

            <MappingEditor
              draft={draft}
              sampleRows={analysis.sampleRows ?? []}
              onChange={setDraft}
            />
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
              <Button onClick={handleShowPreview}>Pokaż podgląd</Button>
            </div>
          </div>
        )}

        {step === 'preview' && preview && (
          <div className="space-y-4">
            {libraryProfileId && analysis?.profile && (
              <p className="text-xs text-muted-foreground">
                Użyto profilu z biblioteki ({analysis.profile.summary.brokerLabel ?? 'bez nazwy'}
                {analysis.profile.summary.status === 'pending'
                  ? ', oczekuje na zatwierdzenie'
                  : ''}
                ) — sprawdź podgląd i zaimportuj.
              </p>
            )}
            <MessagesList messages={messages} />
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
              <Button variant="outline" onClick={backToMapping}>
                Wróć do mapowania
              </Button>
              <Button
                onClick={handleImport}
                disabled={(preview.transactions?.total ?? 0) + (preview.operations?.total ?? 0) === 0}
              >
                Importuj
              </Button>
            </div>
          </div>
        )}

        {(step === 'done' || step === 'blocked') && (
          <div className="space-y-4">
            <MessagesList messages={messages} />
            <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>
              Zamknij
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );

  function backToMapping() {
    // Powrót z podglądu: profil z biblioteki nie jest edytowalny w formularzu —
    // budujemy draft z heurystyk (użytkownik mapuje od początku, świadomie).
    if (!draft && analysis) {
      setDraft(
        suggestDraft(analysis.headers ?? [], analysis.sampleRows ?? [], {
          delimiter: analysis.delimiter ?? ';',
          headerRowIndex: analysis.headerRowIndex ?? 0,
        }),
      );
    }
    setLibraryProfileId(null);
    setStep('mapping');
  }

  function libraryProfileNote() {
    if (!analysis?.profile) return null;
    return (
      <p className="text-xs text-muted-foreground">
        Edytujesz mapowanie od nowa — poprzedni profil dla tego formatu zostanie zastąpiony nową
        wersją (do zatwierdzenia przez administratora).
      </p>
    );
  }
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
