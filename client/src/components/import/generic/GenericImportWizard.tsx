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
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle,
  Info,
  Library,
  Loader2,
  Sparkles,
} from 'lucide-react';
import { api } from '@/lib/api-client';
import type {
  GenericAnalyzeResult,
  GenericPreviewResult,
  GenericSheetAnalysis,
  GenericSheetProfileInput,
  SkipReason,
} from 'shared';
import { BROKER_LABELS } from 'shared';
import {
  adoptProfileForDocument,
  buildProfileFromDraft,
  suggestDraft,
  type ProfileDraft,
} from '@/lib/generic-profile-builder';
import { MappingEditor } from './MappingEditor';
import { PreviewTable } from './PreviewTable';
import { SKIP_REASON_LABELS } from '@/lib/import-labels';
import { isKnownBroker, type FileRole, type KnownBroker } from '../broker-import-config';

/**
 * Kreator importu uniwersalnego (CSV/XLSX, JEDEN lub WIELE plików). Każdy plik to
 * ZBIÓR TABEL: CSV ma jedną, XLSX ma jedną per arkusz z danymi. Każda tabela (z
 * dowolnego pliku) dostaje swój profil (z biblioteki / AI / ręcznie); profile
 * gotowe z biblioteki nie wymagają mapowania. Rola wynika z profilu (classify),
 * więc nie ma slotów transakcje/operacje. Kroki:
 *   1. Analiza (wykrycie tabel ze wszystkich plików + profili z biblioteki),
 *   2. Mapowanie kolumn — per tabela, sekwencyjnie (gdy brak profilu),
 *   3. Podgląd (OBOWIĄZKOWY, SCALONY ze wszystkich tabel),
 *   4. Import — wszystkie tabele w jeden atomowy import.
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
  files: File[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Wykryto format obsługiwany przez parser wbudowany (jeden plik). Rodzic
   * przejmuje sterowanie: przełącza na kafel brokera i uruchamia import wbudowany.
   * Brak handlera → fallback do komunikatu „użyj kafla brokera".
   */
  onKnownBroker?: (broker: KnownBroker, fileRole: FileRole, files: File[]) => void;
}

