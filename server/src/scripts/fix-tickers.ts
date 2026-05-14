/* eslint-disable no-console */
/**
 * Generyczna naprawa ticker_map — uzupełnia fix:nc o przypadki bez Bossa -NC suffix.
 *
 * 3 wzorce naprawy (wszystkie weryfikowane przez Stooq):
 *
 *   1. NC_NAME_MATCH — Stored name DOKŁADNIE pasuje do NC byName, ma transakcje,
 *      Stooq potwierdza XNCO. Naprawia GAMIVO, BACT, PRESIDENT itd. importowane
 *      przez non-Bossa (DEGIRO / manual) bez sufiksu -NC.
 *
 *   2. STUTTGART_FALLBACK — Ticker kończy się na `.SG` (Yahoo Stuttgart fallback
 *      gdy nie znalazł na innym rynku) + inny portfel ma ten sam ISIN z poprawnym
 *      tickerem `.WA` (lub innym non-.SG). Używamy canonical z innego portfela.
 *      Naprawia np. PEPCO Group (NL0015000AU7.SG → PCO.WA).
 *
 *   3. STALE_FOREIGN_CURRENCY — Ticker kończy się na `.WA` (Polish stock) ale
 *      currency != PLN. Pozostałość po wcześniejszym Yahoo Stuttgart fallback
 *      lub innym mylnym wpisie. Force PLN dla .WA.
 *
 * Dry-run default. --apply żeby zapisać.
 *
 * Usage:
 *   npm run fix:tickers -w server                # dry-run
 *   npm run fix:tickers -w server -- --apply
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { findNcTicker } from 'shared';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { searchStooqByName } from '../services/ticker-search.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db']);

interface TickerRow {
  isin: string;
  ticker: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  price_source: string | null;
}

interface Fix {
  pattern: 'NC_NAME_MATCH' | 'STUTTGART_FALLBACK' | 'STALE_FOREIGN_CURRENCY';
  portfolioId: string;
  isin: string;
  description: string;
  before: Record<string, string | null>;
  updates: Record<string, string>;
}

function listPortfolios(): string[] {
  const entries = readdirSync(config.dataDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function loadAllTickers(portfolios: string[]): Map<string, Array<{ pid: string; row: TickerRow }>> {
  const byIsin = new Map<string, Array<{ pid: string; row: TickerRow }>>();
  for (const pid of portfolios) {
    try {
      const db = getDb(pid);
      const rows = db
        .prepare('SELECT isin, ticker, name, exchange, currency, price_source FROM ticker_map')
        .all() as TickerRow[];
      for (const row of rows) {
        const arr = byIsin.get(row.isin);
        if (arr) arr.push({ pid, row });
        else byIsin.set(row.isin, [{ pid, row }]);
      }
    } catch (err: any) {
      console.error(`  ${pid}: ERROR loading — ${err.message}`);
    }
  }
  return byIsin;
}

// Cache Stooq lookups
const stooqCache = new Map<string, 'NC' | 'GPW' | null>();
async function checkStooqExchange(name: string): Promise<'NC' | 'GPW' | null> {
  const key = name.toUpperCase();
  if (stooqCache.has(key)) return stooqCache.get(key)!;
  const variants = new Set([name, name.replace(/\s+S\.?A\.?$/i, '').trim(), name.split(/\s+/)[0]]);
  for (const v of variants) {
    if (!v) continue;
    try {
      const r = await searchStooqByName(v);
      const exch = r?.exchange === 'NC' ? 'NC' : r?.exchange === 'GPW' ? 'GPW' : null;
      if (exch) {
        stooqCache.set(key, exch);
        return exch;
      }
    } catch {
      // continue
    }
  }
  stooqCache.set(key, null);
  return null;
}

async function detectFixes(portfolios: string[]): Promise<Fix[]> {
  const fixes: Fix[] = [];
  const allByIsin = loadAllTickers(portfolios);

  for (const pid of portfolios) {
    let db;
    let rows: TickerRow[];
    try {
      db = getDb(pid);
      rows = db
        .prepare('SELECT isin, ticker, name, exchange, currency, price_source FROM ticker_map')
        .all() as TickerRow[];
    } catch {
      continue;
    }
    const txCountStmt = db.prepare(`SELECT COUNT(*) AS c FROM transactions WHERE isin = ?`);

    for (const row of rows) {
      const ticker = row.ticker || '';
      const name = row.name || '';
      const exchange = row.exchange || '';
      const currency = row.currency || '';
      const txCount = (txCountStmt.get(row.isin) as { c: number }).c;

      // Pomiń orphany — naprawiamy tylko realne pozycje
      if (txCount === 0) continue;

      // ===== Pattern 1: NC_NAME_MATCH =====
      if (name && exchange !== 'NC') {
        const nc = findNcTicker(name);
        if (nc && nc.name.toUpperCase() === name.toUpperCase()) {
          const stooqExch = await checkStooqExchange(name);
          if (stooqExch === 'NC') {
            const expectedTicker = `${nc.ticker}.WA`;
            const updates: Record<string, string> = {
              exchange: 'NC',
              price_source: 'stooq',
            };
            if (ticker !== expectedTicker) updates.ticker = expectedTicker;
            fixes.push({
              pattern: 'NC_NAME_MATCH',
              portfolioId: pid,
              isin: row.isin,
              description: `${nc.name} — Stooq potwierdza NC, fix exchange/source${ticker !== expectedTicker ? '/ticker' : ''}`,
              before: { ticker, name, exchange, currency, price_source: row.price_source },
              updates,
            });
            continue; // next row
          }
        }
      }

      // ===== Pattern 2: STUTTGART_FALLBACK =====
      // Ticker kończy się na .SG (Yahoo Stuttgart fallback) — szukamy canonical w innym portfelu
      if (/\.SG$/i.test(ticker)) {
        const allVersions = allByIsin.get(row.isin) || [];
        const canonical = allVersions.find(
          (v) => !/\.SG$/i.test(v.row.ticker || '') && v.row.ticker && v.row.exchange,
        );
        if (canonical) {
          fixes.push({
            pattern: 'STUTTGART_FALLBACK',
            portfolioId: pid,
            isin: row.isin,
            description: `Stuttgart .SG fallback → canonical z portfela ${canonical.pid.slice(0, 8)} (${canonical.row.ticker})`,
            before: { ticker, name, exchange, currency, price_source: row.price_source },
            updates: {
              ticker: canonical.row.ticker,
              name: canonical.row.name || name,
              exchange: canonical.row.exchange || 'OTHER',
              currency: canonical.row.currency || 'PLN',
              price_source: canonical.row.price_source || 'yahoo',
            },
          });
          continue;
        }
      }

      // ===== Pattern 3: STALE_FOREIGN_CURRENCY =====
      // .WA ticker ale currency != PLN — leftover po Yahoo Stuttgart i innych fallback'ach
      if (/\.WA$/i.test(ticker) && currency && currency !== 'PLN') {
        fixes.push({
          pattern: 'STALE_FOREIGN_CURRENCY',
          portfolioId: pid,
          isin: row.isin,
          description: `.WA ticker ale currency=${currency} → PLN`,
          before: { ticker, name, exchange, currency, price_source: row.price_source },
          updates: { currency: 'PLN' },
        });
      }
    }
  }

  return fixes;
}

function applyFix(fix: Fix): void {
  const db = getDb(fix.portfolioId);
  const setClauses = Object.keys(fix.updates)
    .map((k) => `${k} = ?`)
    .join(', ');
  const params = [...Object.values(fix.updates), fix.isin];
  db.prepare(`UPDATE ticker_map SET ${setClauses} WHERE isin = ?`).run(...params);
}

function parseArgs() {
  return {
    apply: process.argv.includes('--apply'),
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  const { apply } = parseArgs();
  const portfolios = listPortfolios();

  console.log(`Skanowanie ${portfolios.length} portfela/i w ${config.dataDir}`);
  console.log(`Tryb: ${apply ? 'APPLY (zapisuje zmiany)' : 'DRY-RUN (tylko podgląd)'}\n`);

  const fixes = await detectFixes(portfolios);
  if (fixes.length === 0) {
    console.log('Brak kandydatów do naprawy.');
    process.exit(0);
  }

  console.log(`Znaleziono ${fixes.length} wpis(ów) do naprawy:`);
  console.log('─'.repeat(120));
  for (const fix of fixes) {
    console.log(
      `  [${pad(fix.pattern, 22)}] ${pad(fix.portfolioId.slice(0, 12), 12)} ${pad(fix.isin, 14)} — ${fix.description}`,
    );
    console.log(`     PRZED: ${JSON.stringify(fix.before)}`);
    console.log(`     PO:    ${JSON.stringify(fix.updates)}`);
  }
  console.log('─'.repeat(120));

  if (!apply) {
    console.log(`\nDRY-RUN — żaden wpis nie został zmodyfikowany.`);
    console.log(`Aby zapisać uruchom ponownie z flagą --apply.`);
    process.exit(0);
  }

  let updated = 0;
  for (const fix of fixes) {
    try {
      applyFix(fix);
      updated++;
    } catch (err: any) {
      console.error(`  ${fix.portfolioId}/${fix.isin}: ERROR — ${err.message}`);
    }
  }

  console.log(`\nZaktualizowano ${updated}/${fixes.length} wpisów ticker_map.`);
  console.log('Zrestartuj serwer żeby zinvalidować in-memory price cache.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
