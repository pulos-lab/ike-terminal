/* eslint-disable no-console */
/**
 * One-shot: księguje wiersze XTB ze skrzynki „Do wyjaśnienia" odrzucone przez
 * komentarz z tickerem ("OPEN BUY DIG.PL 1 @ 308.80", format od ~10.2026).
 * Poprawka parsera (PR #267) działa tylko na nowe importy; plików nie
 * przechowujemy, więc transakcje odtwarzamy z surowych wierszy kwarantanny.
 * Logika: `services/xtb-quarantine-reprocess.ts`.
 *
 * Bezpieczeństwo:
 *   - Domyślnie DRY-RUN; --apply zapisuje, --only=ID ogranicza do portfela
 *   - Dedup jak przy imporcie — transakcja dodana już ręcznie się nie zdubluje
 *   - Idempotentny: wiersze po zapisie mają status 'resolved', drugi przebieg = 0
 *   - Wiersz, z którego parser nie wyciągnie dokładnie jednej transakcji,
 *     zostaje w skrzynce i jest raportowany
 *   - Po --apply: rozpoznanie nowych tickerów (sieć) + uzgodnienie walut notowania,
 *     jak po zwykłym imporcie
 *
 * Usage (lokalnie):
 *   npm run fix:xtb-comment-ticker-quarantine -w server              # dry-run
 *   npm run fix:xtb-comment-ticker-quarantine -w server -- --apply
 *
 * Production (tylko dist, DATA_DIR OBOWIĄZKOWY, proces jako właściciel data/):
 *   ssh root@tixterminal.app 'cd /opt/ike-terminal/app && sudo -u ike-terminal DATA_DIR=/opt/ike-terminal/data node server/dist/scripts/fix-xtb-comment-ticker-quarantine.js'
 *   # … --apply, potem: systemctl restart ike-terminal (memo historii jest in-memory)
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { reprocessXtbQuarantine } from '../services/xtb-quarantine-reprocess.js';
import { resolveUnknownIsins } from '../services/isin-resolver.js';
import { reconcileQuoteCurrencies } from '../services/quote-currency-reconciler.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db', 'import_profiles.db']);

function listPortfolios(): string[] {
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
  const portfolios = only ? [only] : listPortfolios();

  console.log(`Skanowanie ${portfolios.length} portfela/i w ${config.dataDir}`);
  console.log(`Tryb: ${apply ? 'APPLY (zapisuje zmiany)' : 'DRY-RUN (tylko podgląd)'}\n`);

  let totalRows = 0;
  let totalErrors = 0;
  let totalInserted = 0;
  let totalResolved = 0;
  for (const pid of portfolios) {
    let result;
    try {
      result = await reprocessXtbQuarantine(pid, { apply });
    } catch (err: any) {
      // Baza bez tabeli import_quarantine (stary portfel) albo uszkodzona.
      if (!/no such table/.test(err.message)) console.error(`  ${pid}: BŁĄD — ${err.message}`);
      continue;
    }
    if (result.items.length === 0) continue;
    totalRows += result.items.length;

    console.log(`── ${pid}: ${result.items.length} wiersz(y)`);
    for (const it of result.items) {
      const t = it.tx;
      const line = t
        ? `${t.date.slice(0, 10)} ${t.side} ${pad(t.paperName, 12)} ${pad(String(t.quantity), 8)} @ ${pad(String(t.price), 10)} = ${t.total} ${t.currency}${t.fxRate ? ` (fx ${t.fxRate})` : ''} [${t.category}]`
        : `NIE DA SIĘ: ${it.error}`;
      console.log(`   #${pad(String(it.quarantineId), 6)} ${pad(it.status, 9)} ${line}`);
      if (!t) totalErrors++;
    }
    console.log(
      `   plik(i): ${[...new Set(result.items.map((i) => i.fileName ?? '?'))].join(', ')}`,
    );
    if (result.alreadyPresent > 0) {
      console.log(`   już w portfelu (dedup pominie): ${result.alreadyPresent}`);
    }

    if (apply) {
      totalInserted += result.inserted;
      totalResolved += result.resolved;
      console.log(`   ✔ wstawiono ${result.inserted}, rozwiązano w skrzynce ${result.resolved}`);
      const txs = result.items.flatMap((i) => (i.tx ? [i.tx] : []));
      if (txs.length > 0) {
        const { resolved, unresolved } = await resolveUnknownIsins(txs, pid);
        const recon = reconcileQuoteCurrencies(pid);
        console.log(
          `   tickery: rozpoznano ${resolved.length}, nierozpoznane ${unresolved.length}` +
            (recon.warnings.length ? ` | ${recon.warnings.join('; ')}` : ''),
        );
      }
    }
    console.log('');
  }

  console.log('─'.repeat(80));
  console.log(`Wierszy: ${totalRows}, nie do przetworzenia: ${totalErrors}`);
  if (!apply) {
    console.log('DRY-RUN — nic nie zostało zapisane. Uruchom z --apply, żeby zaksięgować.');
    return;
  }
  console.log(
    `Wstawiono ${totalInserted} transakcji, rozwiązano ${totalResolved} wierszy skrzynki.`,
  );
  console.log('Zrestartuj serwer (systemctl restart ike-terminal) — memo historii jest in-memory.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
