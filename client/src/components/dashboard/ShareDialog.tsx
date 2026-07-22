import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { errorToast } from '@/lib/error-toast';
import type { PortfolioShare, ShareScope, ShareSettingsInput, ShareValidity } from 'shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { ConfirmDeleteDialog } from '@/components/ui/confirm-delete-dialog';
import { api } from '@/lib/api-client';
import { QUERY_KEYS } from '@/lib/query-keys';

const BENCHMARK_OPTIONS = [
  { value: 'none', label: 'Brak' },
  { value: 'sp500', label: 'S&P 500' },
  { value: 'nasdaq', label: 'NASDAQ' },
  { value: 'wig', label: 'WIG' },
  { value: 'wig20', label: 'WIG20' },
  { value: 'mwig40', label: 'mWIG40' },
  { value: 'swig80', label: 'sWIG80' },
];

const VALIDITY_OPTIONS: Array<{ value: ShareValidity; label: string }> = [
  { value: 'indefinite', label: 'Bezterminowo' },
  { value: '7d', label: '7 dni' },
  { value: '30d', label: '30 dni' },
  { value: '90d', label: '90 dni' },
];

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → ms epoch. */
function parseUtc(sqliteDate: string): number {
  return new Date(sqliteDate.replace(' ', 'T') + 'Z').getTime();
}

/** Odtwarza preset ważności z zapisanych dat — expiresAt było liczone z updatedAt. */
function deriveValidity(share: PortfolioShare): ShareValidity {
  if (!share.expiresAt) return 'indefinite';
  const days = Math.round((parseUtc(share.expiresAt) - parseUtc(share.updatedAt)) / 86400000);
  if (days <= 7) return '7d';
  if (days <= 30) return '30d';
  return '90d';
}

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return 'bezterminowo';
  return `wygasa ${new Date(parseUtc(expiresAt)).toLocaleDateString('pl-PL')}`;
}

