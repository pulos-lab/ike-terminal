import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: window.location.origin, // same origin — Caddy proxies /api/auth to Express
});

// Convenience exports
export const {
  useSession,
  signIn,
  signUp,
  signOut,
} = authClient;
