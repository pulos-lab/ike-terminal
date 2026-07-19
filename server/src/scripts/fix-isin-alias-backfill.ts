/* eslint-disable no-console */
/**
 * One-shot backfill aliasów ISIN (shared/src/isin-aliases-map.ts) na ISTNIEJĄCYCH
 * danych. Parsery aplikują aliasy dopiero od momentu wdrożenia — wiersze
 * zaimportowane wcześniej zostają pod starym identyfikatorem. To łamie
 * idempotencję re-importu: dedup działa po (date, isin, side, qty, price),
 * więc ponowne wgranie tego samego pliku po wdrożeniu aliasu wstawiłoby
 * te same transakcje DRUGI RAZ pod nowym ISIN-em. Ten skrypt migruje stare
 * wiersze na kanoniczny identyfikator, przywracając idempotencję.
 *
 * Zakres per wpis mapy (z poszanowaniem `appliesUntil` — porównanie po dacie
 * dziennej wiersza):
 *   - transactions:     isin + paper_name  → canonical
 *   - cash_operations:  ticker             → canonicalTicker (dywidendy/opłaty)
 *   - ticker_map:       wpis pod legacyIsin → DELETE gdy kanoniczny istnieje,
 *                       inaczej re-key na canonical (nazwa zostaje — resolver
 *                       odświeży przy najbliższym lazy backfillu)
 *
 * Skrypt jest idempotentny (drugi przebieg = 0 zmian) i domyślnie DRY-RUN.
 *
 * Usage (dev):
 *   cd server && npx tsx src/scripts/fix-isin-alias-backfill.ts             # dry-run
 *   cd server && npx tsx src/scripts/fix-isin-alias-backfill.ts --apply    # zapis
 *   cd server && npx tsx src/scripts/fix-isin-alias-backfill.ts --only=ID  # 1 portfel
 *   cd server && npx tsx src/scripts/fix-isin-alias-backfill.ts --alias=REXA.WA  # 1 wpis
 *
 * Production (po deployu; UWAGA: na prodzie NIE ma tsx — odpalać zbudowany dist
 * i OBOWIĄZKOWO z DATA_DIR, inaczej skrypt po cichu przeskanuje pusty katalog):
 *   ssh root@vps 'cd /opt/ike-terminal/server && DATA_DIR=/opt/ike-terminal/data \
 *     node dist/scripts/fix-isin-alias-backfill.js'
 *   ssh root@vps 'cd /opt/ike-terminal/server && DATA_DIR=/opt/ike-terminal/data \
 *     node dist/scripts/fix-isin-alias-backfill.js --apply'
 *   # Po --apply zrestartuj serwer — memo historii (data-version) jest in-memory.
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { ISIN_ALIASES_MAP, type IsinAliasEntry } from 'shared';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db', 'import_profiles.db']);

interface EntryOutcome {
  portfolioId: string;
  alias: string;
  transactions: number;
  cashOperations: number;
  tickerMap: 'deleted' | 'rekeyed' | 'none';
}

function listPortfolios(): string[] {
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

/** Warunek granicy datowej wpisu — substr(date,1,10) porównuje sam dzień
 *  (kolumny date trzymają ISO, timestamp lub sam dzień; prefiks YYYY-MM-DD
 *  sortuje się leksykograficznie zgodnie z chronologią). */
function dateBound(entry: IsinAliasEntry): { sql: string; params: string[] } {
  if (!entry.appliesUntil) return { sql: '', params: [] };
  return { sql: ' AND substr(date, 1, 10) <= ?', params: [entry.appliesUntil] };
}

