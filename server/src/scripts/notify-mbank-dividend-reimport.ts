/* eslint-disable no-console */
/**
 * Zakłada prośbę o ponowne wgranie historii finansowej mBanku w portfelach,
 * których dotyczy błąd naprawiony w PR #224.
 *
 * Parser gubił po cichu wiersze, w których kwota stała w dalszej kolumnie niż
 * deklaruje nagłówek — w praktyce WSZYSTKIE dywidendy z historii finansowej.
 * W odróżnieniu od poprawki kursów (fix-mbank-fx-commission.ts) tego NIE DA SIĘ
 * naprawić skryptem: zgubionych wierszy nie ma w bazie, więc nie ma czego
 * przeliczyć. Jedynym wyjściem jest ponowne wgranie pliku przez użytkownika.
 *
 * Adresaci: portfele, które mają JAKIEKOLWIEK operacje gotówkowe ze źródła
 * `mbank` — czyli te, do których historia finansowa faktycznie trafiła.
 * Portfele z samymi transakcjami nie dostają nic, bo nie miały czego zgubić.
 *
 * Idempotentny: `reimport_notices` ma UNIQUE(source, reason), więc ponowne
 * uruchomienie nie zdubluje wpisu ani nie wskrzesi odłożonej prośby.
 *
 * Usage:
 *   cd server && npx tsx src/scripts/notify-mbank-dividend-reimport.ts         # dry-run
 *   cd server && npx tsx src/scripts/notify-mbank-dividend-reimport.ts --apply
 *
 * Production (po deployu #224):
 *   ssh root@tixterminal.app 'cd /opt/ike-terminal/APP/server && DATA_DIR=/opt/ike-terminal/data node dist/scripts/notify-mbank-dividend-reimport.js --apply'
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { addReimportNotice } from '../db/reimport-notices-repo.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db', 'import_profiles.db']);

const NOTICE = {
  source: 'mBank eMakler',
  reason: 'dywidendy z historii finansowej mogły nie zostać zaimportowane',
  detail:
    'Poprawiliśmy błąd, przez który wiersze dywidend z pliku „historia finansowa" ' +
    'były pomijane. Zgubionych wpisów nie da się odtworzyć z bazy — wgraj ten plik ' +
    'ponownie, a brakujące dywidendy się uzupełnią. Duplikaty są wykrywane automatycznie.',
};

function main(): void {
  const apply = process.argv.includes('--apply');
  const files = readdirSync(config.dataDir).filter(
    (f) => f.endsWith('.db') && !EXCLUDED.has(basename(f)),
  );

  let affected = 0;
  for (const file of files) {
    const portfolioId = basename(file, '.db');
    let count = 0;
    try {
      const row = getDb(portfolioId)
        .prepare(`SELECT COUNT(*) AS n FROM cash_operations WHERE source = 'mbank'`)
        .get() as { n: number };
      count = row.n;
    } catch {
      continue;
    }
    if (count === 0) continue;

    affected++;
    console.log(`${portfolioId}: ${count} operacji mBanku → prośba o re-import`);
    if (apply) {
      const added = addReimportNotice(portfolioId, NOTICE);
      console.log(`   ${added ? 'ZAŁOŻONA' : 'już istniała — bez zmian'}`);
    }
  }

  console.log(
    `\n${apply ? 'Przetworzone' : 'Do przetworzenia (dry-run)'}: ${affected} portfeli` +
      (affected === 0 ? ' — nikt nie importował historii finansowej mBanku' : ''),
  );
  if (!apply && affected > 0) console.log('Uruchom ponownie z --apply, żeby założyć prośby.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
