import { useState } from 'react';
import { toast } from 'sonner';
import { usePortfolio } from '@/lib/portfolio-context';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, SelectSeparator } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Plus, Settings, Trash2 } from 'lucide-react';
import type { PortfolioSettings } from 'shared';

const NEW_PORTFOLIO_VALUE = '__new__';

export function PortfolioSelector() {
  const { portfolios, activeId, activeSettings, activeName, switchPortfolio, createPortfolio, deletePortfolio, purgeData, updateSettings, updateName } = usePortfolio();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);
  const [purging, setPurging] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  // Local settings state for the dialog
  const [editName, setEditName] = useState('');
  const [editSettings, setEditSettings] = useState<PortfolioSettings>({ isIKE: false, isIKZE: false, ikzeIsDG: false, commissionPl: 0, commissionForeign: 0, minCommissionPl: 0, minCommissionForeign: 0 });

  const handleValueChange = (value: string) => {
    if (value === NEW_PORTFOLIO_VALUE) {
      setCreateDialogOpen(true);
      return;
    }
    switchPortfolio(value);
  };

  const [createError, setCreateError] = useState('');

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError('');
    try {
      await createPortfolio(newName.trim());
      setNewName('');
      setCreateDialogOpen(false);
    } catch (err: any) {
      setCreateError(err?.message || 'Nie udało się utworzyć portfela');
    } finally {
      setCreating(false);
    }
  };

  const openSettings = () => {
    setEditName(activeName);
    setEditSettings({ ...activeSettings });
    setSettingsDialogOpen(true);
  };

  const saveSettings = async () => {
    if (editName.trim() && editName.trim() !== activeName) {
      await updateName(editName.trim());
    }
    await updateSettings(editSettings);
    setSettingsDialogOpen(false);
  };

  const handleDelete = async () => {
    const nameSnapshot = activeName;
    setDeleting(true);
    try {
      await deletePortfolio(activeId);
      setDeleteConfirmOpen(false);
      setSettingsDialogOpen(false);
      toast.success(`Portfel „${nameSnapshot}" usunięty`);
    } catch (err: any) {
      toast.error(`Nie udało się usunąć portfela: ${err?.message || 'nieznany błąd'}`);
    } finally {
      setDeleting(false);
    }
  };

  const handlePurge = async () => {
    const nameSnapshot = activeName;
    setPurging(true);
    try {
      await purgeData(activeId);
      setPurgeConfirmOpen(false);
      setSettingsDialogOpen(false);
      toast.success(`Dane portfela „${nameSnapshot}" wyczyszczone`);
    } catch (err: any) {
      toast.error(`Nie udało się wyczyścić danych: ${err?.message || 'nieznany błąd'}`);
    } finally {
      setPurging(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-1">
        <Select value={activeId} onValueChange={handleValueChange}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {portfolios.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
            <SelectSeparator />
            <SelectItem value={NEW_PORTFOLIO_VALUE}>
              <Plus className="h-3 w-3" />
              Nowy portfel
            </SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" className="shrink-0 h-9 w-9" onClick={openSettings}>
          <Settings className="h-4 w-4" />
        </Button>
      </div>

      {/* Create dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nowy portfel</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label className="text-sm text-muted-foreground">Nazwa portfela</label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="np. IKE, IKZE, Maklerski..."
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
          </div>
          {createError && (
            <p className="text-sm text-destructive">{createError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Anuluj
            </Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating ? 'Tworzę...' : 'Utwórz'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Settings dialog */}
      <Dialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ustawienia portfela</DialogTitle>
            <DialogDescription>Skonfiguruj typ portfela i limity wpłat.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">Nazwa portfela</label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>

            <Separator />

            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium">Typ portfela</label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editSettings.isIKE}
                  onChange={(e) => setEditSettings({ ...editSettings, isIKE: e.target.checked })}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                <span className="text-sm">Portfel IKE</span>
                <span className="text-xs text-muted-foreground">— wyświetla limit wpłat IKE</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editSettings.isIKZE}
                  onChange={(e) => setEditSettings({
                    ...editSettings,
                    isIKZE: e.target.checked,
                    ikzeIsDG: e.target.checked ? editSettings.ikzeIsDG : false,
                  })}
                  className="h-4 w-4 rounded border-input accent-primary"
                />
                <span className="text-sm">Portfel IKZE</span>
                <span className="text-xs text-muted-foreground">— wyświetla limit wpłat IKZE</span>
              </label>

              {editSettings.isIKZE && (
                <label className="flex items-center gap-2 cursor-pointer ml-6">
                  <input
                    type="checkbox"
                    checked={editSettings.ikzeIsDG}
                    onChange={(e) => setEditSettings({ ...editSettings, ikzeIsDG: e.target.checked })}
                    className="h-4 w-4 rounded border-input accent-primary"
                  />
                  <span className="text-sm">Działalność gospodarcza</span>
                  <span className="text-xs text-muted-foreground">— wyższy limit IKZE</span>
                </label>
              )}
            </div>

            <Separator />

            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium">Prowizje domyślne</label>

              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">Giełda polska (GPW)</span>
                <div className="flex gap-2 items-center">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.39"
                    value={editSettings.commissionPl || ''}
                    onChange={(e) => setEditSettings({ ...editSettings, commissionPl: parseFloat(e.target.value) || 0 })}
                    className="w-20 text-right"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                  <span className="text-xs text-muted-foreground ml-2">min.</span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="5.00"
                    value={editSettings.minCommissionPl || ''}
                    onChange={(e) => setEditSettings({ ...editSettings, minCommissionPl: parseFloat(e.target.value) || 0 })}
                    className="w-20 text-right"
                  />
                  <span className="text-xs text-muted-foreground">PLN</span>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <span className="text-xs text-muted-foreground">Giełdy zagraniczne</span>
                <div className="flex gap-2 items-center">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.29"
                    value={editSettings.commissionForeign || ''}
                    onChange={(e) => setEditSettings({ ...editSettings, commissionForeign: parseFloat(e.target.value) || 0 })}
                    className="w-20 text-right"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                  <span className="text-xs text-muted-foreground ml-2">min.</span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="1.00"
                    value={editSettings.minCommissionForeign || ''}
                    onChange={(e) => setEditSettings({ ...editSettings, minCommissionForeign: parseFloat(e.target.value) || 0 })}
                    className="w-20 text-right"
                  />
                  <span className="text-xs text-muted-foreground">w wal. giełdy</span>
                </div>
              </div>
            </div>
          </div>

          <DialogFooter className="flex !justify-between">
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive/80 hover:bg-destructive/10"
                onClick={() => setPurgeConfirmOpen(true)}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                Wyczyść dane
              </Button>
              {activeId !== 'default' && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteConfirmOpen(true)}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Usuń portfel
                </Button>
              )}
            </div>
            <div className="flex gap-2 ml-auto">
              <Button variant="outline" onClick={() => setSettingsDialogOpen(false)}>
                Anuluj
              </Button>
              <Button onClick={saveSettings}>
                Zapisz
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Usuń portfel</DialogTitle>
            <DialogDescription>
              Czy na pewno chcesz usunąć portfel &quot;{activeName}&quot;? Wszystkie dane (transakcje, operacje, wpłaty) zostaną trwale usunięte.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              Anuluj
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? 'Usuwam...' : 'Usuń'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Purge data confirmation dialog */}
      <Dialog open={purgeConfirmOpen} onOpenChange={setPurgeConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Wyczyść dane portfela</DialogTitle>
            <DialogDescription>
              Czy na pewno chcesz usunąć wszystkie dane z portfela &quot;{activeName}&quot;? Usunięte zostaną wszystkie transakcje, dywidendy, wpłaty, wymiany walut i historia — zarówno zaimportowane jak i dodane ręcznie. Ustawienia portfela zostaną zachowane.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPurgeConfirmOpen(false)}>
              Anuluj
            </Button>
            <Button variant="destructive" onClick={handlePurge} disabled={purging}>
              {purging ? 'Czyszczę...' : 'Wyczyść wszystko'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
