import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { QUERY_KEYS, invalidatePortfolio } from '@/lib/query-keys';
import { formatNumber, formatDate, formatQuantity } from '@/lib/formatters';
import { LoadingSpinner, EmptyState } from '@/components/ui/loading-spinner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CcyChip } from '@/components/ui/ccy-chip';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { DeleteTransactionDialog } from './DeleteTransactionDialog';
import { cn } from '@/lib/utils';
import { Search, Info, Pencil, Trash2, Check, X, Loader2 } from 'lucide-react';

interface TxItem {
  id?: number;
  date: string;
  ticker: string;
  isin: string;
  paperName: string;
  quantity: number;
  side: 'K' | 'S';
  price: number;
  value: number;
  commission: number;
  total: number;
  /** Quote currency (waluta notowania papieru) */
  currency: string;
  /** Payment currency (waluta rozliczenia) — może być != currency gdy broker auto-konwertował */
  paymentCurrency?: string;
  category?: 'stock' | 'etf' | 'cfd';
  fxRate?: number;
  source?: string;
  /** Ustawiane przez reconciliation (Bossa wykupy certyfikatów / wezwania skupu) — źródło auto-generowanej sprzedaży. */
  syntheticOrigin?: string;
}

interface EditForm {
  date: string;
  side: 'K' | 'S';
  quantity: string;
  price: string;
  commission: string;
}

