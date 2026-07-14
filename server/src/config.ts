import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const isProduction = (process.env.NODE_ENV || 'development') === 'production';

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  nodeEnv: process.env.NODE_ENV || 'development',
  dataDir: process.env.DATA_DIR || path.resolve(__dirname, '../../data'),
  csvDir: path.resolve(__dirname, '../..'),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  authSecret: process.env.AUTH_SECRET || 'dev-secret-change-in-production',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || 'TIX Terminal <noreply@tixterminal.app>',
  cache: {
    priceTtl: 60 * 60, // 1h — live prices (was 15min)
    stooqLiveTtl: 4 * 60 * 60, // 4h — Stooq NewConnect (preserve daily quota)
    biznesradarLiveTtl: 15 * 60, // 15min — biznesradar NC (dane i tak opóźnione ~15min)
    historyTtl: 12 * 60 * 60, // 12h — historical data
  },
};

// ── Production safety checks ────────────────────────────────────────────────
if (isProduction) {
  if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32) {
    console.error('FATAL: AUTH_SECRET must be set and at least 32 characters in production.');
    console.error('Generate one with: openssl rand -base64 32');
    process.exit(1);
  }
}
