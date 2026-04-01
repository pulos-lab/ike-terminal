import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL: window.location.origin, // same origin — Caddy proxies /api/auth to Express
  plugins: [emailOTPClient()],
});

// Convenience exports
export const {
  useSession,
  signIn,
  signUp,
  signOut,
} = authClient;
