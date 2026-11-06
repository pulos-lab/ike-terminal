import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      shared: path.resolve(__dirname, '../shared/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Import (bulkImport) nie może uderzać do obligacje.pl w testach — pre-pass katalogu
    // obligacji wyłączony; jego logikę pokrywają dedykowane testy bond-catalog.
    // Batch cen (yahoo-quotes) uderza do Yahoo z wnętrza computeOpenPositions,
    // gdzie testy mockują dopiero fetchYahooPrice — bez tego wyłącznika każdy
    // test silnika robiłby realny request. Sam batch pokrywa yahoo-quotes.test.ts.
    // OpenFIGI (Strategy 1b resolvera) — testy resolvera mockują Yahoo, ale nie
    // fetch; bez wyłącznika każdy ISIN z pustym `searchYahoo` szedłby do sieci.
    // Testy OpenFIGI włączają źródło lokalnie i wstrzykują fetch.
    env: { BOND_CATALOG_ONDEMAND: 'off', YAHOO_BATCH_QUOTES: 'off', OPENFIGI: 'off' },
  },
});
