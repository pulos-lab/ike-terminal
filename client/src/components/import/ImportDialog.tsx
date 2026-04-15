import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api-client';
import { CheckCircle, AlertCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { formatDate, formatQuantity } from '@/lib/formatters';
import { type BrokerType, type SkipReason, type OrphanedSell, BROKER_LABELS } from 'shared';

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
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const [selectedBroker, setSelectedBroker] = useState<BrokerType>('auto');
  const [orphanedSells, setOrphanedSells] = useState<OrphanedSell[]>([]);
  const [resolving, setResolving] = useState<string | null>(null);

  const handleUpload = useCallback(async (file: File, type: 'transactions' | 'operations') => {
    setUploading(true);
    try {
      const result = type === 'transactions'
        ? await api.uploadTransactions(file, selectedBroker)
        : await api.uploadOperations(file);

      if (result.success) {
        const txCount = result.transactionsImported || 0;
        const opsCount = result.operationsImported || 0;
        const sourceLabel = result.detectedSource
          ? ` (${BROKER_LABELS[result.detectedSource as BrokerType] || result.detectedSource})`
          : '';
        const messages: string[] = [];
        if (txCount > 0 && opsCount > 0) {
          messages.push(`Zaimportowano ${txCount} transakcji i ${opsCount} operacji z ${file.name}${sourceLabel}`);
        } else {
          const count = txCount || opsCount;
          messages.push(`Zaimportowano ${count} rekordów z ${file.name}${sourceLabel}`);
        }

        if (result.tickersResolved && result.tickersResolved > 0) {
          messages.push(`Rozpoznano ${result.tickersResolved} nowych papierów wartościowych`);
        }
        if (result.tickersUnresolved && result.tickersUnresolved.length > 0) {
          messages.push(`WARN:Nie rozpoznano: ${result.tickersUnresolved.join(', ')}`);
        }

        if (result.orphanedSells && result.orphanedSells.length > 0) {
          setOrphanedSells(prev => [...prev, ...(result.orphanedSells as OrphanedSell[]).filter(
            (o: OrphanedSell) => !prev.some(p => p.isin === o.isin)
          )]);
        }

        if (result.duplicatesSkipped && result.duplicatesSkipped > 0) {
          messages.push(`WARN:Pominięto ${result.duplicatesSkipped} duplikatów — te rekordy już istnieją w bazie`);
        }

        if (result.skipped && result.skipped.length > 0) {
          // Hide close_trade_entry and duplicate — these have their own notifications
          const visible = result.skipped.filter((s: any) => s.reason !== 'close_trade_entry' && s.reason !== 'duplicate');
          if (visible.length > 0) {
            const MAX_SHOWN = 10;
            const items = visible.slice(0, MAX_SHOWN);
            const lines = items.map((s: { paperName?: string; reason: string; row: number }) => {
              const name = s.paperName ? `${s.paperName} ` : '';
              const reason = SKIP_REASON_LABELS[s.reason as SkipReason] || s.reason;
              return `${name}(wiersz ${s.row}) — ${reason}`;
            });
            let detail = lines.join('\n');
            if (visible.length > MAX_SHOWN) {
              detail += `\n...i ${visible.length - MAX_SHOWN} więcej`;
            }
            messages.push(`WARN:Pominięto ${visible.length} wierszy:\n${detail}`);
          }
        }

        if (result.warnings && result.warnings.length > 0) {
          for (const w of result.warnings) {
            messages.push(`WARN:${w}`);
          }
        }

        setResults(prev => [...prev, ...messages]);
        queryClient.invalidateQueries();
      } else {
        const messages: string[] = [`Błąd: ${result.error}`];
        if (result.skipped && result.skipped.length > 0) {
          const MAX_SHOWN = 10;
          const items = result.skipped.slice(0, MAX_SHOWN);
          const lines = items.map((s: any) => {
            const name = s.paperName ? `${s.paperName} ` : '';
            const reason = SKIP_REASON_LABELS[s.reason as SkipReason] || s.reason;
            return `${name}(wiersz ${s.row}) — ${reason}`;
          });
          let detail = lines.join('\n');
          if (result.skipped.length > MAX_SHOWN) {
            detail += `\n...i ${result.skipped.length - MAX_SHOWN} więcej`;
          }
          messages.push(`WARN:Pominięte wiersze:\n${detail}`);
        }
        setResults(prev => [...prev, ...messages]);
      }
    } catch (err) {
      setResults(prev => [...prev, `Błąd: ${(err as Error).message}`]);
    } finally {
      setUploading(false);
    }
  }, [queryClient, selectedBroker]);

  const handleMultipleFiles = useCallback(async (files: FileList, type: 'transactions' | 'operations') => {
    for (const file of Array.from(files)) {
      await handleUpload(file, type);
    }
  }, [handleUpload]);

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
      setResults(prev => [...prev, `Dodano kupno spin-off: ${orphan.paperName} (${orphan.missingQuantity} szt. @ 0)`]);
      queryClient.invalidateQueries();
    } catch (err) {
      setResults(prev => [...prev, `Błąd: Nie udało się dodać kupna dla ${orphan.paperName}: ${(err as Error).message}`]);
    } finally {
      setResolving(null);
    }
  }, [queryClient]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import danych</DialogTitle>
          <DialogDescription>
            Prześlij pliki CSV lub XLSX z historią transakcji i operacji gotówkowych.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">Dom maklerski</label>
            <Select value={selectedBroker} onValueChange={(v) => setSelectedBroker(v as BrokerType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.entries(BROKER_LABELS) as [BrokerType, string][]).map(([id, label]) => (
                  <SelectItem key={id} value={id}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">
              {selectedBroker === 'xtb' ? 'Eksport XTB (XLSX)' : 'Transakcje'}
            </label>
            <span className="text-xs text-muted-foreground">Można wybrać wiele plików naraz.</span>
            <Input
              type="file"
              accept={selectedBroker === 'xtb' ? '.xlsx' : selectedBroker === 'auto' ? '.csv,.xlsx' : '.csv'}
              multiple
              disabled={uploading}
              onChange={(e) => {
                const files = e.target.files;
                if (files?.length) handleMultipleFiles(files, 'transactions');
              }}
            />
          </div>

          {(selectedBroker === 'auto' || selectedBroker === 'bossa' || selectedBroker === 'degiro') && (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Operacje gotówkowe</label>
              <span className="text-xs text-muted-foreground">Format Bossa lub DEGIRO Account.</span>
              <Input
                type="file"
                accept=".csv"
                multiple
                disabled={uploading}
                onChange={(e) => {
                  const files = e.target.files;
                  if (files?.length) handleMultipleFiles(files, 'operations');
                }}
              />
            </div>
          )}

          {uploading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Importowanie...
            </div>
          )}

          {results.map((r, i) => {
            const isError = r.startsWith('Błąd');
            const isWarn = r.startsWith('WARN:');
            const displayText = isWarn ? r.slice(5) : r;
            return (
              <div key={i} className="flex items-start gap-2 text-sm">
                {isError ? (
                  <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
                ) : isWarn ? (
                  <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0 mt-0.5" />
                ) : (
                  <CheckCircle className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
                )}
                <span className={isWarn ? 'text-yellow-600 dark:text-yellow-400 whitespace-pre-line' : ''}>{displayText}</span>
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
              setResults([]);
              setOrphanedSells([]);
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
