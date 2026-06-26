import { useEffect, useMemo, useRef, useState } from 'react';
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
  Pencil,
  Settings2,
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
  draftFromProfile,
  scoreDraft,
  suggestDraft,
  suggestRules,
  type DraftScore,
  type ProfileDraft,
} from '@/lib/generic-profile-builder';
import { GapFields } from './GapFields';
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
  /**
   * Profil w formie JSON do PONOWNEJ EDYCJI (reverse-map), gdy „Wróć do mapowania".
   * UI-only — NIE jest wysyłany (toSheetInputs czyta tylko `resolved`). Dla AI =
   * profileJson z odpowiedzi generatora, dla biblioteki/ręcznego = ten sam JSON.
   */
  source?: unknown;
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
  /** Werdykt pewności bieżącej tabeli — steruje gałęzią mapowania (near vs incomplete). */
  const [initialVerdict, setInitialVerdict] = useState<'near' | 'incomplete'>('near');
  /** Progresywne ujawnianie: pełny edytor i boks AI domyślnie schowane. */
  const [showAllFields, setShowAllFields] = useState(false);
  const [showAiBox, setShowAiBox] = useState(false);
  /** Edycja istniejącego mapowania (AI/biblioteka) wczytanego przez reverse-map. */
  const [editingSource, setEditingSource] = useState(false);
  /** Cechy wczytanego profilu nieodwzorowane w formularzu (ostrzeżenie o utracie). */
  const [sourceLossy, setSourceLossy] = useState<string[]>([]);

  /** >1 tabela → pokazuj UI per tabela (numerację, „kolejna tabela", wkład tabel). */
  const multiDoc = sheets.length > 1;
  const current = sheets[cursor];
  const filesLabel = files.length === 1 ? (files[0]?.name ?? '') : `${files.length} plików`;

  /** Live-skan bieżącego draftu (tryb all-trades) → karta luk + potwierdzenie pól. */
  const liveScore = useMemo(
    () =>
      step === 'mapping' && draft && draft.mode === 'all-trades' && current
        ? scoreDraft(draft, current.analysis.sampleRows)
        : null,
    [step, draft, current],
  );
  /** Tryb reguł = plik operacji; etykieta przełącznika edytora to sygnalizuje. */
  const manualToggleLabel =
    draft?.mode === 'rules' && draft.classify.length > 0
      ? `Edytuj reguły ręcznie (${draft.classify.length} zasugerowanych)`
      : 'Edytuj wszystkie pola ręcznie';

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
        if (w.analysis.profile) {
          w.resolved = { profileId: w.analysis.profile.summary.id };
          w.source = w.analysis.profile.profileJson; // do edycji po „Wróć do mapowania"
        }
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

  /** Heurystyka tabeli: draft + werdykt pewności (czysta logika, bez efektów). */
  function analyzeSheet(a: GenericSheetAnalysis): { draft: ProfileDraft; score: DraftScore } {
    const draft = suggestDraft(a.headers, a.sampleRows, {
      delimiter: a.delimiter,
      headerRowIndex: a.headerRowIndex,
    });
    return { draft, score: scoreDraft(draft, a.sampleRows) };
  }

  function noteAutoDetected(labels: string[], multi: boolean) {
    setMessages((prev) => [
      ...prev,
      {
        kind: 'info',
        text: multi
          ? `Rozpoznano automatycznie układ kolumn: ${labels.map((l) => `„${l}"`).join(', ')}. Sprawdź podgląd przed importem.`
          : 'Rozpoznaliśmy układ kolumn automatycznie — sprawdź podgląd przed importem.',
      },
    ]);
  }

  /**
   * Od `from` znajdź pierwszą nierozwiązaną tabelę. Tabele z PEWNYM mapowaniem
   * (verdict 'complete') auto-rozwiązujemy bez pytań i lecimy dalej; pierwszą
   * niepewną otwieramy w mapowaniu; gdy wszystko rozwiązane — podgląd scalony.
   */
  async function proceedFrom(works: SheetWork[], from: number) {
    let updated = works;
    const auto: string[] = [];
    let i = updated.findIndex((w, idx) => idx >= from && !w.resolved);
    while (i !== -1) {
      const a = updated[i].analysis;
      const { draft, score } = analyzeSheet(a);
      if (score.verdict === 'complete') {
        const built = buildProfileFromDraft(draft);
        if (built.ok) {
          updated = updated.map((w, idx) =>
            idx === i
              ? { ...w, resolved: { profileJson: built.profile }, source: built.profile }
              : w,
          );
          auto.push(docLabel(a));
          i = updated.findIndex((w, idx) => idx > i && !w.resolved);
          continue;
        }
      }
      setSheets(updated);
      if (auto.length > 0) noteAutoDetected(auto, updated.length > 1);
      enterMapping(updated, i, { draft, score });
      return;
    }
    setSheets(updated);
    if (auto.length > 0) noteAutoDetected(auto, updated.length > 1);
    await runMergedPreview(updated);
  }

  function enterMapping(
    works: SheetWork[],
    idx: number,
    pre?: { draft: ProfileDraft; score: DraftScore },
  ) {
    const a = works[idx].analysis;
    const meta = { headers: a.headers, delimiter: a.delimiter, headerRowIndex: a.headerRowIndex };

    // Edycja istniejącego mapowania (AI/biblioteka): wczytaj profil do edytora (reverse-map).
    const src = works[idx].source;
    if (src !== undefined) {
      const rev = draftFromProfile(src, meta);
      if (rev.ok && rev.draft) {
        setCursor(idx);
        setDraft(rev.draft);
        setEditingSource(true);
        setSourceLossy(rev.lossy);
        setShowAllFields(true);
        setShowAiBox(false);
        setInitialVerdict('near');
        setMappingErrors([]);
        setAiConsent(false);
        setAiError(null);
        setStep('mapping');
        return;
      }
      // Zbyt złożony, by wczytać do formularza → heurystyka + ostrzeżenie o zastąpieniu.
      setMessages((prev) => [
        ...prev,
        {
          kind: 'warn',
          text: `Nie można wczytać dotychczasowego mapowania do edytora (${rev.reason ?? 'zbyt złożone'}). Zaczniesz od nowa — poprzednie mapowanie zostanie zastąpione dopiero po zapisaniu.`,
        },
      ]);
    }

    const { draft: d0, score } = pre ?? analyzeSheet(a);
    let draft = d0;
    // Plik operacji: zasiej tryb reguł, żeby pełny edytor nie startował pusty (P4).
    if (score.operationsLike) {
      const seeded = suggestRules(a.headers, a.sampleRows);
      if (seeded.rules.length > 0) {
        draft = {
          ...d0,
          mode: 'rules',
          classify: seeded.rules,
          defaultClass: 'skip',
          cash: { ...d0.cash, descriptionCol: seeded.descriptionCol },
        };
      }
    }
    setCursor(idx);
    setDraft(draft);
    setEditingSource(false);
    setSourceLossy([]);
    setInitialVerdict(score.verdict === 'incomplete' ? 'incomplete' : 'near');
    setShowAllFields(false);
    setShowAiBox(false);
    setMappingErrors([]);
    setAiConsent(false);
    setAiError(null);
    setStep('mapping');
  }

  /**
   * Zapisz rozwiązany profil bieżącej tabeli i przejdź dalej (kolejna tabela / podgląd).
   * `source` = JSON profilu do późniejszej edycji (reverse-map); domyślnie profileJson.
   */
  async function resolveAndAdvance(
    resolved: { profileId?: string; profileJson?: unknown },
    source?: unknown,
  ) {
    const src = source !== undefined ? source : resolved.profileJson;
    const updated = sheets.map((w, i) => (i === cursor ? { ...w, resolved, source: src } : w));
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
      await resolveAndAdvance({ profileId: result.summary.id }, result.profileJson);
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

            {/* Edycja istniejącego mapowania (AI/biblioteka) — baner + pełny edytor. */}
            {editingSource && (
              <>
                <EditingSourceBanner lossy={sourceLossy} />
                <MappingEditor
                  draft={draft}
                  sampleRows={current.analysis.sampleRows}
                  onChange={setDraft}
                />
              </>
            )}

            {!editingSource &&
              current.analysis.suggestions &&
              current.analysis.suggestions.length > 0 && (
                <SuggestionsBox
                  suggestions={current.analysis.suggestions}
                  onUse={handleUseSuggestion}
                />
              )}

            {/* INCOMPLETE: nietypowy układ / plik operacji → prowadź AI (CTA niżej). */}
            {!editingSource && initialVerdict === 'incomplete' && (
              <div className="rounded-md border border-primary/40 bg-primary/5 p-3 space-y-1">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Sparkles className="h-4 w-4 text-primary" />
                  {draft.mode === 'rules'
                    ? 'Plik wygląda na operacje gotówkowe'
                    : 'Nie rozpoznaliśmy układu automatycznie'}
                </div>
                <p className="text-xs text-muted-foreground">
                  {draft.mode === 'rules'
                    ? 'Zawiera różne typy wierszy (dywidendy, wpłaty, opłaty…). Najpewniej rozpozna je automat — albo zmapuj regułami ręcznie poniżej.'
                    : 'Układ kolumn jest nietypowy. Najszybciej rozpozna go automat — albo uzupełnij mapowanie ręcznie poniżej.'}
                </p>
              </div>
            )}

            {/* NEAR: karta „uzupełnij brakujące pola" — pyta tylko o luki. */}
            {!editingSource && initialVerdict === 'near' && liveScore && (
              <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <CheckCircle className="h-4 w-4 text-success" />
                  {liveScore.gaps.length === 0
                    ? 'Wszystko gotowe — pokaż podgląd'
                    : `Prawie gotowe — uzupełnij ${liveScore.gaps.length} ${pluralFields(liveScore.gaps.length)}`}
                </div>
                <GapFields
                  draft={draft}
                  sampleRows={current.analysis.sampleRows}
                  score={liveScore}
                  onChange={setDraft}
                />
              </div>
            )}

            {/* Boks AI: prominentnie przy incomplete; przy near za cichym linkiem. */}
            {!editingSource && (initialVerdict === 'incomplete' || showAiBox) && (
              <AiMappingBox
                analysis={current.analysis}
                multiDoc={multiDoc}
                consent={aiConsent}
                onConsent={setAiConsent}
                busy={aiBusy}
                elapsed={aiElapsed}
                error={aiError}
                onGenerate={handleGenerateAi}
              />
            )}
            {!editingSource && initialVerdict === 'near' && !showAiBox && (
              <button
                type="button"
                onClick={() => setShowAiBox(true)}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                Złożony format? Wygeneruj mapowanie przez AI
              </button>
            )}

            {/* Pełny edytor — domyślnie zwinięty (progresywne ujawnianie). */}
            {!editingSource && showAllFields && (
              <div className="space-y-2">
                <MappingEditor
                  draft={draft}
                  sampleRows={current.analysis.sampleRows}
                  onChange={setDraft}
                />
                <button
                  type="button"
                  onClick={() => setShowAllFields(false)}
                  className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                >
                  Ukryj wszystkie pola
                </button>
              </div>
            )}
            {!editingSource && !showAllFields && (
              <button
                type="button"
                onClick={() => setShowAllFields(true)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                <Settings2 className="h-3.5 w-3.5" />
                {manualToggleLabel}
              </button>
            )}

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
              {editingSource ? (
                <Button variant="outline" onClick={() => void runMergedPreview(sheets)}>
                  Wróć bez zmian
                </Button>
              ) : (
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                  Anuluj
                </Button>
              )}
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

/** Polska odmiana rzeczownika „pole" wg liczby (1 pole / 2–4 pola / 5+ pól). */
function pluralFields(n: number): string {
  if (n === 1) return 'pole';
  const mod10 = n % 10;
  const mod100 = n % 100;
  return mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20) ? 'pola' : 'pól';
}

/** Baner nad edytorem przy wczytaniu istniejącego mapowania (reverse-map). */
function EditingSourceBanner({ lossy }: { lossy: string[] }) {
  if (lossy.length === 0) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-info">
        <Pencil className="h-4 w-4 shrink-0 mt-0.5" />
        <span>
          Edytujesz istniejące mapowanie. Zmień, co trzeba, i kliknij „Pokaż podgląd" — albo „Wróć
          bez zmian", by zachować je nietknięte.
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>
        To mapowanie zawiera elementy, których formularz nie pokazuje i które{' '}
        <span className="font-medium">przepadną po zapisaniu</span>: {lossy.join(', ')}. Jeśli nie
        chcesz ich stracić, kliknij „Wróć bez zmian".
      </span>
    </div>
  );
}

