import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { CheckCircle, AlertCircle, AlertTriangle, Loader2, Info } from 'lucide-react';
import { formatDate, formatQuantity } from '@/lib/formatters';
import {
  type BrokerType,
  type SkipReason,
  type OrphanedSell,
  type DetectResult,
  BROKER_LABELS,
} from 'shared';

const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  missing_date: 'brak daty',
  missing_isin: 'brak ISIN',
  missing_name: 'brak nazwy',
  invalid_side: 'nieprawidłowa strona (K/S)',
  invalid_quantity: 'nieprawidłowa ilość',
  invalid_price: 'nieprawidłowa cena',
  invalid_date: 'nieprawidłowy format daty',
  corporate_action: 'akcja korporacyjna',
  short_row: 'niekompletny wiersz',
  zero_amount: 'kwota zerowa',
  settlement_record: 'rozliczenie transakcji',
  summary_row: 'wiersz podsumowania',
  unparseable_comment: 'nierozpoznany format komentarza',
  close_trade_entry: 'wpis P/L (pominięty)',
  missing_description: 'brak opisu operacji',
  unmatched_fx_credit: 'niesparowana wymiana walut',
  duplicate: 'duplikat (już zaimportowano)',
  redemption_reconciled: 'wykup/wezwanie (domknięte syntetyczną sprzedażą)',
  unknown_operation_type: 'nierozpoznany typ operacji',
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Message {
  kind: 'success' | 'warn' | 'error' | 'info';
  text: string;
}

