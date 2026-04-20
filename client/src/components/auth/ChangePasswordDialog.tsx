import { useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { KeyRound } from 'lucide-react';

interface ChangePasswordDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}

export function ChangePasswordDialog({ open: controlledOpen, onOpenChange, hideTrigger }: ChangePasswordDialogProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (v: boolean) => {
    if (isControlled) onOpenChange?.(v);
    else setInternalOpen(v);
  };
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const reset = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setError('');
    setSuccess(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (newPassword.length < 8) {
      setError('Nowe hasło musi mieć min. 8 znaków');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Hasła nie są identyczne');
      return;
    }

    setLoading(true);
    try {
      const { error: authError } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });

      if (authError) {
        setError(authError.message || 'Nie udało się zmienić hasła');
      } else {
        setSuccess(true);
        setTimeout(() => {
          setOpen(false);
          reset();
        }, 1500);
      }
    } catch {
      setError('Błąd połączenia z serwerem');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" title="Zmień hasło">
            <KeyRound className="h-3 w-3" />
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Zmień hasło</DialogTitle>
        </DialogHeader>

        {success ? (
          <p className="text-sm text-green-500 py-4">Hasło zostało zmienione ✓</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="currentPassword">Obecne hasło</label>
              <Input
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="newPassword">Nowe hasło</label>
              <Input
                id="newPassword"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="confirmPassword">Potwierdź nowe hasło</label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Anuluj
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? 'Zmieniam...' : 'Zmień hasło'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
