import { Navigate, useLocation } from 'react-router-dom';
import { isDeepAppPath, rememberPostLoginPath } from '@/lib/post-login-redirect';
import { useSession } from '@/lib/auth-client';
import { isDemoMode } from '@/lib/demo';

/**
 * Wraps protected routes — redirects to /login (deep link, cel zapamiętany) or
 * to the landing page if not authenticated,
 * or to /verify-email if email is not verified.
 * Shows a loading spinner while the session is being fetched.
 * Wyjątek: tryb demo (aktywny portfel = 'demo') wpuszcza gościa bez sesji —
 * serwer i tak ogranicza taki ruch do GET-ów na portfelu demo.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const location = useLocation();
  const requestedPath = `${location.pathname}${location.search}${location.hash}`;

  if (isPending) {
    return (
      <div
        data-test-id="client__auth__auth-guard-loading"
        className="min-h-screen bg-[#0a0a0a] flex items-center justify-center"
      >
        <div className="text-zinc-500 text-sm">Ładowanie...</div>
      </div>
    );
  }

  if (!session?.user) {
    if (isDemoMode()) return <>{children}</>;
    // Gość z linkiem do konkretnej podstrony chce się zalogować i tam trafić —
    // zapamiętujemy cel i prowadzimy prosto na logowanie. Wejście na sam `/app`
    // zostaje po staremu: strona główna.
    if (isDeepAppPath(requestedPath)) {
      rememberPostLoginPath(requestedPath);
      return <Navigate to="/login" replace />;
    }
    return <Navigate to="/" replace />;
  }

  // Redirect to email verification if not verified
  if (!session.user.emailVerified) {
    // Cel przeżywa też weryfikację e-maila (VerifyOTPPage go konsumuje).
    rememberPostLoginPath(requestedPath);
    return (
      <Navigate to={`/verify-email?email=${encodeURIComponent(session.user.email)}`} replace />
    );
  }

  return <>{children}</>;
}