function processEntry(
  portfolioId: string,
  entry: IsinAliasEntry,
  apply: boolean,
): EntryOutcome | null {
  const db = getDb(portfolioId);
  const bound = dateBound(entry);

  const txCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE isin = ? AND paper_name = ?${bound.sql}`,
      )
      .get(entry.legacyIsin, entry.legacyTicker, ...bound.params) as { n: number }
  ).n;

  const opCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM cash_operations WHERE ticker = ?${bound.sql}`)
      .get(entry.legacyTicker, ...bound.params) as { n: number }
  ).n;

  const legacyMapRow = db
    .prepare('SELECT isin FROM ticker_map WHERE isin = ?')
    .get(entry.legacyIsin) as { isin: string } | undefined;
  const canonicalMapRow = db
    .prepare('SELECT isin FROM ticker_map WHERE isin = ?')
    .get(entry.canonicalIsin) as { isin: string } | undefined;
  const tickerMapAction: EntryOutcome['tickerMap'] = !legacyMapRow
    ? 'none'
    : canonicalMapRow
      ? 'deleted'
      : 'rekeyed';

  if (txCount === 0 && opCount === 0 && tickerMapAction === 'none') return null;

  if (apply) {
    db.transaction(() => {
      db.prepare(
        `UPDATE transactions SET isin = ?, paper_name = ? WHERE isin = ? AND paper_name = ?${bound.sql}`,
      ).run(
        entry.canonicalIsin,
        entry.canonicalTicker,
        entry.legacyIsin,
        entry.legacyTicker,
        ...bound.params,
      );
      db.prepare(`UPDATE cash_operations SET ticker = ? WHERE ticker = ?${bound.sql}`).run(
        entry.canonicalTicker,
        entry.legacyTicker,
        ...bound.params,
      );
      if (tickerMapAction === 'deleted') {
        db.prepare('DELETE FROM ticker_map WHERE isin = ?').run(entry.legacyIsin);
      } else if (tickerMapAction === 'rekeyed') {
        db.prepare('UPDATE ticker_map SET isin = ?, ticker = ? WHERE isin = ?').run(
          entry.canonicalIsin,
          entry.canonicalTicker,
          entry.legacyIsin,
        );
      }
    })();
  }

  return {
    portfolioId,
    alias: `${entry.legacyIsin}→${entry.canonicalIsin}`,
    transactions: txCount,
    cashOperations: opCount,
    tickerMap: tickerMapAction,
  };
}

function parseArgs() {
  return {
    apply: process.argv.includes('--apply'),
    only: process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null,
    alias: process.argv.find((a) => a.startsWith('--alias='))?.slice('--alias='.length) ?? null,
  };
}

function main() {
  const { apply, only, alias } = parseArgs();
  const portfolios = only ? [only] : listPortfolios();
  const entries = alias ? ISIN_ALIASES_MAP.filter((e) => e.legacyIsin === alias) : ISIN_ALIASES_MAP;

  if (entries.length === 0) {
    console.error(
      `Nieznany alias: ${alias} (dostępne: ${ISIN_ALIASES_MAP.map((e) => e.legacyIsin).join(', ')})`,
    );
    process.exit(1);
  }
  if (portfolios.length === 0) {
    console.log('No portfolio databases found in', config.dataDir);
    process.exit(0);
  }

  console.log(`Skanowanie ${portfolios.length} portfela/i w ${config.dataDir}`);
  console.log(`Aliasy: ${entries.map((e) => `${e.legacyIsin}→${e.canonicalIsin}`).join(', ')}`);
  console.log(`Tryb: ${apply ? 'APPLY (zapisuje zmiany)' : 'DRY-RUN (tylko podgląd)'}\n`);

  const outcomes: EntryOutcome[] = [];
  for (const pid of portfolios) {
    for (const entry of entries) {
      try {
        const o = processEntry(pid, entry, apply);
        if (o) outcomes.push(o);
      } catch (err) {
        console.error(`  ${pid}: ERROR — ${(err as Error).message}`);
      }
    }
  }

  if (outcomes.length === 0) {
    console.log('Brak wierszy pod starymi identyfikatorami — nic do zrobienia.');
    return;
  }

  console.log('PORTFEL                               ALIAS                 TX    CASH  TICKER_MAP');
  console.log('─'.repeat(95));
  for (const o of outcomes) {
    console.log(
      `${o.portfolioId.padEnd(38)}${o.alias.padEnd(22)}${String(o.transactions).padEnd(6)}${String(o.cashOperations).padEnd(6)}${o.tickerMap}`,
    );
  }
  console.log('─'.repeat(95));
  const txTotal = outcomes.reduce((s, o) => s + o.transactions, 0);
  const opTotal = outcomes.reduce((s, o) => s + o.cashOperations, 0);
  console.log(
    `\nRazem: ${txTotal} transakcji, ${opTotal} operacji cash w ${outcomes.length} wpisach.`,
  );

  if (!apply) {
    console.log('\nDRY-RUN — nic nie zapisano. Uruchom ponownie z --apply, aby wprowadzić zmiany.');
  } else {
    console.log('\nZapisano. Zrestartuj serwer, żeby unieważnić in-memory memo historii.');
  }
}

main();
