/**
 * Seed współdzielonego portfela demo (landing → "Wypróbuj demo").
 *
 * Idempotentny: wipe + insert — można odpalać wielokrotnie (odświeżenie danych).
 * Uruchomienie:
 *   dev:  npm run seed:demo -w server
 *   prod: DATA_DIR=/opt/ike-terminal/data node server/dist/scripts/seed-demo.js
 *         (bez DATA_DIR skrypt zapisze do złego katalogu — dlatego logujemy go
 *         na starcie i wymagamy jawnego potwierdzenia ścieżki wzrokiem)
 */
import { config } from '../config.js';
import { ensureDemoPortfolio, updatePortfolio } from '../db/portfolio-registry.js';
import { getDb } from '../db/connection.js';
import { purgeAllData, insertTransactions } from '../db/transactions-repo.js';
import { insertOperations } from '../db/operations-repo.js';
import { upsertTickerMapEntry } from '../db/ticker-map-repo.js';
import { buildHistoryView, buildPositionsView } from '../services/portfolio-views.js';
import { DEMO_PORTFOLIO_ID } from 'shared';
import {
  DEMO_PORTFOLIO_NAME,
  DEMO_SETTINGS,
  DEMO_TICKERS,
  DEMO_TRANSACTIONS,
  DEMO_OPERATIONS,
} from './demo-data.js';

async function main() {
  console.log(`[seed-demo] DATA_DIR = ${config.dataDir}`);

  const portfolio = ensureDemoPortfolio(DEMO_PORTFOLIO_NAME);
  updatePortfolio(portfolio.id, { settings: DEMO_SETTINGS });
  console.log(`[seed-demo] rejestr: portfel '${portfolio.id}' (${portfolio.name})`);

  const db = getDb(DEMO_PORTFOLIO_ID);

  // Wipe: purgeAllData czyści transactions/cash_operations/ticker_map/snapshots/
  // manual_positions/price_cache; reszta tabel per-portfel ręcznie.
  purgeAllData(DEMO_PORTFOLIO_ID);
  for (const table of ['stock_splits', 'spin_offs', 'option_contracts', 'import_quarantine']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  console.log('[seed-demo] wyczyszczono dane portfela demo');

  for (const entry of DEMO_TICKERS) {
    upsertTickerMapEntry(entry, DEMO_PORTFOLIO_ID, true);
  }
  console.log(`[seed-demo] ticker_map: ${DEMO_TICKERS.length} instrumentów`);

  const txCount = insertTransactions(DEMO_TRANSACTIONS, DEMO_PORTFOLIO_ID);
  const opCount = insertOperations(DEMO_OPERATIONS, DEMO_PORTFOLIO_ID);
  console.log(`[seed-demo] wstawiono ${txCount} transakcji i ${opCount} operacji gotówkowych`);

  // Pre-warm + smoke: liczy historię (zapełnia price_history.db) i pozycje
  // (ceny live → NodeCache). Błąd tutaj = demo nie wyrenderuje się poprawnie.
  console.log('[seed-demo] pre-warm: buildHistoryView(wig) + buildPositionsView…');
  const history = await buildHistoryView(DEMO_PORTFOLIO_ID, 'wig');
  const positions = await buildPositionsView(DEMO_PORTFOLIO_ID);
  const last = history.history[history.history.length - 1];
  console.log(
    `[seed-demo] OK: ${history.history.length} punktów historii (ostatni: ${last?.date}, ` +
      `wartość ${last?.portfolioValue?.toFixed(0)} PLN), ${positions.positions.length} pozycji otwartych`,
  );
  if (positions.positions.length !== 6) {
    console.warn(
      `[seed-demo] UWAGA: oczekiwano 6 pozycji otwartych (CDR/PKO/PZU/VWCE/AAPL/MSFT), ` +
        `jest ${positions.positions.length} — sprawdź resolving/ceny`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed-demo] BŁĄD:', err);
    process.exit(1);
  });
