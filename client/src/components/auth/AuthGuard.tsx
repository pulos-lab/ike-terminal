import { Navigate } from 'react-router-dom';
import { useSession } from '@/lib/auth-client';

/**
 * Wraps protected routes — redirects to /login if not authenticated.
 * Shows a loading spinner while the session is being fetched.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="text-zinc-500 text-sm">Ładowanie...</div>
      </div>
    );
  }

  if (!session?.user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
