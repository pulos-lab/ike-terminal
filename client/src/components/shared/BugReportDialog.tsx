import { useState } from 'react';
import { Bug, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api-client';

const CATEGORIES = [
  { value: 'import', label: 'Import danych' },
  { value: 'wykres', label: 'Wykres / Dashboard' },
  { value: 'portfel', label: 'Portfel / Pozycje' },
  { value: 'transakcje', label: 'Transakcje' },
  { value: 'dywidendy', label: 'Dywidendy' },
  { value: 'waluty', label: 'Waluty / FX' },
  { value: 'inne', label: 'Inne' },
];

interface BugReportDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}

export function BugReportDialog({ open: controlledOpen, onOpenChange, hideTrigger }: BugReportDialogProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (v: boolean) => {
    if (isControlled) onOpenChange?.(v);
    else setInternalOpen(v);
  };
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!category || description.trim().length < 5) return;

    setLoading(true);
    setError('');

    try {
      await api.submitBugReport({ category, description: description.trim() });
      setSuccess(true);
      setTimeout(() => {
        setOpen(false);
        setSuccess(false);
        setCategory('');
        setDescription('');
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nie udało się wysłać zgłoszenia');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setSuccess(false); setError(''); } }}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" title="Zgłoś błąd">
            <Bug className="h-3 w-3" />
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Zgłoś błąd</DialogTitle>
        </DialogHeader>

        {success ? (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle className="h-10 w-10 text-green-500" />
            <p className="text-sm text-muted-foreground">Dziękujemy za zgłoszenie!</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Kategoria</label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger>
                  <SelectValue placeholder="Wybierz kategorię..." />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(c => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Opis problemu</label>
              <textarea
                className="w-full min-h-[100px] rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                placeholder="Opisz co się stało, jakie kroki doprowadziły do błędu..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                required
                minLength={5}
              />
              <p className="text-[10px] text-muted-foreground text-right">{description.length}/2000</p>
            </div>

            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={loading || !category || description.trim().length < 5}
            >
              {loading ? 'Wysyłanie...' : 'Wyślij zgłoszenie'}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
