import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api-client';
import { CheckCircle, AlertCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { type BrokerType, type SkipReason, BROKER_LABELS } from 'shared';

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

        if (result.skipped && result.skipped.length > 0) {
          const MAX_SHOWN = 10;
          const items = result.skipped.slice(0, MAX_SHOWN);
          const lines = items.map((s: { paperName?: string; reason: string; row: number }) => {
            const name = s.paperName ? `${s.paperName} ` : '';
            const reason = SKIP_REASON_LABELS[s.reason as SkipReason] || s.reason;
            return `${name}(wiersz ${s.row}) — ${reason}`;
          });
          let detail = lines.join('\n');
          if (result.skipped.length > MAX_SHOWN) {
            detail += `\n...i ${result.skipped.length - MAX_SHOWN} więcej`;
          }
          messages.push(`WARN:Pominięto ${result.skipped.length} wierszy:\n${detail}`);
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

          {(selectedBroker === 'auto' || selectedBroker === 'bossa') && (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Operacje gotówkowe</label>
              <span className="text-xs text-muted-foreground">Tylko format Bossa.</span>
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

          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              setResults([]);
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
