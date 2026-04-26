import { Navigate } from 'react-router-dom';
import { useSession } from '@/lib/auth-client';

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
    return <Navigate to="/" replace />;
  }

  if (!session.user.emailVerified) {
    return (
      <Navigate to={`/verify-email?email=${encodeURIComponent(session.user.email)}`} replace />
    );
  }

  return <>{children}</>;
}
