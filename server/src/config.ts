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
    // UWAGA: `priceTtl` jest jednocześnie `stdTTL` NodeCache, czyli domyślnym TTL
    // dla każdego `setCached` bez jawnego drugiego argumentu. Zmiana tej wartości
    // dotyka WSZYSTKICH takich wpisów — ceny live mają własną tabelę `quoteTtl`.
    priceTtl: 60 * 60, // 1h — domyślny TTL cache'u (fallback dla cen bez stanu rynku)
    stooqLiveTtl: 4 * 60 * 60, // 4h — Stooq NewConnect (preserve daily quota)
    biznesradarLiveTtl: 15 * 60, // 15min — biznesradar NC (dane i tak opóźnione ~15min)
    stockwatchBondsTtl: 60 * 60, // 1h — zbiorcza mapa notowań Catalyst (obligacje handlują rzadko)
    historyTtl: 12 * 60 * 60, // 12h — historical data
    /**
     * TTL ceny live zależny od stanu rynku (`marketState` z v7 quote).
     *
     * Stała godzina była złym kompromisem w obie strony: w trakcie sesji cena na
     * ekranie miała do 75 min poślizgu (TTL + ~15 min opóźnienia darmowego
     * Yahoo), a po zamknięciu co godzinę leciała fala requestów po kurs, który
     * nie może się już zmienić.
     */
    quoteTtl: {
      regular: 15 * 60, // sesja — podłoga wynika z opóźnienia Yahoo, niżej to sam koszt
      prePost: 30 * 60, // pre/post-market — handel cienki
      closed: 6 * 60 * 60, // po sesji kurs się nie zmienia
      cap: 12 * 60 * 60, // twardy sufit — weekend nie może zamrozić danych na dobę+
      unknown: 60 * 60, // brak marketState (fallback v8) — zachowawczo jak dotąd
    },
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
