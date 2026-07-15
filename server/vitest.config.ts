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
    env: { BOND_CATALOG_ONDEMAND: 'off' },
  },
});
