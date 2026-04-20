import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Logo } from '@/components/ui/Logo';

const OTP_LENGTH = 6;
const RESEND_COOLDOWN = 60;

type Step = 'email' | 'reset';

export function ForgotPasswordPage() {
  const navigate = useNavigate();

  // Step state
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');

  // OTP state
  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Password state
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // UI state
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [success, setSuccess] = useState(false);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  // Auto-focus first OTP input when entering reset step
  useEffect(() => {
    if (step === 'reset') {
      inputRefs.current[0]?.focus();
    }
  }, [step]);

  // ── Step 1: Request OTP ──────────────────────────────────────────────────
  async function handleRequestOTP(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;

    setError('');
    setLoading(true);

    try {
      await authClient.emailOtp.requestPasswordReset({ email });
      setStep('reset');
      setResendCooldown(RESEND_COOLDOWN);
    } catch {
      setError('Wystąpił błąd. Spróbuj ponownie.');
    } finally {
      setLoading(false);
    }
  }

  // ── Step 2: Reset password ───────────────────────────────────────────────
  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    const otpCode = otp.join('');

    if (otpCode.length !== OTP_LENGTH) {
      setError('Wpisz pełny 6-cyfrowy kod');
      return;
    }
    if (password.length < 8) {
      setError('Hasło musi mieć minimum 8 znaków');
      return;
    }
    if (password !== confirmPassword) {
      setError('Hasła nie są identyczne');
      return;
    }

    setError('');
    setLoading(true);

    try {
      const { error: err } = await authClient.emailOtp.resetPassword({
        email,
        otp: otpCode,
        password,
      });

      if (err) {
        setError(err.message || 'Nieprawidłowy kod lub kod wygasł');
        return;
      }

      setSuccess(true);
      setTimeout(() => navigate('/login'), 2000);
    } catch {
      setError('Wystąpił błąd. Spróbuj ponownie.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendCooldown > 0) return;

    try {
      await authClient.emailOtp.requestPasswordReset({ email });
      setResendCooldown(RESEND_COOLDOWN);
      setOtp(Array(OTP_LENGTH).fill(''));
      setError('');
      inputRefs.current[0]?.focus();
    } catch {
      setError('Nie udało się wysłać kodu. Spróbuj ponownie.');
    }
  }

  // ── OTP input handlers ───────────────────────────────────────────────────
  function handleOtpChange(index: number, value: string) {
    const digit = value.replace(/\D/g, '').slice(-1);
    const newOtp = [...otp];
    newOtp[index] = digit;
    setOtp(newOtp);
    setError('');

    if (digit && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }

  function handleOtpKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handleOtpPaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;
    const newOtp = Array(OTP_LENGTH).fill('');
    for (let i = 0; i < pasted.length; i++) {
      newOtp[i] = pasted[i];
    }
    setOtp(newOtp);
    if (pasted.length < OTP_LENGTH) {
      inputRefs.current[pasted.length]?.focus();
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4 relative overflow-hidden">
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none"
        style={{
          background: 'radial-gradient(circle, rgba(245,158,11,0.06) 0%, transparent 70%)',
        }}
      />

      <Card className="w-full max-w-md relative z-10">
        <CardHeader className="text-center justify-items-center gap-2 pb-4">
          <Logo size="xl" className="mb-2 mx-auto" />
          <CardTitle className="text-lg font-semibold">Reset hasła</CardTitle>
          <CardDescription>
            {step === 'email'
              ? 'Podaj adres email powiązany z kontem'
              : <>Wysłaliśmy kod na <span className="text-foreground font-medium">{email}</span></>
            }
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === 'email' ? (
            <form onSubmit={handleRequestOTP} className="space-y-4">
              <Input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setError(''); }}
                required
                autoFocus
              />

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Wysyłanie...' : 'Wyślij kod'}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleResetPassword} className="space-y-4">
              <div>
                <label className="block text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-2">
                  Kod weryfikacyjny
                </label>
                <div className="flex justify-center gap-2" onPaste={handleOtpPaste}>
                  {otp.map((digit, index) => (
                    <Input
                      key={index}
                      ref={(el) => { inputRefs.current[index] = el; }}
                      type="text"
                      inputMode="numeric"
                      maxLength={1}
                      value={digit}
                      onChange={(e) => handleOtpChange(index, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(index, e)}
                      disabled={loading || success}
                      className="w-12 h-14 text-center text-2xl font-bold tabular-nums"
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <Input
                  type="password"
                  placeholder="Nowe hasło (min. 8 znaków)"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  required
                  minLength={8}
                  disabled={loading || success}
                />
                <Input
                  type="password"
                  placeholder="Potwierdź hasło"
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
                  required
                  minLength={8}
                  disabled={loading || success}
                />
              </div>

              {error && <p className="text-sm text-destructive text-center">{error}</p>}

              {success && (
                <p className="text-sm text-green-500 text-center">
                  Hasło zmienione! Przekierowywanie na stronę logowania...
                </p>
              )}

              <Button type="submit" className="w-full" disabled={loading || success}>
                {loading ? 'Zmiana hasła...' : 'Zmień hasło'}
              </Button>

              <div className="text-center">
                <p className="text-sm text-muted-foreground">
                  Nie otrzymałeś kodu?{' '}
                  {resendCooldown > 0 ? (
                    <span className="text-muted-foreground/70 tabular-nums">
                      Wyślij ponownie za {resendCooldown}s
                    </span>
                  ) : (
                    <button type="button" onClick={handleResend} className="text-primary font-medium hover:underline">
                      Wyślij ponownie
                    </button>
                  )}
                </p>
              </div>
            </form>
          )}

          <p className="text-center text-sm">
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="text-muted-foreground hover:text-foreground hover:underline transition-colors"
            >
              ← Wróć do logowania
            </button>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
