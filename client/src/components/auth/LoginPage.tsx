import { useState, useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { signIn, signUp, useSession } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

export function LoginPage() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    fetch('/api/health').then(r => r.json())
      .then(data => setGoogleEnabled(data.googleAuthEnabled === true))
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isRegister) {
        const { error: err } = await signUp.email({
          email,
          password,
          name: name || email.split('@')[0],
        });
        if (err) {
          setError(err.message || 'Błąd rejestracji');
          return;
        }
        // Redirect to OTP verification page after registration
        navigate(`/verify-email?email=${encodeURIComponent(email)}`);
        return;
      } else {
        const { error: err } = await signIn.email({ email, password });
        if (err) {
          // If email not verified, redirect to verification page and trigger OTP send
          if (err.code === 'EMAIL_NOT_VERIFIED') {
            navigate(`/verify-email?email=${encodeURIComponent(email)}&from=signin`);
            return;
          }
          setError(err.message || 'Nieprawidłowy email lub hasło');
          return;
        }
      }
      // Full reload to ensure auth cookies are picked up by all components
      window.location.href = '/';
    } catch {
      setError('Wystąpił błąd. Spróbuj ponownie.');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleSignIn() {
    await signIn.social({ provider: 'google', callbackURL: '/' });
  }

  // Redirect to dashboard if already logged in
  if (!isPending && session?.user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
      <Card className="w-full max-w-md bg-[#111] border-zinc-800">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl text-white">TIX Terminal</CardTitle>
          <CardDescription className="text-zinc-400">
            {isRegister ? 'Utwórz nowe konto' : 'Zaloguj się do portfela'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Google SSO — only shown when configured */}
          {googleEnabled && (
            <>
              <Button
                variant="outline"
                className="w-full border-zinc-700 text-white hover:bg-zinc-800"
                onClick={handleGoogleSignIn}
                type="button"
              >
                <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                Kontynuuj przez Google
              </Button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-zinc-700" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-[#111] px-2 text-zinc-500">lub</span>
                </div>
              </div>
            </>
          )}

          {/* Email/password form */}
          <form onSubmit={handleSubmit} className="space-y-3">
            {isRegister && (
              <Input
                type="text"
                placeholder="Imię (opcjonalne)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="bg-[#1a1a1a] border-zinc-700 text-white placeholder:text-zinc-500"
              />
            )}
            <Input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="bg-[#1a1a1a] border-zinc-700 text-white placeholder:text-zinc-500"
            />
            <Input
              type="password"
              placeholder="Hasło"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="bg-[#1a1a1a] border-zinc-700 text-white placeholder:text-zinc-500"
            />

            {error && (
              <p className="text-sm text-red-400">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full bg-green-600 hover:bg-green-700 text-white"
              disabled={loading}
            >
              {loading
                ? 'Ładowanie...'
                : isRegister
                  ? 'Zarejestruj się'
                  : 'Zaloguj się'}
            </Button>
          </form>

          <p className="text-center text-sm text-zinc-500">
            {isRegister ? 'Masz już konto?' : 'Nie masz konta?'}{' '}
            <button
              type="button"
              onClick={() => { setIsRegister(!isRegister); setError(''); }}
              className="text-green-400 hover:underline"
            >
              {isRegister ? 'Zaloguj się' : 'Zarejestruj się'}
            </button>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