export function TradesFeed() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEYS.transactions,
    queryFn: () => api.getTransactions(),
  });

  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>({ date: '', side: 'K', quantity: '', price: '', commission: '0' });
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TxItem | null>(null);

  const rows: TxItem[] = data?.transactions || [];

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(
      (r) =>
        r.ticker?.toLowerCase().includes(q) ||
        r.isin?.toLowerCase().includes(q) ||
        r.paperName?.toLowerCase().includes(q),
    );
  }, [rows, search]);

  // sort descending by date
  const sorted = useMemo(
    () => [...filtered].sort((a, b) => b.date.localeCompare(a.date)),
    [filtered],
  );

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<{ date: string; side: 'K' | 'S'; quantity: number; price: number; commission: number }> }) =>
      api.updateTransaction(id, body),
    onSuccess: () => {
      invalidatePortfolio(queryClient);
      setEditingId(null);
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const startEdit = (tx: TxItem) => {
    if (tx.id == null) return;
    setEditingId(tx.id);
    setEditForm({
      date: tx.date.slice(0, 10),
      side: tx.side,
      quantity: tx.quantity.toString(),
      price: tx.price.toString(),
      commission: tx.commission.toString(),
    });
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setError(null);
  };

  const saveEdit = () => {
    if (editingId == null) return;
    const qty = parseFloat(editForm.quantity);
    const prc = parseFloat(editForm.price);
    const comm = parseFloat(editForm.commission) || 0;
    if (!editForm.date || !qty || qty <= 0 || !prc || prc <= 0) {
      setError('Uzupełnij poprawnie wszystkie pola (data, ilość > 0, cena > 0)');
      return;
    }
    updateMutation.mutate({
      id: editingId,
      body: {
        date: editForm.date,
        side: editForm.side,
        quantity: qty,
        price: prc,
        commission: comm,
      },
    });
  };

  const requestDelete = (tx: TxItem) => {
    if (tx.id == null) return;
    setDeleteTarget(tx);
  };

  if (isLoading) return <LoadingSpinner />;
  if (!rows.length) return <EmptyState message="Brak transakcji." />;

  const isEditValid = editForm.date && parseFloat(editForm.quantity) > 0 && parseFloat(editForm.price) > 0;

  return (
    <TooltipProvider delayDuration={150}>
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Szukaj ticker, ISIN..."
            className="h-8 pl-8 text-xs"
          />
        </div>
        <span className="text-xs text-muted-foreground ml-auto tabular-nums">
          {sorted.length} transakcji
        </span>
      </div>

      {error && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold border-b border-border">
              <th className="text-left py-2 pr-4">Data</th>
              <th className="text-left py-2 pr-4">Ticker</th>
              <th className="text-left py-2 pr-4" title="Waluta rozliczenia — co zapłaciłeś">Waluta zakupu</th>
              <th className="text-left py-2 pr-4">Strona</th>
              <th className="text-right py-2 pr-4">Ilość</th>
              <th className="text-right py-2 pr-4">Cena</th>
              <th className="text-left py-2 pr-4" title="Waluta kwotowania papieru na giełdzie">Kwotowanie</th>
              <th className="text-right py-2 pr-4">Prow.</th>
              <th className="text-right py-2 pr-4">Wartość PLN</th>
              <th className="text-right py-2 w-[90px]"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((tx, i) => {
              const paymentCcy = tx.paymentCurrency || tx.currency;
              const autoFx = paymentCcy !== tx.currency;
              const isEditing = tx.id != null && editingId === tx.id;

              if (isEditing) {
                return (
                  <tr key={tx.id ?? i} className="border-b border-border/50 bg-muted/30">
                    <td className="py-2 pr-4">
                      <Input
                        type="date"
                        value={editForm.date}
                        onChange={(e) => setEditForm({ ...editForm, date: e.target.value })}
                        className="h-8 w-[140px] text-xs"
                      />
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                      {tx.ticker}
                    </td>
                    <td className="py-2 pr-4">
                      <CcyChip ccy={paymentCcy} />
                    </td>
                    <td className="py-2 pr-4">
                      <Select value={editForm.side} onValueChange={(v: 'K' | 'S') => setEditForm({ ...editForm, side: v })}>
                        <SelectTrigger className="h-8 w-[60px]" size="sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="K">K</SelectItem>
                          <SelectItem value="S">S</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="py-2 pr-4">
                      <Input
                        type="number"
                        step="0.0001"
                        min="0"
                        value={editForm.quantity}
                        onChange={(e) => setEditForm({ ...editForm, quantity: e.target.value })}
                        className="h-8 w-[90px] text-right text-xs"
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editForm.price}
                        onChange={(e) => setEditForm({ ...editForm, price: e.target.value })}
                        className="h-8 w-[100px] text-right text-xs"
                      />
                    </td>
                    <td className="py-2 pr-4">
                      <CcyChip ccy={tx.currency} />
                    </td>
                    <td className="py-2 pr-4">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editForm.commission}
                        onChange={(e) => setEditForm({ ...editForm, commission: e.target.value })}
                        className="h-8 w-[80px] text-right text-xs"
                      />
                    </td>
                    <td className="py-2 pr-4" />
                    <td className="py-2 text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={saveEdit}
                          disabled={!isEditValid || updateMutation.isPending}
                          className="text-gain hover:text-gain/80"
                          aria-label="Zapisz"
                        >
                          {updateMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          onClick={cancelEdit}
                          aria-label="Anuluj"
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              }

              return (
              <tr
                key={tx.id ?? i}
                className="border-b border-border/50 hover:bg-accent/40 transition-colors group"
              >
                <td className="py-2.5 pr-4 text-muted-foreground tabular-nums">
                  {formatDate(tx.date)}
                </td>
                <td className="py-2.5 pr-4 font-mono font-semibold">
                  <span className="inline-flex items-center gap-1">
                    {tx.ticker}
                    {tx.syntheticOrigin && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3 w-3 text-amber-500/80 cursor-help shrink-0" aria-label="Transakcja wygenerowana automatycznie" />
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[320px] text-xs leading-relaxed">
                          <div className="font-semibold mb-1">Sprzedaż wygenerowana automatycznie</div>
                          <div className="text-muted-foreground">{tx.syntheticOrigin}</div>
                          <div className="text-muted-foreground mt-1">
                            Brokerowy plik operacji zawierał wpływ z wezwania skupu / wykupu certyfikatu, ale bez informacji o liczbie sprzedanych akcji — wartości policzono na podstawie otwartej pozycji w historii.
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                </td>
                <td className="py-2.5 pr-4">
                  <CcyChip ccy={paymentCcy} />
                  {autoFx && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="ml-1 text-[9px] text-amber-500/80 cursor-help" aria-label="Auto-przewalutowanie">⇋</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
                        Auto-przewalutowanie — broker zamienił {paymentCcy} na {tx.currency} przy realizacji zlecenia.
                        Papier jest notowany w {tx.currency}, Ty zapłaciłeś w {paymentCcy}.
                      </TooltipContent>
                    </Tooltip>
                  )}
                </td>
                <td className="py-2.5 pr-4">
                  <SideChip side={tx.side} />
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums">
                  {formatQuantity(tx.quantity)}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums">
                  {formatNumber(tx.price)}
                </td>
                <td className="py-2.5 pr-4">
                  <CcyChip ccy={tx.currency} />
                </td>
                <td className="py-2.5 pr-4 text-right text-muted-foreground tabular-nums text-xs">
                  {tx.commission > 0 ? formatNumber(tx.commission) : '—'}
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums font-medium">
                  {formatNumber(valuePln(tx))}
                </td>
                <td className="py-2.5 text-right">
                  {tx.id != null && (
                    <div className="inline-flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => startEdit(tx)}
                            aria-label="Edytuj"
                            className="h-6 w-6"
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Edytuj</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => requestDelete(tx)}
                            aria-label="Usuń"
                            className="h-6 w-6 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">Usuń</TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <div className="md:hidden flex flex-col gap-2">
        {sorted.map((tx, i) => {
          const paymentCcy = tx.paymentCurrency || tx.currency;
          const autoFx = paymentCcy !== tx.currency;
          const isEditing = tx.id != null && editingId === tx.id;

          if (isEditing) {
            return (
              <div key={tx.id ?? i} className="flex flex-col gap-2 rounded-xl bg-card border border-primary/40 p-3">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-sm">{tx.ticker}</span>
                  <span className="text-[10px] text-muted-foreground">Edycja</span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground">Data</label>
                    <Input
                      type="date"
                      value={editForm.date}
                      onChange={(e) => setEditForm({ ...editForm, date: e.target.value })}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground">K/S</label>
                    <Select value={editForm.side} onValueChange={(v: 'K' | 'S') => setEditForm({ ...editForm, side: v })}>
                      <SelectTrigger className="h-8" size="sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="K">K</SelectItem>
                        <SelectItem value="S">S</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground">Ilość</label>
                    <Input
                      type="number"
                      step="0.0001"
                      min="0"
                      value={editForm.quantity}
                      onChange={(e) => setEditForm({ ...editForm, quantity: e.target.value })}
                      className="h-8 text-right text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] text-muted-foreground">Cena</label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editForm.price}
                      onChange={(e) => setEditForm({ ...editForm, price: e.target.value })}
                      className="h-8 text-right text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-1 col-span-2">
                    <label className="text-[10px] text-muted-foreground">Prowizja</label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={editForm.commission}
                      onChange={(e) => setEditForm({ ...editForm, commission: e.target.value })}
                      className="h-8 text-right text-xs"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={saveEdit}
                    disabled={!isEditValid || updateMutation.isPending}
                    className="text-gain"
                  >
                    {updateMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Zapisz
                  </Button>
                  <Button size="xs" variant="ghost" onClick={cancelEdit}>
                    <X className="h-3 w-3" />
                    Anuluj
                  </Button>
                </div>
              </div>
            );
          }

          return (
          <div key={tx.id ?? i} className="flex items-center gap-3 rounded-xl bg-card border border-border p-3">
            <SideChip side={tx.side} size="lg" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="font-mono font-semibold text-sm">{tx.ticker}</span>
                {tx.syntheticOrigin && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3 w-3 text-amber-500/80 cursor-help shrink-0" aria-label="Transakcja wygenerowana automatycznie" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[280px] text-xs leading-relaxed">
                      <div className="font-semibold mb-1">Sprzedaż auto-wygenerowana</div>
                      <div className="text-muted-foreground">{tx.syntheticOrigin}</div>
                    </TooltipContent>
                  </Tooltip>
                )}
                {autoFx ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-0.5 text-[9px] text-muted-foreground cursor-help">
                        <CcyChip ccy={paymentCcy} />
                        <span className="text-amber-500/80">⇋</span>
                        <CcyChip ccy={tx.currency} />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[240px] text-xs leading-relaxed">
                      Auto-przewalutowanie — broker zamienił {paymentCcy} na {tx.currency} przy realizacji zlecenia.
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <CcyChip ccy={tx.currency} />
                )}
              </div>
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {formatDate(tx.date)} · {formatQuantity(tx.quantity)} × {formatNumber(tx.price)}
              </p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-sm font-semibold tabular-nums">
                {formatNumber(valuePln(tx))} zł
              </p>
              <p className="text-[10px] text-muted-foreground tabular-nums">
                {formatNumber(tx.value)} {tx.currency}
              </p>
            </div>
            {tx.id != null && (
              <div className="flex flex-col gap-1">
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => startEdit(tx)}
                  aria-label="Edytuj"
                  className="h-6 w-6"
                >
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => requestDelete(tx)}
                  aria-label="Usuń"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
          );
        })}
      </div>

      <DeleteTransactionDialog
        target={deleteTarget && deleteTarget.id != null ? {
          id: deleteTarget.id,
          date: deleteTarget.date,
          ticker: deleteTarget.ticker,
          isin: deleteTarget.isin,
          side: deleteTarget.side,
          quantity: deleteTarget.quantity,
          price: deleteTarget.price,
          commission: deleteTarget.commission,
          currency: deleteTarget.currency,
          syntheticOrigin: deleteTarget.syntheticOrigin,
        } : null}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
    </TooltipProvider>
  );
}

function valuePln(tx: TxItem): number {
  if (tx.currency === 'PLN') return tx.total;
  if (tx.fxRate && tx.fxRate > 0) return tx.total * tx.fxRate;
  return tx.total; // fallback — we do not always have fx, best-effort
}

function SideChip({ side, size = 'sm' }: { side: 'K' | 'S'; size?: 'sm' | 'lg' }) {
  const isBuy = side === 'K';
  const base = isBuy
    ? 'bg-gain/15 text-gain'
    : 'bg-loss/15 text-loss';
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center rounded-md font-bold',
        base,
        size === 'lg' ? 'w-8 h-8 text-sm' : 'w-6 h-5 text-[11px]',
      )}
    >
      {side}
    </span>
  );
}
