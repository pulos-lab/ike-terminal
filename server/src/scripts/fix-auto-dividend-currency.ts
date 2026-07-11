/* eslint-disable no-console */
/**
 * One-shot korekta dywidend auto-yahoo zaksięgowanych w walucie notowania
 * zamiast waluty faktycznej wypłaty.
 *
 * Tło: do 2026-07 skaner dywidend (dividend-scanner.ts) wstawiał wpisy zawsze
 * w walucie notowania instrumentu (USD dla AAPL), podczas gdy u brokera
 * rozliczającego zakupy przez auto-FX (np. Bossa z kontem PLN) dywidenda
 * realnie wpływa już przewalutowana na PLN. Skutek: fikcyjne saldo USD
 * w panelu Waluty i rozjazd z realnym stanem konta.
 *
 * Skrypt naprawia WYŁĄCZNIE wpisy source='auto-yahoo' (importy z plików brokera
 * niosą realne kwoty i waluty; edycja wpisu w UI flipuje source na 'manual',
 * więc auto-yahoo = z definicji nietknięte ręcznie). Walutę wypłaty wnioskuje
 * tą samą logiką co naprawiony skaner (inferDividendPayoutCurrency — dominująca
 * waluta rozliczenia kupien sprzed ex-date), kwotę przelicza po dziennym kursie
 * rynkowym (convertDividendToPayoutCurrency). Idempotentny: po korekcie waluta
 * wpisu == waluta wypłaty i wpis nie łapie się ponownie.
 *
 * Usage:
 *   cd server && npx tsx src/scripts/fix-auto-dividend-currency.ts            # dry-run
 *   cd server && npx tsx src/scripts/fix-auto-dividend-currency.ts --apply    # commit
 *   cd server && npx tsx src/scripts/fix-auto-dividend-currency.ts --only=ID  # 1 portfel
 *
 * Production:
 *   ssh root@tixterminal.app 'cd /opt/ike-terminal/server && npx tsx src/scripts/fix-auto-dividend-currency.ts'
 *   ssh root@tixterminal.app 'cd /opt/ike-terminal/server && npx tsx src/scripts/fix-auto-dividend-currency.ts --apply'
 *   # Po --apply zrestartuj serwer — memo historii portfela (history-memo) jest
 *   # in-memory i nie zobaczy zmiany z zewnętrznego procesu.
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { getAllTransactions } from '../db/transactions-repo.js';
import { getSplits } from '../db/splits-repo.js';
import { getTickerMap } from '../db/ticker-map-repo.js';
import { adjustTransactionsForSplits } from '../services/split-detector.js';
import {
  inferDividendPayoutCurrency,
  convertDividendToPayoutCurrency,
} from '../services/dividend-scanner.js';
import { buildFxToPlnLookup } from '../services/fx-history.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db', 'import_profiles.db']);

interface OperationRow {
  id: number;
  date: string;
  description: string;
  amount: number;
  currency: string;
  ticker: string | null;
}

/** Wpis wymagający konwersji — kurs dociągany zbiorczo po zebraniu wszystkich. */
interface Pending {
  portfolioId: string;
  row: OperationRow;
  payoutCurrency: string;
}

interface Correction {
  portfolioId: string;
  row: OperationRow;
  newAmount: number;
  newCurrency: string;
  fxRate: number;
  fxPair: string;
  newDescription: string;
}

interface Skipped {
  portfolioId: string;
  row: OperationRow;
  reason: string;
}

