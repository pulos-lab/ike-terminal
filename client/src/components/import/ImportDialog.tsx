import { useEffect, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { Loader2, ChevronLeft } from 'lucide-react';
import {
  type BrokerType,
  type SkipReason,
  type OrphanedSell,
  type QuarantineRecord,
  type DetectResult,
  BROKER_LABELS,
} from 'shared';
import { GenericImportWizard } from './generic/GenericImportWizard';
import { GenericBatchesSection } from './generic/GenericBatchesSection';
import { ImportBatchesSection } from './ImportBatchesSection';
import { FeedbackBlock, type FeedbackMessage } from './FeedbackBlock';
import { SKIP_REASON_LABELS } from '@/lib/import-labels';
import {
  BROKER_IMPORT_CONFIG,
  BROKER_TILES,
  GENERIC_TILE_LABEL,
  isKnownBroker,
  type FileRole,
  type KnownBroker,
} from './broker-import-config';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Wybrany ekran: null = siatka kafelków; broker | 'generic' = ekran uploadu. */
type Screen = BrokerType | 'generic' | null;

export function ImportDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();

  const [screen, setScreen] = useState<Screen>(null);
  /** Pliki per rola (transactions/operations) dla wybranego brokera. */
  const [filesByRole, setFilesByRole] = useState<Record<FileRole, File[]>>({
    transactions: [],
    operations: [],
  });
  const [uploading, setUploading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [messages, setMessages] = useState<FeedbackMessage[]>([]);
  const [orphanedSells, setOrphanedSells] = useState<OrphanedSell[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);
  /** Pliki dla importu uniwersalnego (ekran „Inny broker") — 1..N, scalane w jeden import. */
  const [genericFiles, setGenericFiles] = useState<File[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);
  /** Broker do auto-importu po wykryciu znanego formatu w kreatorze (null = brak). */
  const [autoImportBroker, setAutoImportBroker] = useState<KnownBroker | null>(null);

  // Stan batcha ostatniego udanego importu — do wyświetlenia ID i cofnięcia.
  const [lastImportBatch, setLastImportBatch] = useState<string | null>(null);
  const [lastImportQuarantine, setLastImportQuarantine] = useState<QuarantineRecord[] | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const addMessage = useCallback((m: FeedbackMessage) => {
    setMessages((prev) => [...prev, m]);
  }, []);

  const clearUploadState = useCallback(() => {
    setFilesByRole({ transactions: [], operations: [] });
    setMessages([]);
    setOrphanedSells([]);
    setGenericFiles([]);
    setWizardOpen(false);
    setLastImportBatch(null);
    setLastImportQuarantine(null);
    setUndoError(null);
  }, []);

  const resetState = useCallback(() => {
    setScreen(null);
    clearUploadState();
  }, [clearUploadState]);

  const goBack = useCallback(() => {
    setScreen(null);
    clearUploadState();
  }, [clearUploadState]);

  /**
   * Wybór plików dla slotu danego brokera. Dla slotu transakcji uruchamia
   * detekcję pierwszego pliku i ostrzega (bez blokowania), gdy format nie pasuje
   * do wybranego brokera — łapie pomyłkę „wybrałem XTB, wgrałem DEGIRO".
   */
  const handleSlotFiles = useCallback(
    async (role: FileRole, fileList: FileList | null, multiple: boolean) => {
      if (!fileList || fileList.length === 0) return;
      const incoming = Array.from(fileList);
      setFilesByRole((prev) => ({
        ...prev,
        [role]: multiple ? [...prev[role], ...incoming] : incoming.slice(0, 1),
      }));

      // Walidacja-ostrzeżenie tylko dla znanego brokera i pliku transakcji.
      if (role !== 'transactions' || !isKnownBroker(screen)) return;
      setDetecting(true);
      try {
        const detect: DetectResult = await api.detectImportFile(incoming[0]);
        if (detect.broker && detect.broker !== screen) {
          addMessage({
            kind: 'warn',
            text: `Plik „${incoming[0].name}" wygląda na format ${BROKER_LABELS[detect.broker]}, a wybrałeś ${BROKER_LABELS[screen]}. Możesz kontynuować, ale sprawdź czy to właściwy plik.`,
          });
        }
      } catch {
        // Detekcja to tylko podpowiedź — błąd ignorujemy, import i tak zwaliduje plik.
      } finally {
        setDetecting(false);
      }
    },
    [screen, addMessage],
  );

  const removeSlotFile = useCallback((role: FileRole, idx: number) => {
    setFilesByRole((prev) => ({ ...prev, [role]: prev[role].filter((_, i) => i !== idx) }));
  }, []);

  const knownConfig = isKnownBroker(screen) ? BROKER_IMPORT_CONFIG[screen as KnownBroker] : null;

  const canSubmit = (() => {
    if (uploading || !knownConfig) return false;
    return knownConfig.files.every((slot) => !slot.required || filesByRole[slot.role].length > 0);
  })();

  const handleSubmit = useCallback(async () => {
    if (uploading || !knownConfig) return;
    if (!knownConfig.files.every((slot) => !slot.required || filesByRole[slot.role].length > 0)) {
      return;
    }
    setUploading(true);
    try {
      const result = await api.bulkImport(
        filesByRole.transactions,
        filesByRole.operations[0] ?? null,
      );

      if (result.success) {
        const txCount = result.transactionsImported || 0;
        const opsCount = result.operationsImported || 0;
        const sourceLabel = result.detectedSource
          ? ` (${BROKER_LABELS[result.detectedSource as BrokerType] || result.detectedSource})`
          : '';

        if (txCount > 0 || opsCount > 0) {
          const parts: string[] = [];
          if (txCount > 0) parts.push(`${txCount} transakcji`);
          if (opsCount > 0) parts.push(`${opsCount} operacji`);
          addMessage({ kind: 'success', text: `Zaimportowano ${parts.join(' i ')}${sourceLabel}` });
        }

        if (result.taxesApplied && result.taxesApplied > 0) {
          addMessage({
            kind: 'info',
            text: `Zaaplikowano ${result.taxesApplied} opłat transakcyjnych (DEGIRO Stamp Duty / podatek francuski)`,
          });
        }

        if (result.tickersResolved && result.tickersResolved > 0) {
          addMessage({ kind: 'info', text: `Rozpoznano ${result.tickersResolved} nowych papierów` });
        }

        if (result.tickersUnresolved && result.tickersUnresolved.length > 0) {
          addMessage({ kind: 'warn', text: `Nie rozpoznano: ${result.tickersUnresolved.join(', ')}` });
        }

        if (result.duplicatesSkipped && result.duplicatesSkipped > 0) {
          addMessage({ kind: 'warn', text: `Pominięto ${result.duplicatesSkipped} duplikatów` });
        }

        for (const w of result.crossFileWarnings ?? []) addMessage({ kind: 'warn', text: w });
        for (const w of result.warnings ?? []) addMessage({ kind: 'warn', text: w });

        if (result.skipped && result.skipped.length > 0) {
          // Ukrywamy rows, których użytkownik nie traktuje jako „pominięte":
          //  - close_trade_entry (XTB P/L — użyte w parze K+S)
          //  - duplicate (już liczone osobno powyżej)
          //  - redemption_reconciled (wykup/wezwanie wchodzi jako syntetyczna sprzedaż)
          const hiddenReasons = new Set<SkipReason>([
            'close_trade_entry',
            'duplicate',
            'redemption_reconciled',
          ]);
          const visible = result.skipped.filter((s) => !hiddenReasons.has(s.reason));
          if (visible.length > 0) {
            const lines = visible.map((s) => {
              const name = s.paperName ? `${s.paperName} ` : '';
              const reason = SKIP_REASON_LABELS[s.reason] || s.reason;
              return `${name}(wiersz ${s.row}) — ${reason}`;
            });
            addMessage({
              kind: 'warn',
              text: `Pominięto ${visible.length} wierszy:\n${lines.join('\n')}`,
            });
          }
        }

        if (result.quarantine && result.quarantine.length > 0) {
          const lines: string[] = [];
          for (const q of result.quarantine) {
            const tag = q.severity === 'malformed' ? 'BŁĄD STRUKTURY' : 'BŁĄD DANYCH';
            const rawStr = q.raw.join(';');
            const suggestion = q.suggestions?.length
              ? `\n    Sugestia: ${q.suggestions.join(', ')}`
              : '';
            lines.push(`  [${tag}] wiersz ${q.rowNumber}: ${q.message}${suggestion}\n    → surowe dane: ${rawStr}`);
          }
          addMessage({
            kind: 'error',
            text: `Kwarantanna — ${result.quarantine.length} wierszy z błędami:\n${lines.join('\n')}`,
          });
        }

        if (result.orphanedSells && result.orphanedSells.length > 0) {
          const incoming = result.orphanedSells;
          setOrphanedSells((prev) => [
            ...prev,
            ...incoming.filter((o) => !prev.some((p) => p.isin === o.isin)),
          ]);
        }

        // Pola plików czyścimy po sukcesie — komunikaty zostają na ekranie.
        setFilesByRole({ transactions: [], operations: [] });
        setLastImportBatch(result.importBatch);
        setLastImportQuarantine(result.quarantine ?? null);
        queryClient.invalidateQueries();
      } else {
        addMessage({
          kind: 'error',
          text: `Błąd: ${result.errors?.join('; ') || result.error || 'nieznany błąd'}`,
        });
      }
    } catch (err) {
      addMessage({ kind: 'error', text: `Błąd: ${(err as Error).message}` });
    } finally {
      setUploading(false);
    }
  }, [uploading, knownConfig, filesByRole, queryClient, addMessage]);

  /**
   * Kreator uniwersalny wykrył znany format (jeden plik). Przejmujemy sterowanie:
   * przełączamy na kafel brokera z plikiem wczytanym wg roli i — jeśli to komplet
   * (broker jednoplikowy, np. XTB) — od razu uruchamiamy import wbudowany. Format
   * dwuplikowy (Bossa/DEGIRO) zostaje na kaflu, by użytkownik dołożył brakujący plik.
   */
  const handleKnownBroker = useCallback(
    (broker: KnownBroker, fileRole: FileRole, files: File[]) => {
      setWizardOpen(false);
      setGenericFiles([]);
      setOrphanedSells([]);
      setScreen(broker);
      const next: Record<FileRole, File[]> = {
        transactions: fileRole === 'operations' ? [] : files,
        operations: fileRole === 'operations' ? files : [],
      };
      setFilesByRole(next);
      const cfg = BROKER_IMPORT_CONFIG[broker];
      const complete = cfg.files.every((s) => !s.required || next[s.role].length > 0);
      setMessages([
        {
          kind: 'info',
          text: complete
            ? `Wykryto format ${BROKER_LABELS[broker]} — uruchamiam import…`
            : `Wykryto format ${BROKER_LABELS[broker]}. Dodaj brakujący plik i kliknij Importuj.`,
        },
      ]);
      if (complete) setAutoImportBroker(broker);
    },
    [],
  );

  // Auto-import po wykryciu znanego, jednoplikowego formatu: czekamy aż stan się
  // ustawi (canSubmit), żeby handleSubmit czytał właściwe pliki. Odpala się raz.
  useEffect(() => {
    if (autoImportBroker && screen === autoImportBroker && canSubmit && !uploading) {
      setAutoImportBroker(null);
      void handleSubmit();
    }
  }, [autoImportBroker, screen, canSubmit, uploading, handleSubmit]);

  const handleUndoImport = useCallback(async () => {
    if (!lastImportBatch) return;
    setUndoing(true);
    setUndoError(null);
    try {
      await api.deleteImportBatch(lastImportBatch);
      setLastImportBatch(null);
      setLastImportQuarantine(null);
      setMessages([]);
      setOrphanedSells([]);
      queryClient.invalidateQueries();
      addMessage({ kind: 'success', text: 'Import został cofnięty.' });
    } catch (err) {
      setUndoError((err as Error).message);
    } finally {
      setUndoing(false);
    }
  }, [lastImportBatch, queryClient, addMessage]);

  const handleAddSpinoffBuy = useCallback(
    async (orphan: OrphanedSell) => {
      setResolving(orphan.isin);
      try {
        const buyDate = new Date(orphan.firstSellDate);
        buyDate.setDate(buyDate.getDate() - 1);
        const dateStr = buyDate.toISOString().split('T')[0] + 'T00:00:00';

        await api.createTransaction({
          date: dateStr,
          ticker: orphan.ticker,
          side: 'K',
          quantity: orphan.missingQuantity,
          price: 0,
          commission: 0,
          currency: orphan.currency,
        });

        setOrphanedSells((prev) => prev.filter((o) => o.isin !== orphan.isin));
        addMessage({
          kind: 'success',
          text: `Dodano kupno spin-off: ${orphan.paperName} (${orphan.missingQuantity} szt. @ 0)`,
        });
        queryClient.invalidateQueries();
      } catch (err) {
        addMessage({
          kind: 'error',
          text: `Nie udało się dodać kupna dla ${orphan.paperName}: ${(err as Error).message}`,
        });
      } finally {
        setResolving(null);
      }
    },
    [queryClient, addMessage],
  );

  const fileInputClass =
    'file:bg-muted file:border-0 file:mr-3 file:py-1.5 file:px-3 file:rounded file:text-xs file:font-semibold file:text-foreground hover:file:bg-accent file:cursor-pointer text-xs text-muted-foreground';

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) resetState();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {screen !== null && (
              <button
                type="button"
                onClick={goBack}
                className="text-muted-foreground hover:text-foreground transition-colors -ml-1"
                aria-label="Wróć do wyboru brokera"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            {screen === null
              ? 'Import danych'
              : screen === 'generic'
                ? 'Import uniwersalny'
                : `Import z ${BROKER_LABELS[screen as BrokerType]}`}
          </DialogTitle>
          <DialogDescription>
            {screen === null
              ? 'Wybierz swojego brokera, a powiemy dokładnie jaki plik wgrać.'
              : screen === 'generic'
                ? 'Wgraj plik CSV lub XLSX z dowolnego brokera — sami rozpoznamy kolumny.'
                : 'Wgraj plik(i) wymienione poniżej i kliknij Importuj.'}
          </DialogDescription>
        </DialogHeader>

        {/* ── Ekran 1: wybór brokera ── */}
        {screen === null && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2.5">
            {BROKER_TILES.map((tile) => {
              const isGeneric = tile.id === 'generic';
              const label = isGeneric ? GENERIC_TILE_LABEL : BROKER_LABELS[tile.id as BrokerType];
              return (
                <button
                  key={tile.id}
                  type="button"
                  onClick={() => setScreen(tile.id)}
                  className={[
                    'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors',
                    'hover:border-primary/60 hover:bg-accent/50',
                    isGeneric ? 'border-dashed border-border bg-muted/30 col-span-2' : 'border-border',
                  ].join(' ')}
                >
                  <span className="font-semibold text-sm">{label}</span>
                  <span className="text-xs text-muted-foreground">{tile.tagline}</span>
                </button>
              );
            })}
          </div>

          <ImportBatchesSection />
        </div>
        )}

        {/* ── Ekran 2A: znany broker ── */}
        {knownConfig && (
          <div className="space-y-4">
            <ol className="space-y-1.5 text-sm list-decimal list-inside marker:text-muted-foreground">
              {knownConfig.exportSteps.map((step, i) => (
                <li key={i} className="text-foreground/90">
                  {step}
                </li>
              ))}
            </ol>

            {knownConfig.files.map((slot) => (
              <div key={slot.role} className="flex flex-col gap-1.5">
                <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                  {slot.label}{' '}
                  {slot.required ? (
                    <span className="text-destructive">(wymagane)</span>
                  ) : (
                    <span className="text-muted-foreground/70">(opcjonalne)</span>
                  )}
                </label>
                <span className="text-xs text-muted-foreground -mt-0.5">{slot.hint}</span>
                <Input
                  type="file"
                  accept={slot.accept}
                  multiple={slot.multiple}
                  disabled={uploading}
                  className={fileInputClass}
                  onChange={(e) => {
                    handleSlotFiles(slot.role, e.target.files, slot.multiple);
                    e.target.value = '';
                  }}
                />
                {filesByRole[slot.role].length > 0 && (
                  <ul className="flex flex-col gap-1 mt-0.5">
                    {filesByRole[slot.role].map((f, idx) => (
                      <li
                        key={idx}
                        className="flex items-center justify-between text-xs bg-muted/50 rounded px-2 py-1"
                      >
                        <span className="truncate flex-1" title={f.name}>
                          {f.name}
                        </span>
                        <button
                          type="button"
                          disabled={uploading}
                          onClick={() => removeSlotFile(slot.role, idx)}
                          className="ml-2 text-muted-foreground hover:text-destructive transition-colors"
                          aria-label={`Usuń ${f.name}`}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}

            {knownConfig.formatNote && (
              <p className="text-[11px] text-muted-foreground/80">{knownConfig.formatNote}</p>
            )}

            {detecting && (
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Sprawdzanie pliku…
              </span>
            )}

            <Button onClick={handleSubmit} disabled={!canSubmit} className="w-full">
              {uploading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" /> Importowanie…
                </>
              ) : (
                'Importuj'
              )}
            </Button>

            <FeedbackBlock
              messages={messages}
              orphanedSells={orphanedSells}
              resolving={resolving}
              onAddSpinoff={handleAddSpinoffBuy}
              onDismissOrphan={(isin) =>
                setOrphanedSells((prev) => prev.filter((x) => x.isin !== isin))
              }
              lastImportBatch={lastImportBatch}
              onUndo={handleUndoImport}
              undoing={undoing}
              undoError={undoError}
              lastImportQuarantine={lastImportQuarantine}
            />
          </div>
        )}

        {/* ── Ekran 2B: inny broker → import uniwersalny ── */}
        {screen === 'generic' && (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
              Import uniwersalny sam rozpozna układ kolumn Twojego pliku. Jeśli to nowy format —
              poprowadzimy Cię przez szybkie mapowanie i pokażemy podgląd przed zapisem. Plików nie
              przechowujemy na serwerze — jeśli kiedyś poprawimy mapowanie, poprosimy Cię o ponowne
              wgranie pliku.
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
                Pliki CSV lub XLSX
              </label>
              <span className="text-xs text-muted-foreground -mt-0.5">
                Eksport historii z dowolnego brokera w formacie CSV lub XLSX (Excel). Możesz wgrać
                kilka plików naraz (np. osobno transakcje i operacje) — scalimy je w jeden import.
                Plik XLSX z kilkoma arkuszami danych też zaimportujemy w całości.
              </span>
              <Input
                type="file"
                accept=".csv,.xlsx"
                multiple
                disabled={uploading}
                className={fileInputClass}
                onChange={(e) => {
                  const picked = e.target.files ? Array.from(e.target.files) : [];
                  e.target.value = '';
                  if (picked.length > 0) {
                    setGenericFiles(picked);
                    setWizardOpen(true);
                  }
                }}
              />
            </div>
            <GenericBatchesSection />
          </div>
        )}

        {wizardOpen && genericFiles.length > 0 && (
          <GenericImportWizard
            files={genericFiles}
            open
            onKnownBroker={handleKnownBroker}
            onOpenChange={(v) => {
              if (!v) {
                setWizardOpen(false);
                setGenericFiles([]);
              }
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}


