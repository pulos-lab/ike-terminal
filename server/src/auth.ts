import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import Database from 'better-sqlite3';
import path from 'path';
import { Resend } from 'resend';
import { config, isProduction } from './config.js';

// ── Resend email client (for OTP verification) ────────────────────────────
const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

// ── Auth database (separate from portfolio databases) ───────────────────────
const authDbPath = path.join(config.dataDir, 'auth.db');
const db = new Database(authDbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create auth tables if they don't exist (Better Auth core schema)
db.exec(`
  CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    emailVerified INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS "session" (
    id TEXT PRIMARY KEY,
    expiresAt TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    ipAddress TEXT,
    userAgent TEXT,
    userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS "account" (
    id TEXT PRIMARY KEY,
    accountId TEXT NOT NULL,
    providerId TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    accessToken TEXT,
    refreshToken TEXT,
    idToken TEXT,
    accessTokenExpiresAt TEXT,
    refreshTokenExpiresAt TEXT,
    scope TEXT,
    password TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS "verification" (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    expiresAt TEXT NOT NULL,
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS "bug_reports" (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    userEmail TEXT,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    userAgent TEXT,
    url TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/** Get the auth database instance (for bug reports, admin queries) */
export function getAuthDb() {
  return db;
}

/** Close the auth database (called during graceful shutdown) */
export function closeAuthDb(): void {
  db.close();
}

// ── Better Auth configuration ───────────────────────────────────────────────
export const auth = betterAuth({
  database: db,
  secret: config.authSecret,
  baseURL: isProduction ? config.corsOrigin : `http://localhost:${config.port}`,

  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 300, // 5 minutes
      sendVerificationOnSignUp: true,
      overrideDefaultEmailVerification: true,
      async sendVerificationOTP({ email, otp, type }) {
        if (!resend) {
          console.log(`[DEV] OTP for ${email} (${type}): ${otp}`);
          return;
        }
        const subjectMap: Record<string, string> = {
          'email-verification': `${otp} — Twój kod weryfikacyjny`,
          'forget-password': `${otp} — Reset hasła`,
          'sign-in': `${otp} — Kod logowania`,
          'change-email': `${otp} — Zmiana adresu email`,
        };
        await resend.emails.send({
          from: config.emailFrom,
          to: email,
          subject: subjectMap[type] || `${otp} — Kod weryfikacyjny TIX Terminal`,
          html: `
            <div style="font-family: system-ui, sans-serif; max-width: 400px; margin: 0 auto; padding: 32px;">
              <h2 style="color: #16a34a; margin: 0 0 24px;">TIX Terminal</h2>
              <p style="color: #333; margin: 0 0 16px;">Twój kod weryfikacyjny:</p>
              <div style="background: #f4f4f5; border-radius: 8px; padding: 16px; text-align: center; margin: 0 0 16px;">
                <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #111;">${otp}</span>
              </div>
              <p style="color: #666; font-size: 14px; margin: 0;">Kod wygasa za 5 minut. Jeśli nie prosiłeś o ten kod, zignoruj tę wiadomość.</p>
            </div>
          `,
        });
      },
    }),
  ],

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
  },

  socialProviders: {
    google: {
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      enabled: !!(config.googleClientId && config.googleClientSecret),
    },
  },

  trustedOrigins: isProduction
    ? [config.corsOrigin]
    : ['http://localhost:5173', 'http://localhost:5174'],

  session: {
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
    },
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  advanced: {
    cookiePrefix: 'tix',
    useSecureCookies: isProduction,
    crossSubDomainCookies: {
      enabled: false,
    },
  },
});

// ── Auth types ──────────────────────────────────────────────────────────────
export type AuthSession = typeof auth.$Infer.Session;
export type AuthUser = typeof auth.$Infer.Session.user;