export function ImportDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();

  const [transactionsFile, setTransactionsFile] = useState<File | null>(null);
  const [operationsFile, setOperationsFile] = useState<File | null>(null);
  const [detectedBroker, setDetectedBroker] = useState<BrokerType | null>(null);
  const [requiresOps, setRequiresOps] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [orphanedSells, setOrphanedSells] = useState<OrphanedSell[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);

  const addMessage = useCallback((m: Message) => {
    setMessages(prev => [...prev, m]);
  }, []);

  const resetState = useCallback(() => {
    setTransactionsFile(null);
    setOperationsFile(null);
    setDetectedBroker(null);
    setRequiresOps(false);
    setMessages([]);
    setOrphanedSells([]);
  }, []);

  const handleTransactionsSelected = useCallback(async (file: File | null) => {
    setTransactionsFile(file);
    setDetectedBroker(null);
    setRequiresOps(false);

    if (!file) return;
    setDetecting(true);
    try {
      const detect: DetectResult = await api.detectImportFile(file);
      if (detect.fileRole === 'operations') {
        addMessage({ kind: 'warn', text: `Plik "${file.name}" wygląda na eksport operacji gotówkowych, nie transakcji — przełóż go do pola poniżej.` });
        setTransactionsFile(null);
        return;
      }
      if (detect.fileRole === 'unknown' || !detect.broker) {
        addMessage({ kind: 'warn', text: `Nie udało się rozpoznać formatu pliku ${file.name}. Sprawdź czy to poprawny eksport z brokera.` });
      }
      setDetectedBroker(detect.broker);
      setRequiresOps(detect.requiresOperationsFile);
    } catch (err) {
      addMessage({ kind: 'error', text: `Błąd klasyfikacji pliku: ${(err as Error).message}` });
    } finally {
      setDetecting(false);
    }
  }, [addMessage]);

  const handleOperationsSelected = useCallback(async (file: File | null) => {
    setOperationsFile(file);
    if (!file) return;
    // Lekka walidacja: sprawdź że to faktycznie operacje, nie transakcje
    try {
      const detect: DetectResult = await api.detectImportFile(file);
      if (detect.fileRole === 'transactions') {
        addMessage({ kind: 'warn', text: `Plik "${file.name}" wygląda na eksport transakcji, nie operacji gotówkowych — przełóż go do pola wyżej.` });
        setOperationsFile(null);
      }
    } catch (err) {
      // Ignoruj błąd detekcji — bulk endpoint i tak to zwaliduje, plik zostaje
    }
  }, [addMessage]);

  const canSubmit = (() => {
    if (uploading) return false;
    if (!transactionsFile) return false;
    if (requiresOps && !operationsFile) return false;
    return true;
  })();

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setUploading(true);
    try {
      const result = await api.bulkImport(transactionsFile, operationsFile);

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

        if (result.syntheticSells && result.syntheticSells > 0) {
          addMessage({ kind: 'info', text: `Utworzono ${result.syntheticSells} syntetycznych sprzedaży (wykupy certyfikatów / wezwania skupu akcji)` });
        }

        if (result.taxesApplied && result.taxesApplied > 0) {
          addMessage({ kind: 'info', text: `Zaaplikowano ${result.taxesApplied} opłat transakcyjnych (DEGIRO Stamp Duty / podatek francuski)` });
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

        if (result.crossFileWarnings && result.crossFileWarnings.length > 0) {
          for (const w of result.crossFileWarnings) {
            addMessage({ kind: 'warn', text: w });
          }
        }

        if (result.warnings && result.warnings.length > 0) {
          for (const w of result.warnings) {
            addMessage({ kind: 'warn', text: w });
          }
        }

        if (result.skipped && result.skipped.length > 0) {
          // Ukrywamy rows, które użytkownik nie traktuje jako „pominięte":
          //  - close_trade_entry (XTB P/L — użyte w parze K+S)
          //  - duplicate (już liczone osobno powyżej)
          //  - redemption_reconciled (wykup/wezwanie wchodzi jako syntetyczna sprzedaż —
          //    użytkownik widzi je w info "Utworzono N syntetycznych sprzedaży", duplikowanie
          //    w liście "pominięto" jest mylące)
          const hiddenReasons = new Set(['close_trade_entry', 'duplicate', 'redemption_reconciled']);
          const visible = result.skipped.filter((s: any) => !hiddenReasons.has(s.reason));
          if (visible.length > 0) {
            const lines = visible.map((s: { paperName?: string; reason: string; row: number }) => {
              const name = s.paperName ? `${s.paperName} ` : '';
              const reason = SKIP_REASON_LABELS[s.reason as SkipReason] || s.reason;
              return `${name}(wiersz ${s.row}) — ${reason}`;
            });
            addMessage({ kind: 'warn', text: `Pominięto ${visible.length} wierszy:\n${lines.join('\n')}` });
          }
        }

        if (result.orphanedSells && result.orphanedSells.length > 0) {
          setOrphanedSells(prev => [
            ...prev,
            ...(result.orphanedSells as OrphanedSell[]).filter(
              (o: OrphanedSell) => !prev.some(p => p.isin === o.isin),
            ),
          ]);
        }

        queryClient.invalidateQueries();
      } else {
        addMessage({ kind: 'error', text: `Błąd: ${result.errors?.join('; ') || result.error || 'nieznany błąd'}` });
      }
    } catch (err) {
      addMessage({ kind: 'error', text: `Błąd: ${(err as Error).message}` });
    } finally {
      setUploading(false);
    }
  }, [canSubmit, transactionsFile, operationsFile, queryClient, addMessage]);

  const handleAddSpinoffBuy = useCallback(async (orphan: OrphanedSell) => {
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

      setOrphanedSells(prev => prev.filter(o => o.isin !== orphan.isin));
      addMessage({ kind: 'success', text: `Dodano kupno spin-off: ${orphan.paperName} (${orphan.missingQuantity} szt. @ 0)` });
      queryClient.invalidateQueries();
    } catch (err) {
      addMessage({ kind: 'error', text: `Nie udało się dodać kupna dla ${orphan.paperName}: ${(err as Error).message}` });
    } finally {
      setResolving(null);
    }
  }, [queryClient, addMessage]);

  const detectedLabel = detectedBroker ? BROKER_LABELS[detectedBroker] : null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetState(); onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import danych</DialogTitle>
          <DialogDescription>
            Prześlij pliki CSV/XLSX. Dla Bossy i DEGIRO wymagane są oba pliki — import uruchomi się dopiero gdy oba są wybrane.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Transakcje (hisPW.csv, Transactions.csv, XTB .xlsx, mBank CSV)
            </label>
            <Input
              type="file"
              accept=".csv,.xlsx"
              disabled={uploading}
              className="file:bg-muted file:border-0 file:mr-3 file:py-1.5 file:px-3 file:rounded file:text-xs file:font-semibold file:text-foreground hover:file:bg-accent file:cursor-pointer text-xs text-muted-foreground"
              onChange={(e) => handleTransactionsSelected(e.target.files?.[0] ?? null)}
            />
            {detecting && (
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Rozpoznawanie formatu...
              </span>
            )}
            {detectedLabel && !detecting && (
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Info className="h-3 w-3" /> Wykryto: <span className="font-medium">{detectedLabel}</span>
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Operacje gotówkowe {requiresOps && <span className="text-destructive">(wymagane)</span>}
            </label>
            {detectedBroker && !requiresOps && (
              <span className="text-xs text-muted-foreground -mt-0.5">
                {detectedLabel} dostarcza wszystko w jednym pliku — to pole opcjonalne.
              </span>
            )}
            {requiresOps && !operationsFile && (
              <span className="text-xs text-muted-foreground -mt-0.5">
                Dla {detectedLabel} dodaj eksport operacji gotówkowych (Bossa: <code>...operacje_bez_transakcji...csv</code>, DEGIRO: <code>Account.csv</code>).
              </span>
            )}
            <Input
              type="file"
              accept=".csv"
              disabled={uploading || !transactionsFile}
              className="file:bg-muted file:border-0 file:mr-3 file:py-1.5 file:px-3 file:rounded file:text-xs file:font-semibold file:text-foreground hover:file:bg-accent file:cursor-pointer text-xs text-muted-foreground"
              onChange={(e) => handleOperationsSelected(e.target.files?.[0] ?? null)}
            />
          </div>

          <Button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="w-full"
          >
            {uploading ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Importowanie...</>
            ) : 'Importuj'}
          </Button>

          {messages.map((m, i) => {
            // Długie wiadomości (lista pominiętych/warningi cross-file) mogą mieć wiele linii —
            // cap wysokości + wewnętrzny scroll żeby dialog nie rósł w nieskończoność.
            const isLong = m.text.split('\n').length > 10;
            return (
              <div key={i} className="flex items-start gap-2 text-sm">
                {m.kind === 'error' ? (
                  <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                ) : m.kind === 'warn' ? (
                  <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0 mt-0.5" />
                ) : m.kind === 'info' ? (
                  <Info className="h-4 w-4 text-blue-500 shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle className="h-4 w-4 text-success shrink-0 mt-0.5" />
                )}
                <span className={[
                  'whitespace-pre-line min-w-0',
                  isLong ? 'max-h-60 overflow-y-auto pr-2 block' : '',
                  m.kind === 'warn' ? 'text-yellow-600 dark:text-yellow-400' : '',
                  m.kind === 'info' ? 'text-blue-600 dark:text-blue-400' : '',
                  m.kind === 'error' ? 'text-destructive' : '',
                ].filter(Boolean).join(' ')}>{m.text}</span>
              </div>
            );
          })}

          {orphanedSells.length > 0 && (
            <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3 space-y-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0 mt-0.5" />
                <span className="text-sm font-medium text-yellow-600 dark:text-yellow-400">
                  Wykryto sprzedaż bez kupna
                </span>
              </div>
              {orphanedSells.map(o => (
                <div key={o.isin} className="ml-6 space-y-1.5">
                  <div className="text-sm">
                    <span className="font-medium">{o.paperName}</span>
                    <span className="text-muted-foreground"> ({o.ticker})</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Brak kupna dla {formatQuantity(o.missingQuantity)} szt. ({o.currency}) · Pierwsza sprzedaż: {formatDate(o.firstSellDate)}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={resolving === o.isin}
                      onClick={() => handleAddSpinoffBuy(o)}
                    >
                      {resolving === o.isin ? (
                        <><Loader2 className="h-3 w-3 animate-spin mr-1" />Dodawanie...</>
                      ) : 'Dodaj kupno — spin-off (cena 0)'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setOrphanedSells(prev => prev.filter(x => x.isin !== o.isin))}
                    >
                      Pomiń
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              resetState();
              onOpenChange(false);
            }}
          >
            Zamknij
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