/** Z wyniku analyze zbuduj jednolitą listę tabel (multi-plik → `documents`). */
function toSheetWorks(result: GenericAnalyzeResult): SheetWork[] {
  if (result.documents) {
    return result.documents.map((d) => ({ analysis: d, resolved: undefined }));
  }
  // Legacy (pojedynczy plik): XLSX → arkusze, CSV → pola płaskie.
  if (result.format === 'xlsx' && result.sheets) {
    return result.sheets.map((s) => ({ analysis: s, resolved: undefined }));
  }
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

/** Etykieta tabeli: nazwa arkusza (XLSX) albo nazwa pliku (multi-plik CSV). */
const docLabel = (a: GenericSheetAnalysis): string => a.sheet ?? a.file ?? '';

export function GenericImportWizard({ files, open, onOpenChange, onKnownBroker }: Props) {
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>('analyzing');
  const [sheets, setSheets] = useState<SheetWork[]>([]);
  /** Indeks tabeli aktualnie mapowanej. */
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [preview, setPreview] = useState<GenericPreviewResult | null>(null);
  const [mappingErrors, setMappingErrors] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [skippedLabels, setSkippedLabels] = useState<string[]>([]);
  /** Zgoda na wysłanie ZREDAGOWANEJ próbki do usługi AI (per tabela). */
  const [aiConsent, setAiConsent] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiElapsed, setAiElapsed] = useState(0);
  const aiTimerRef = useRef<number | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  /** >1 tabela → pokazuj UI per tabela (numerację, „kolejna tabela", wkład tabel). */
  const multiDoc = sheets.length > 1;
  const current = sheets[cursor];
  const filesLabel = files.length === 1 ? (files[0]?.name ?? '') : `${files.length} plików`;

  /** Plik źródłowy danej tabeli (po nazwie); fallback do pierwszego (legacy 1-plik). */
  const fileForAnalysis = (a: GenericSheetAnalysis): File | undefined =>
    files.find((f) => f.name === a.file) ?? files[0];

  // Analiza przy zamontowaniu — rodzic remountuje kreator na każde otwarcie.
  useEffect(() => {
    if (!open || files.length === 0) return;
    let cancelled = false;

    (async () => {
      const result = await api.genericAnalyze(files);
      if (cancelled) return;

      if (result.error) {
        setMessages([{ kind: 'error', text: result.error }]);
        setStep('blocked');
        return;
      }
      if (result.known) {
        // Znany format (jeden plik) → oddaj sterowanie rodzicowi: nazwie brokera
        // i od razu uruchomi import wbudowany (dla formatów jednoplikowych).
        if (result.broker && isKnownBroker(result.broker) && onKnownBroker) {
          onKnownBroker(
            result.broker,
            result.fileRole === 'operations' ? 'operations' : 'transactions',
            files,
          );
          return;
        }
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
      // Auto-rozwiąż tabele, które mają profil w bibliotece (exact-match fingerprint).
      for (const w of works) {
        if (w.analysis.profile) w.resolved = { profileId: w.analysis.profile.summary.id };
      }
      setSheets(works);

      const skipped = [
        ...(result.skippedDocuments ?? []).map((d) => d.sheet ?? d.file),
        ...(result.skippedSheets ?? []),
      ];
      setSkippedLabels(skipped);

      const intro: Message[] = [];
      if (result.knownFiles?.length) {
        intro.push({
          kind: 'warn',
          text:
            'Pliki obsługiwane przez import wbudowany — zaimportuj je przez właściwy kafel brokera: ' +
            result.knownFiles.map((k) => `„${k.file}" (${BROKER_LABELS[k.broker]})`).join(', ') +
            '.',
        });
      }
      if (works.length === 0) {
        setMessages(
          intro.length > 0
            ? intro
            : [{ kind: 'error', text: 'Nie znaleziono tabeli danych w przesłanych plikach.' }],
        );
        setStep('blocked');
        return;
      }
      if (works.length > 1) {
        intro.push({
          kind: 'info',
          text: `Wykryto ${works.length} tabel — zaimportujemy je w jeden import.`,
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
    // Analiza tylko przy otwarciu/zmianie plików — proceedFrom celowo poza deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, files]);

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
    if (files.length === 0 || !draft) return;
    setMappingErrors([]);
    const built = buildProfileFromDraft(draft);
    if (!built.ok) {
      setMappingErrors(built.errors ?? []);
      return;
    }
    void resolveAndAdvance({ profileJson: built.profile });
  }

  /** Adoptuj podobny profil z biblioteki dla bieżącej tabeli (P1 — bez generacji AI). */
  function handleUseSuggestion(
    suggestion: NonNullable<GenericSheetAnalysis['suggestions']>[number],
  ) {
    if (!current) return;
    setMappingErrors([]);
    const adopted = adoptProfileForDocument(suggestion.profileJson, {
      delimiter: current.analysis.delimiter,
      sheet: current.analysis.sheet,
    });
    void resolveAndAdvance({ profileJson: adopted });
  }

  /** Generacja mapowania przez AI dla BIEŻĄCEJ tabeli (wymaga zgody). */
  async function handleGenerateAi() {
    if (!aiConsent || aiBusy || !current) return;
    const f = fileForAnalysis(current.analysis);
    if (!f) return;
    setAiBusy(true);
    setAiError(null);
    setAiElapsed(0);
    const startedAt = Date.now();
    aiTimerRef.current = window.setInterval(
      () => setAiElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    try {
      const result = await api.genericGenerateProfile(f, current.analysis.sheet);
      if (result.error || !result.summary) {
        setAiError(result.error ?? 'Nieznany błąd generatora');
        return;
      }
      setMessages([
        {
          kind: 'info',
          text:
            (multiDoc ? `Tabela „${docLabel(current.analysis)}": ` : '') +
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

  /** Podgląd SCALONY ze wszystkich tabel/plików (profil per tabela). */
  async function runMergedPreview(works: SheetWork[]) {
    setStep('previewing');
    const result = await api.genericPreviewDocuments(files, toSheetInputs(works));
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
    if (files.length === 0) return;
    setStep('importing');
    const result = await api.genericCommitDocuments(files, toSheetInputs(sheets));

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
      {/*
       * Szerokość przez wariant `sm:` — bez prefiksu tailwind-merge NIE usuwa
       * domyślnego `sm:max-w-lg` z DialogContent (inny wariant = brak konfliktu),
       * więc na desktopie wygrywało 512px i podgląd (7 kolumn) przewijał się w poziomie.
       * Krok podglądu dostaje więcej miejsca niż formularz mapowania.
       */}
      <DialogContent
        className={`${step === 'preview' ? 'sm:max-w-4xl' : 'sm:max-w-3xl'} max-h-[88vh] overflow-y-auto`}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Import uniwersalny
            <Badge variant="info">beta</Badge>
          </DialogTitle>
          <DialogDescription>
            {filesLabel ? `${filesLabel} · ` : ''}
            {stepLabel[step]}
            {step === 'mapping' && multiDoc && current
              ? ` · tabela ${cursor + 1}/${sheets.length}: „${docLabel(current.analysis)}"`
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
            {multiDoc && (
              <p className="text-xs text-muted-foreground">
                Mapujesz tabelę <span className="font-medium">„{docLabel(current.analysis)}"</span>{' '}
                ({cursor + 1} z {sheets.length}). Po zmapowaniu przejdziemy do kolejnej, a podgląd
                pokaże dane ze wszystkich tabel razem.
              </p>
            )}

            {current.analysis.suggestions && current.analysis.suggestions.length > 0 && (
              <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2.5">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Library className="h-4 w-4 text-primary" />
                  Podobne formaty w bibliotece
                </div>
                <p className="text-xs text-muted-foreground">
                  Te zapisane profile mają niemal identyczne kolumny. Jeśli broker tylko zmienił
                  nazwę albo kolejność kolumny, użyj gotowego profilu zamiast generować mapowanie od
                  nowa — podgląd potwierdzi dopasowanie, zanim cokolwiek zaimportujesz.
                </p>
                <div className="space-y-1.5">
                  {current.analysis.suggestions.map((s) => (
                    <div
                      key={s.summary.id}
                      className="flex items-center justify-between gap-3 rounded border border-border bg-background/50 px-2.5 py-1.5"
                    >
                      <span className="min-w-0 truncate text-xs">
                        {s.summary.brokerLabel || 'Profil bez nazwy'}{' '}
                        <span className="text-muted-foreground">
                          · podobieństwo {(s.similarity * 100).toFixed(0)}%
                        </span>
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0 text-xs"
                        onClick={() => handleUseSuggestion(s)}
                      >
                        Użyj i pokaż podgląd
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
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
                  wyłącznie zredagowane fragmenty {multiDoc ? 'tej tabeli' : 'pliku'}: nazwy kolumn,
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

            <MappingEditor
              draft={draft}
              sampleRows={current.analysis.sampleRows}
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
              <Button onClick={handleSheetMapped}>
                {multiDoc && cursor < sheets.length - 1
                  ? 'Dalej (kolejna tabela)'
                  : 'Pokaż podgląd'}
              </Button>
            </div>
          </div>
        )}

        {step === 'preview' && preview && (
          <div className="space-y-4">
            <MessagesList messages={messages} />
            {preview.sheetSummaries && preview.sheetSummaries.length > 1 && (
              <div className="rounded-md border border-border bg-muted/20 p-2.5 text-xs space-y-1">
                <span className="font-medium">Wkład tabel:</span>
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
            {skippedLabels.length > 0 && step === 'done' && (
              <p className="text-xs text-muted-foreground">
                Pominięto pliki/arkusze bez tabeli danych:{' '}
                {skippedLabels.map((s) => `„${s}"`).join(', ')}.
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

/** SheetWork[] → wejście dla preview/commit (profil per tabela, z file+sheet). */
function toSheetInputs(works: SheetWork[]): GenericSheetProfileInput[] {
  return works
    .filter((w) => w.resolved)
    .map((w) => ({
      file: w.analysis.file,
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
