import { getAllPortfolios } from './portfolio-registry.js';
import { getDb, closeDb } from './connection.js';
import { seedTickerMap, migrateGpwToYahoo } from './ticker-map-repo.js';

/** Wynik inicjalizacji baz przy starcie — do logu podsumowania i testów. */
export interface StartupInitResult {
  ok: string[];
  failed: { id: string; code?: string; message: string }[];
}

/**
 * Inicjalizacja baz wszystkich portfeli przy starcie serwera (schema + seed
 * ticker_map + migracja GPW→Yahoo).
 *
 * Guard per portfel: jeden uszkodzony/niezapisywalny plik bazy (np. root-owned
 * demo.db → SQLITE_READONLY, incydent 2026-07-23) nie może położyć całego
 * serwera — bez guardu systemd wpadał w pętlę restartów i 502 na całej
 * domenie. Błąd logujemy z id portfela i kodem, portfel pomijamy, reszta
 * startuje normalnie.
 */
export function initAllPortfolioDbs(): StartupInitResult {
  const result: StartupInitResult = { ok: [], failed: [] };
  for (const portfolio of getAllPortfolios()) {
    try {
      getDb(portfolio.id);
      seedTickerMap(portfolio.id);
      const migrated = migrateGpwToYahoo(portfolio.id);
      if (migrated > 0) {
        console.log(`  Migrated ${migrated} GPW tickers to Yahoo in ${portfolio.id}`);
      }
      result.ok.push(portfolio.id);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = (err as Error).message;
      console.error(
        `[startup-init] Portfel ${portfolio.id} pominięty — inicjalizacja bazy nie powiodła się` +
          `${code ? ` [${code}]` : ''}: ${message}`,
      );
      // Nie zostawiamy w cache połączenia do zepsutej bazy: fd otwarty read-only
      // zostaje read-only nawet po naprawie uprawnień na dysku, więc dopiero
      // świeży getDb (np. przy pierwszym żądaniu po chown) ma szansę zadziałać.
      try {
        closeDb(portfolio.id);
      } catch {
        // ignore — połączenie mogło w ogóle nie powstać
      }
      result.failed.push({ id: portfolio.id, code, message });
    }
  }
  return result;
}