function listPortfolios(): string[] {
  const entries = readdirSync(config.dataDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

/** Odwrotna mapa ticker → ISIN, z wariantem bez suffixu giełdy (PLAYWAY.WA → PLAYWAY). */
function buildTickerToIsin(portfolioId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [isin, entry] of getTickerMap(portfolioId)) {
    out.set(entry.ticker, isin);
    const base = entry.ticker.replace(/\.\w+$/, '');
    if (!out.has(base)) out.set(base, isin);
  }
  return out;
}

function findPending(portfolioId: string, skipped: Skipped[]): Pending[] {
  const db = getDb(portfolioId);
  const rows = db
    .prepare(
      'SELECT id, date, description, amount, currency, ticker FROM cash_operations ' +
        "WHERE source = 'auto-yahoo' AND operation_type = 'dividend'",
    )
    .all() as OperationRow[];
  if (rows.length === 0) return [];

  const tickerToIsin = buildTickerToIsin(portfolioId);
  // Waluta wypłaty liczona tą samą logiką co skaner: na transakcjach po korekcie splitowej.
  const savedSplits = getSplits(portfolioId).map((s) => ({
    ticker: s.ticker,
    isin: s.isin,
    date: s.splitDate,
    ratio: s.ratio,
    txPrice: 0,
    providerPrice: 0,
    source: s.source,
  }));
  const adjustedTxs = adjustTransactionsForSplits(getAllTransactions(portfolioId), savedSplits);

  const out: Pending[] = [];
  for (const row of rows) {
    if (!row.ticker) {
      skipped.push({ portfolioId, row, reason: 'wpis bez tickera' });
      continue;
    }
    const isin = tickerToIsin.get(row.ticker) ?? tickerToIsin.get(row.ticker.replace(/\.\w+$/, ''));
    if (!isin) {
      skipped.push({ portfolioId, row, reason: 'ticker nieznany w ticker_map' });
      continue;
    }
    const payoutCurrency = inferDividendPayoutCurrency(adjustedTxs, isin, row.date, row.currency);
    if (payoutCurrency === row.currency.toUpperCase()) continue; // już poprawny / bez konwersji
    out.push({ portfolioId, row, payoutCurrency });
  }
  return out;
}

function parseArgs() {
  return {
    apply: process.argv.includes('--apply'),
    only: process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null,
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  const { apply, only } = parseArgs();
  const portfolios = only ? [only] : listPortfolios();

  if (portfolios.length === 0) {
    console.log('No portfolio databases found in', config.dataDir);
    process.exit(0);
  }

  console.log(`Skanowanie ${portfolios.length} portfela/i w ${config.dataDir}`);
  console.log(`Tryb: ${apply ? 'APPLY (zapisuje zmiany)' : 'DRY-RUN (tylko podgląd)'}\n`);

  const pending: Pending[] = [];
  const skipped: Skipped[] = [];
  for (const pid of portfolios) {
    try {
      pending.push(...findPending(pid, skipped));
    } catch (err: any) {
      console.error(`  ${pid}: ERROR — ${err.message}`);
    }
  }

  const corrections: Correction[] = [];
  if (pending.length > 0) {
    // Jeden lookup kursów dla wszystkich portfeli: unia walut, od najstarszego wpisu.
    const currencies = new Set<string>();
    let minDate = '9999-12-31';
    for (const p of pending) {
      currencies.add(p.row.currency.toUpperCase());
      currencies.add(p.payoutCurrency);
      const key = p.row.date.slice(0, 10);
      if (key < minDate) minDate = key;
    }
    const fx = await buildFxToPlnLookup(Array.from(currencies), minDate);

    for (const p of pending) {
      const conv = convertDividendToPayoutCurrency(
        p.row.amount,
        p.row.currency,
        p.payoutCurrency,
        p.row.date,
        fx,
      );
      if (conv.missingRate || conv.fxRate === undefined || conv.fxPair === undefined) {
        skipped.push({
          portfolioId: p.portfolioId,
          row: p.row,
          reason: `brak kursu ${p.row.currency}/${p.payoutCurrency} na ${p.row.date.slice(0, 10)}`,
        });
        continue;
      }
      corrections.push({
        portfolioId: p.portfolioId,
        row: p.row,
        newAmount: conv.amount,
        newCurrency: conv.currency,
        fxRate: conv.fxRate,
        fxPair: conv.fxPair,
        newDescription: `${p.row.description} · kurs ${conv.fxRate.toFixed(4)}`,
      });
    }
  }

  if (skipped.length > 0) {
    console.log(`Pominięto ${skipped.length} wpis(ów):`);
    console.log('─'.repeat(120));
    for (const s of skipped) {
      console.log(
        `  [${pad(s.portfolioId, 20)}] ${s.row.date.slice(0, 10)} ${pad(s.row.ticker ?? '?', 8)} ${s.row.amount} ${s.row.currency} — ${s.reason}`,
      );
    }
    console.log('─'.repeat(120));
    console.log('');
  }

  if (corrections.length === 0) {
    console.log('Brak wpisów do korekty — dywidendy auto-yahoo są już w walucie wypłaty.');
    process.exit(0);
  }

  console.log(`Znaleziono ${corrections.length} wpis(ów) do korekty:`);
  console.log('─'.repeat(120));
  console.log(
    pad('PORTFEL', 20),
    pad('DATA', 10),
    pad('TICKER', 8),
    pad('BYŁO', 14),
    pad('BĘDZIE', 14),
    pad('KURS', 8),
    'PARA',
  );
  console.log('─'.repeat(120));
  for (const c of corrections) {
    console.log(
      pad(c.portfolioId, 20),
      pad(c.row.date.slice(0, 10), 10),
      pad(c.row.ticker ?? '?', 8),
      pad(`${c.row.amount} ${c.row.currency}`, 14),
      pad(`${c.newAmount} ${c.newCurrency}`, 14),
      pad(c.fxRate.toFixed(4), 8),
      c.fxPair,
    );
  }
  console.log('─'.repeat(120));

  if (!apply) {
    console.log(`\nDRY-RUN — żaden wpis nie został zmodyfikowany.`);
    console.log(`Aby wprowadzić zmiany uruchom ponownie z flagą --apply.`);
    process.exit(0);
  }

  let updated = 0;
  for (const c of corrections) {
    try {
      getDb(c.portfolioId)
        .prepare(
          'UPDATE cash_operations SET amount = ?, currency = ?, fx_rate = ?, fx_pair = ?, description = ? WHERE id = ?',
        )
        .run(c.newAmount, c.newCurrency, c.fxRate, c.fxPair, c.newDescription, c.row.id);
      updated++;
    } catch (err: any) {
      console.error(`  ${c.portfolioId}/#${c.row.id}: ERROR — ${err.message}`);
    }
  }

  console.log(`\nZaktualizowano ${updated}/${corrections.length} wpisów cash_operations.`);
  console.log('Zrestartuj serwer, żeby zinvalidować in-memory cache historii portfela.');
}

main();
