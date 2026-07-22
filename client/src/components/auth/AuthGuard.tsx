import { Navigate } from 'react-router-dom';
import { useSession } from '@/lib/auth-client';
import { isDemoMode } from '@/lib/demo';

/**
 * Wraps protected routes — redirects to /login if not authenticated,
 * or to /verify-email if email is not verified.
 * Shows a loading spinner while the session is being fetched.
 * Wyjątek: tryb demo (aktywny portfel = 'demo') wpuszcza gościa bez sesji —
 * serwer i tak ogranicza taki ruch do GET-ów na portfelu demo.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();

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
    return <Navigate to="/" replace />;
  }

  // Redirect to email verification if not verified
  if (!session.user.emailVerified) {
    return (
      <Navigate to={`/verify-email?email=${encodeURIComponent(session.user.email)}`} replace />
    );
  }

  return <>{children}</>;
}
