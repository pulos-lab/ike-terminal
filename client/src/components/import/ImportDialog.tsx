import { useState, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload, FileUp, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

type ImportType = 'transactions' | 'operations';
type BrokerType = 'auto' | 'bossa' | 'mbank' | 'degiro' | 'xtb';

interface ImportResult {
  success?: boolean;
  error?: string;
  transactionsImported?: number;
  operationsImported?: number;
  detectedSource?: string;
  tickersResolved?: number;
  tickersUnresolved?: string[];
  skipped?: Array<{ row: number; reason: string; paperName?: string }>;
}

const BROKER_OPTIONS: { value: BrokerType; label: string }[] = [
  { value: 'auto', label: 'Auto-detekcja' },
  { value: 'bossa', label: 'Bossa' },
  { value: 'mbank', label: 'mBank eMakler' },
  { value: 'degiro', label: 'DEGIRO' },
  { value: 'xtb', label: 'XTB' },
];

export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [importType, setImportType] = useState<ImportType>('transactions');
  const [broker, setBroker] = useState<BrokerType>('auto');
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const reset = () => {
    setFile(null);
    setResult(null);
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  };

  const handleClose = (open: boolean) => {
    if (!open) reset();
    onOpenChange(open);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    setResult(null);

    if (selected?.name.toLowerCase().endsWith('.xlsx')) {
      setBroker('xtb');
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    setResult(null);

    try {
      const res = importType === 'transactions'
        ? await api.uploadTransactions(file, broker)
        : await api.uploadOperations(file);

      setResult(res);

      if (res.success) {
        queryClient.invalidateQueries({ queryKey: ['import'] });
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
        queryClient.invalidateQueries({ queryKey: ['positions'] });
        queryClient.invalidateQueries({ queryKey: ['metrics'] });
        queryClient.invalidateQueries({ queryKey: ['deposits'] });
        queryClient.invalidateQueries({ queryKey: ['cash-flow'] });
        queryClient.invalidateQueries({ queryKey: ['dividends'] });
      }
    } catch (err) {
      setResult({ success: false, error: err instanceof Error ? err.message : 'Nieznany błąd' });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Import danych
          </DialogTitle>
          <DialogDescription>
            Zaimportuj transakcje lub operacje z pliku CSV/XLSX.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              variant={importType === 'transactions' ? 'default' : 'outline'}
              size="sm"
              onClick={() => { setImportType('transactions'); reset(); }}
            >
              Transakcje
            </Button>
            <Button
              variant={importType === 'operations' ? 'default' : 'outline'}
              size="sm"
              onClick={() => { setImportType('operations'); reset(); }}
            >
              Operacje gotówkowe
            </Button>
          </div>

          {importType === 'transactions' && (
            <div>
              <label className="text-sm font-medium mb-1 block">Dom maklerski</label>
              <Select value={broker} onValueChange={(v) => setBroker(v as BrokerType)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BROKER_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div>
            <label className="text-sm font-medium mb-1 block">Plik</label>
            <div
              className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xlsx"
                className="hidden"
                onChange={handleFileChange}
              />
              {file ? (
                <div className="flex items-center justify-center gap-2 text-sm">
                  <FileUp className="h-4 w-4 text-primary" />
                  <span className="font-medium">{file.name}</span>
                  <span className="text-muted-foreground">({(file.size / 1024).toFixed(1)} KB)</span>
                </div>
              ) : (
                <div className="text-muted-foreground text-sm">
                  <FileUp className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  Kliknij aby wybrać plik CSV lub XLSX
                </div>
              )}
            </div>
          </div>

          {result && (
            <div className={`rounded-lg p-3 text-sm ${result.success ? 'bg-green-500/10 text-green-700 dark:text-green-400' : 'bg-destructive/10 text-destructive'}`}>
              {result.success ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-medium">
                    <CheckCircle2 className="h-4 w-4" />
                    Import zakończony
                  </div>
                  {result.transactionsImported !== undefined && result.transactionsImported > 0 && (
                    <p>Zaimportowano {result.transactionsImported} transakcji{result.detectedSource ? ` (${result.detectedSource})` : ''}</p>
                  )}
                  {result.operationsImported !== undefined && result.operationsImported > 0 && (
                    <p>Zaimportowano {result.operationsImported} operacji</p>
                  )}
                  {result.tickersUnresolved && result.tickersUnresolved.length > 0 && (
                    <p className="text-yellow-600 dark:text-yellow-400">
                      Nierozpoznane: {result.tickersUnresolved.join(', ')}
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{result.error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            {result?.success ? 'Zamknij' : 'Anuluj'}
          </Button>
          {!result?.success && (
            <Button onClick={handleUpload} disabled={!file || uploading}>
              {uploading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Importuj
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