/** Dwustanowy segmented control (wzorzec MWR/TWR z dashboardu). */
function SegmentedToggle({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="grid grid-cols-2 rounded-md border overflow-hidden">
      {options.map((opt, i) => (
        <Button
          key={opt.value}
          type="button"
          size="sm"
          variant={value === opt.value ? 'secondary' : 'ghost'}
          className={`h-9 text-xs rounded-none ${i > 0 ? 'border-l' : ''}`}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  );
}

interface ShareDialogProps {
  /** Benchmark aktualnie wybrany na dashboardzie — prefill dla nowego linku. */
  currentBenchmark: string;
}

export function ShareDialog({ currentBenchmark }: ShareDialogProps) {
  const [open, setOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [copied, setCopied] = useState(false);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.share,
    queryFn: api.getShare,
    enabled: open,
  });
  const share = data?.share ?? null;

  const [scope, setScope] = useState<ShareScope>('chart');
  const [showAmounts, setShowAmounts] = useState(false);
  const [benchmark, setBenchmark] = useState(currentBenchmark);
  const [validity, setValidity] = useState<ShareValidity>('indefinite');

  // Prefill formularza: istniejący share → jego ustawienia; brak → defaults
  // z dashboardu. Zależność od `open`, żeby reset działał przy ponownym otwarciu.
  useEffect(() => {
    if (!open) return;
    if (share) {
      setScope(share.scope);
      setShowAmounts(share.showAmounts);
      setBenchmark(share.benchmark);
      setValidity(deriveValidity(share));
    } else {
      setScope('chart');
      setShowAmounts(false);
      setBenchmark(currentBenchmark);
      setValidity('indefinite');
    }
  }, [open, share, currentBenchmark]);

  const settings: ShareSettingsInput = { scope, showAmounts, benchmark, validity };

  const createMutation = useMutation({
    mutationFn: () => api.createShare(settings),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.share });
      toast.success('Link utworzony');
    },
    onError: (err) => errorToast('Nie udało się utworzyć linku', err),
  });

  const updateMutation = useMutation({
    mutationFn: () => api.updateShare(settings),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.share });
      toast.success('Zapisano zmiany');
    },
    onError: (err) => errorToast('Nie udało się zapisać zmian', err),
  });

  const revokeMutation = useMutation({
    mutationFn: api.deleteShare,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.share });
      setConfirmRevoke(false);
      toast.success('Link unieważniony');
    },
    onError: (err) => errorToast('Nie udało się unieważnić linku', err),
  });

  const shareUrl = share ? `${window.location.origin}/share/${share.token}` : '';

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success('Link skopiowany do schowka');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Nie udało się skopiować linku');
    }
  }

  const pending = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="text-muted-foreground shrink-0"
          aria-label="Udostępnij portfel"
          title="Udostępnij portfel"
        >
          <Share2 className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Udostępnij portfel</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Ładowanie…</p>
        ) : (
          <div className="space-y-4">
            {share && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Publiczny link</label>
                <div className="flex items-center gap-1.5">
                  <Input readOnly value={shareUrl} className="h-9 text-xs font-mono" />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="outline"
                    onClick={copyUrl}
                    aria-label="Kopiuj link"
                  >
                    {copied ? (
                      <Check className="h-4 w-4 text-success" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Aktywny — {formatExpiry(share.expiresAt)}. Każdy z linkiem widzi portfel bez
                  logowania.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Zakres udostępnienia</label>
              <SegmentedToggle
                value={scope}
                onChange={(v) => setScope(v as ShareScope)}
                options={[
                  { value: 'chart', label: 'Tylko wykres' },
                  { value: 'chart_positions', label: 'Wykres + pozycje' },
                ]}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium">Widoczność kwot</label>
              <SegmentedToggle
                value={showAmounts ? 'amounts' : 'percent'}
                onChange={(v) => setShowAmounts(v === 'amounts')}
                options={[
                  { value: 'percent', label: 'Tylko procenty' },
                  { value: 'amounts', label: 'Pokaż kwoty' },
                ]}
              />
              <p className="text-[11px] text-muted-foreground">
                {showAmounts
                  ? 'Widoczne będą wartości w walucie, ilości akcji i ceny zakupu.'
                  : 'Tylko % zwrotu, udziały i P/L % — bez kwot i ilości akcji.'}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Ważność linku</label>
                <Select value={validity} onValueChange={(v) => setValidity(v as ShareValidity)}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VALIDITY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Benchmark</label>
                <Select value={benchmark} onValueChange={setBenchmark}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BENCHMARK_OPTIONS.map((b) => (
                      <SelectItem key={b.value} value={b.value}>
                        {b.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground -mt-2">
              Benchmark będzie zablokowany w udostępnionym widoku.
            </p>

            {share ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  className="flex-1"
                  onClick={() => updateMutation.mutate()}
                  disabled={pending}
                >
                  {updateMutation.isPending ? 'Zapisywanie…' : 'Zapisz zmiany'}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setConfirmRevoke(true)}
                  disabled={pending || revokeMutation.isPending}
                >
                  Unieważnij link
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                className="w-full"
                onClick={() => createMutation.mutate()}
                disabled={pending}
              >
                {createMutation.isPending ? 'Tworzenie…' : 'Utwórz publiczny link'}
              </Button>
            )}
          </div>
        )}

        <ConfirmDeleteDialog
          open={confirmRevoke}
          onClose={() => setConfirmRevoke(false)}
          onConfirm={() => revokeMutation.mutate()}
          title="Unieważnić publiczny link?"
          description="Link natychmiast przestanie działać dla wszystkich, którym go wysłano. Ponowne udostępnienie utworzy nowy adres."
          confirmLabel="Unieważnij"
          loading={revokeMutation.isPending}
        />
      </DialogContent>
    </Dialog>
  );
}