/** Boks „Podobne formaty w bibliotece" — adopcja gotowego profilu (bez AI). */
function SuggestionsBox({
  suggestions,
  onUse,
}: {
  suggestions: NonNullable<GenericSheetAnalysis['suggestions']>;
  onUse: (s: NonNullable<GenericSheetAnalysis['suggestions']>[number]) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2.5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Library className="h-4 w-4 text-primary" />
        Podobne formaty w bibliotece
      </div>
      <p className="text-xs text-muted-foreground">
        Te zapisane profile mają niemal identyczne kolumny. Jeśli broker tylko zmienił nazwę albo
        kolejność kolumny, użyj gotowego profilu zamiast generować mapowanie od nowa — podgląd
        potwierdzi dopasowanie, zanim cokolwiek zaimportujesz.
      </p>
      <div className="space-y-1.5">
        {suggestions.map((s) => (
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
              onClick={() => onUse(s)}
            >
              Użyj i pokaż podgląd
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Boks generacji mapowania przez AI (zgoda + zredagowana próbka + przycisk). */
function AiMappingBox({
  analysis,
  multiDoc,
  consent,
  onConsent,
  busy,
  elapsed,
  error,
  onGenerate,
}: {
  analysis: GenericSheetAnalysis;
  multiDoc: boolean;
  consent: boolean;
  onConsent: (v: boolean) => void;
  busy: boolean;
  elapsed: number;
  error: string | null;
  onGenerate: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2.5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="h-4 w-4 text-primary" />
        Automatyczne mapowanie (AI)
      </div>
      <p className="text-xs text-muted-foreground">
        Zamiast mapować ręcznie, możesz wygenerować mapowanie automatycznie. Do usługi AI (serwer w
        UE) trafią{' '}
        <span className="font-medium">
          wyłącznie zredagowane fragmenty {multiDoc ? 'tej tabeli' : 'pliku'}: nazwy kolumn,
          poniższa próbka, listy unikalnych wartości kolumn (np. typy operacji) oraz pojedyncze
          wiersze potrzebne do poprawy mapowania — wszystko po tej samej redakcji
        </span>{' '}
        — nigdy cały plik ani dane osobowe (numery rachunków, nazwiska i e-maile są maskowane).
      </p>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Zobacz dokładnie, co zostanie wysłane
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] leading-relaxed">
          {[
            analysis.headers.join(analysis.delimiter),
            ...analysis.sampleRows.map((r) => r.join(analysis.delimiter)),
          ].join('\n')}
        </pre>
      </details>
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={consent}
          onChange={(e) => onConsent(e.target.checked)}
        />
        <span>
          Zgadzam się na wysłanie powyższej zredagowanej próbki do usługi AI w celu wygenerowania
          mapowania.
        </span>
      </label>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          disabled={!consent || busy}
          onClick={onGenerate}
        >
          {busy ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              Generowanie… {elapsed}s
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Wygeneruj mapowanie (AI)
            </>
          )}
        </Button>
        {error && (
          <span className="text-xs text-warning flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {error}
          </span>
        )}
      </div>
      {busy && (
        <p className="text-xs text-muted-foreground">
          AI analizuje strukturę i sprawdza wynik na realnej próbce. Proste formaty zajmują ok.
          minuty; przy złożonych model dostaje feedback i poprawia mapowanie — to może potrwać do
          kilku minut. Możesz nie zamykać tego okna i poczekać.
        </p>
      )}
    </div>
  );
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
