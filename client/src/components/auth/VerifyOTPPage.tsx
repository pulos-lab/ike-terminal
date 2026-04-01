import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { authClient, useSession } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

const OTP_LENGTH = 6;
const RESEND_COOLDOWN = 60; // seconds

export function VerifyOTPPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const email = searchParams.get('email') || '';

  const { data: session } = useSession();

  const [otp, setOtp] = useState<string[]>(Array(OTP_LENGTH).fill(''));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(RESEND_COOLDOWN);
  const [success, setSuccess] = useState(false);

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Redirect if already verified
  useEffect(() => {
    if (session?.user?.emailVerified) {
      window.location.href = '/';
    }
  }, [session]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  // Auto-focus first input + send OTP if coming from sign-in (unverified user)
  useEffect(() => {
    inputRefs.current[0]?.focus();
    const from = searchParams.get('from');
    if (from === 'signin' && email) {
      // User tried to sign in but email not verified — send OTP
      authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'email-verification',
      }).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // No email → redirect to login
  if (!email) {
    navigate('/login', { replace: true });
    return null;
  }

  function handleInputChange(index: number, value: string) {
    // Allow only digits
    const digit = value.replace(/\D/g, '').slice(-1);
    const newOtp = [...otp];
    newOtp[index] = digit;
    setOtp(newOtp);
    setError('');

    // Auto-focus next input
    if (digit && index < OTP_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all digits filled
    const code = newOtp.join('');
    if (code.length === OTP_LENGTH) {
      handleVerify(code);
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, OTP_LENGTH);
    if (!pasted) return;
    const newOtp = Array(OTP_LENGTH).fill('');
    for (let i = 0; i < pasted.length; i++) {
      newOtp[i] = pasted[i];
    }
    setOtp(newOtp);
    if (pasted.length === OTP_LENGTH) {
      handleVerify(pasted);
    } else {
      inputRefs.current[pasted.length]?.focus();
    }
  }

  async function handleVerify(code?: string) {
    const otpCode = code || otp.join('');
    if (otpCode.length !== OTP_LENGTH) {
      setError('Wpisz pełny 6-cyfrowy kod');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const { error: err } = await authClient.emailOtp.verifyEmail({
        email,
        otp: otpCode,
      });

      if (err) {
        setError(err.message || 'Nieprawidłowy kod. Spróbuj ponownie.');
        setOtp(Array(OTP_LENGTH).fill(''));
        inputRefs.current[0]?.focus();
        return;
      }

      setSuccess(true);
      // Full reload to ensure auth cookies are refreshed
      setTimeout(() => {
        window.location.href = '/';
      }, 500);
    } catch {
      setError('Wystąpił błąd. Spróbuj ponownie.');
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    if (resendCooldown > 0) return;

    try {
      await authClient.emailOtp.sendVerificationOtp({
        email,
        type: 'email-verification',
      });
      setResendCooldown(RESEND_COOLDOWN);
      setOtp(Array(OTP_LENGTH).fill(''));
      setError('');
      inputRefs.current[0]?.focus();
    } catch {
      setError('Nie udało się wysłać kodu. Spróbuj ponownie.');
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <Card className="w-full max-w-md bg-[#111] border-zinc-800">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl text-white">Weryfikacja email</CardTitle>
          <CardDescription className="text-zinc-400">
            Wysłaliśmy 6-cyfrowy kod na<br />
            <span className="text-white font-medium">{email}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* OTP input */}
          <div className="flex justify-center gap-2" onPaste={handlePaste}>
            {otp.map((digit, index) => (
              <Input
                key={index}
                ref={(el) => { inputRefs.current[index] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleInputChange(index, e.target.value)}
                onKeyDown={(e) => handleKeyDown(index, e)}
                disabled={loading || success}
                className="w-12 h-14 text-center text-2xl font-bold bg-[#1a1a1a] border-zinc-700 text-white focus:border-green-500 focus:ring-green-500/20"
              />
            ))}
          </div>

          {error && (
            <p className="text-sm text-red-400 text-center">{error}</p>
          )}

          {success && (
            <p className="text-sm text-green-400 text-center">Email zweryfikowany! Przekierowywanie...</p>
          )}

          {/* Verify button */}
          <Button
            onClick={() => handleVerify()}
            className="w-full bg-green-600 hover:bg-green-700 text-white"
            disabled={loading || success || otp.join('').length !== OTP_LENGTH}
          >
            {loading ? 'Weryfikacja...' : 'Zweryfikuj'}
          </Button>

          {/* Resend */}
          <div className="text-center">
            <p className="text-sm text-zinc-500">
              Nie otrzymałeś kodu?{' '}
              {resendCooldown > 0 ? (
                <span className="text-zinc-600">
                  Wyślij ponownie za {resendCooldown}s
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleResend}
                  className="text-green-400 hover:underline"
                >
                  Wyślij ponownie
                </button>
              )}
            </p>
          </div>

          {/* Back to login */}
          <p className="text-center text-sm text-zinc-500">
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="text-zinc-400 hover:underline"
            >
              Wróć do logowania
            </button>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
