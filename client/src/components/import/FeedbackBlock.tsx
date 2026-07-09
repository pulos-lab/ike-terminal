import { Loader2, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDate, formatQuantity } from '@/lib/formatters';
import type { QuarantineRecord, OrphanedSell } from 'shared';

export interface FeedbackMessage {
  kind: 'success' | 'warn' | 'error' | 'info';
  text: string;
}

interface Props {
  messages: FeedbackMessage[];
  orphanedSells: OrphanedSell[];
  resolving: string | null;
  onAddSpinoff: (o: OrphanedSell) => void;
  onDismissOrphan: (isin: string) => void;
  lastImportBatch?: string | null;
  onUndo?: () => void;
  undoing?: boolean;
  undoError?: string | null;
  lastImportQuarantine?: QuarantineRecord[] | null;
}

export function FeedbackBlock({
  messages,
  orphanedSells,
  resolving,
  onAddSpinoff,
  onDismissOrphan,
  lastImportBatch,
  onUndo,
  undoing,
  undoError,
  lastImportQuarantine,
}: Props) {
  if (messages.length === 0 && orphanedSells.length === 0 && !lastImportBatch) return null;
  return (
    <>
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

      {orphanedSells.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/5 p-3 space-y-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            <span className="text-sm font-medium text-warning">Wykryto sprzedaż bez kupna</span>
          </div>
          {orphanedSells.map((o) => (
            <div key={o.isin} className="ml-6 space-y-1.5">
              <div className="text-sm">
                <span className="font-medium">{o.paperName}</span>
                <span className="text-muted-foreground"> ({o.ticker})</span>
              </div>
              <div className="text-xs text-muted-foreground">
                Brak kupna dla {formatQuantity(o.missingQuantity)} szt. ({o.currency}) · Pierwsza
                sprzedaż: {formatDate(o.firstSellDate)}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={resolving === o.isin}
                  onClick={() => onAddSpinoff(o)}
                >
                  {resolving === o.isin ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      Dodawanie…
                    </>
                  ) : (
                    'Dodaj kupno — spin-off (cena 0)'
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => onDismissOrphan(o.isin)}
                >
                  Pomiń
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {lastImportBatch && (
        <div className="rounded-md border border-border/50 bg-muted/30 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground truncate">
              ID importu: <span className="font-mono text-foreground/70 text-[10px]">{lastImportBatch}</span>
            </div>
            <Button
              size="sm"
              variant="destructive"
              className="h-7 text-xs shrink-0"
              disabled={undoing}
              onClick={onUndo}
            >
              {undoing ? (
                <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Cofanie…</>
              ) : (
                'Cofnij import'
              )}
            </Button>
          </div>
          {undoError && (
            <p className="text-xs text-destructive">{undoError}</p>
          )}
          {lastImportQuarantine && lastImportQuarantine.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                Kwarantanna ({lastImportQuarantine.length} wierszy):
              </p>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {lastImportQuarantine.map((q, i) => (
                  <div key={i} className="text-[11px] bg-background/50 rounded px-2 py-1 border border-border/30">
                    <span className={q.severity === 'malformed' ? 'text-destructive' : 'text-warning'}>
                      [{q.severity === 'malformed' ? 'STRUKTURA' : 'DANE'}] wiersz {q.rowNumber}:
                    </span>{' '}
                    {q.message}
                    <div className="text-muted-foreground/60 mt-0.5 truncate">
                      surowe: {q.raw.join(';')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
