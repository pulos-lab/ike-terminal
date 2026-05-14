/* eslint-disable no-console */
/**
 * Audyt ticker_map across all portfolios — read-only.
 *
 * Wyszukuje błędy w mapowaniach tickerów w grupach:
 *   1. SUSPECTED_MIS_RESOLVE — name w bazie pasuje do NC mapy, ale paperName
 *      nie ma sufiksu -NC. Może być stary bug w resolverze (np. PKN.WA → "ORZLOPONY")
 *   2. NC_WRONG_SOURCE       — paperName ma -NC ale exchange != 'NC' (LEGIMI/SEVENET pattern)
 *   3. EMPTY_FIELDS          — brak nazwy, waluty lub exchange
 *   4. CURRENCY_MISMATCH     — ticker sugeruje inną walutę niż zapisana (.WA bez PLN, .DE bez EUR)
 *   5. CROSS_PORTFOLIO_DIVERGENCE — ten sam ISIN ma różne ticker/name w różnych portfelach
 *   6. ORPHAN_NO_TRANSACTIONS — wpis w ticker_map ale 0 transakcji dla tego ISIN-u
 *   7. STOOQ_FOR_GPW         — exchange='GPW' z price_source='stooq' (powinno być yahoo po migracji)
 *
 * Usage:
 *   cd server && npx tsx src/scripts/audit-ticker-map.ts
 *   cd server && npx tsx src/scripts/audit-ticker-map.ts --only=portfolio-id
 *   cd server && npx tsx src/scripts/audit-ticker-map.ts --category=NC_WRONG_SOURCE
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import {
  findNcTicker,
  findCfdTicker,
  NC_TICKER_MAP,
  GPW_NAME_TO_TICKER,
  NAME_ALIASES,
} from 'shared';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { STOOQ_ALIASES } from '../services/isin-resolver.js';
import { searchStooqByName } from '../services/ticker-search.js';

// Lookup pomocnicze: NC byName i byTicker (case-insensitive)
const NC_BY_NAME = new Map<string, { ticker: string; name: string }>();
const NC_BY_TICKER = new Map<string, { ticker: string; name: string }>();
for (const entry of NC_TICKER_MAP) {
  NC_BY_NAME.set(entry.name.toUpperCase(), entry);
  NC_BY_TICKER.set(entry.ticker.toUpperCase(), entry);
}

function isRealIsin(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test(value);
}

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db']);

interface TickerRow {
  isin: string;
  ticker: string;
  name: string | null;
  exchange: string | null;
  currency: string | null;
  price_source: string | null;
  sector: string | null;
  supersector: string | null;
}

type Category =
  | 'SUSPECTED_MIS_RESOLVE'
  | 'NC_WRONG_SOURCE'
  | 'MIGRATION_NC_TO_GPW'
  | 'MIGRATION_GPW_TO_NC'
  | 'NAME_TICKER_MISMATCH'
  | 'ISIN_ALIAS_NAME_CONFLICT'
  | 'PSEUDO_TICKER'
  | 'OLD_NAME_NOT_REBRANDED'
  | 'EMPTY_FIELDS'
  | 'CURRENCY_MISMATCH'
  | 'CROSS_PORTFOLIO_DIVERGENCE'
  | 'ORPHAN_NO_TRANSACTIONS'
  | 'STOOQ_FOR_GPW';

interface Finding {
  category: Category;
  portfolioId: string;
  isin: string;
  ticker: string;
  name: string;
  detail: string;
}

function listPortfolios(): string[] {
  const entries = readdirSync(config.dataDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function parseArgs() {
  return {
    only: process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? null,
    category:
      process.argv.find((a) => a.startsWith('--category='))?.slice('--category='.length) ?? null,
    verifyStooq: process.argv.includes('--verify-stooq'),
  };
}

const stooqCache = new Map<string, 'NC' | 'GPW' | null>();
async function getStooqExchange(name: string): Promise<'NC' | 'GPW' | null> {
  const key = name.toUpperCase();
  if (stooqCache.has(key)) return stooqCache.get(key)!;

  // Próbuj różnych wariantów nazwy: stored, bez "SA", canonical z NC mapy
  const variants = new Set<string>();
  variants.add(name);
  variants.add(name.replace(/\s+S\.?A\.?$/i, '').trim());
  variants.add(name.replace(/\s+S\.?p\.?\s+z\s+o\.?o\.?$/i, '').trim());
  const nc = findNcTicker(name);
  if (nc) variants.add(nc.name);
  // Pierwsze słowo jako fallback (np. "Duality SA" → "Duality")
  const firstWord = name.split(/\s+/)[0];
  if (firstWord && firstWord.length >= 3) variants.add(firstWord);

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
      // continue to next variant
    }
  }
  stooqCache.set(key, null);
  return null;
}

function shortPid(pid: string): string {
  return pid.length > 20 ? pid.slice(0, 20) : pid;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function auditPortfolio(portfolioId: string): Finding[] {
  const db = getDb(portfolioId);
  const rows = db
    .prepare(
      `SELECT isin, ticker, name, exchange, currency, price_source, sector, supersector
         FROM ticker_map`,
    )
    .all() as TickerRow[];

  const txStmt = db.prepare(`SELECT DISTINCT paper_name FROM transactions WHERE isin = ?`);
  const txCountStmt = db.prepare(`SELECT COUNT(*) AS c FROM transactions WHERE isin = ?`);
  const txByDateStmt = db.prepare(
    `SELECT paper_name, date FROM transactions WHERE isin = ? ORDER BY date DESC LIMIT 1`,
  );

  const findings: Finding[] = [];

  for (const row of rows) {
    const ticker = row.ticker || '';
    const name = row.name || '';
    const exchange = row.exchange || '';
    const currency = row.currency || '';
    const priceSource = row.price_source || '';

    // Pobierz paper_name'y i flagi NC z transakcji
    const paperNames = (txStmt.all(row.isin) as { paper_name: string | null }[]).map(
      (r) => r.paper_name || '',
    );
    const hasNcSuffix = paperNames.some((p) => /-NC(?:-FIX)?$/i.test(p));
    const allHaveNcSuffix =
      paperNames.length > 0 && paperNames.every((p) => /-NC(?:-FIX)?$/i.test(p));
    const txCount = (txCountStmt.get(row.isin) as { c: number }).c;
    const latestTx = txByDateStmt.get(row.isin) as
      | { paper_name: string | null; date: string }
      | undefined;
    const latestPaper = latestTx?.paper_name || '';
    const latestHasNc = /-NC(?:-FIX)?$/i.test(latestPaper);

    // MIGRATION_NC_TO_GPW — najnowsza transakcja BEZ -NC, ale stare miały
    // (i/lub stored exchange='NC'). Klasyczny wzorzec dla spółek przeniesionych
    // z NewConnect na rynek główny GPW (np. Woodpecker, 11 Bit Studios).
    if (txCount > 0 && hasNcSuffix && !latestHasNc) {
      findings.push({
        category: 'MIGRATION_NC_TO_GPW',
        portfolioId,
        isin: row.isin,
        ticker,
        name,
        detail: `Stare transakcje miały sufiks "-NC", ale najnowsza (${latestTx?.date}) już nie. Spółka prawdopodobnie przeniosła notowanie z NC na GPW. Stored exchange="${exchange}" może wymagać aktualizacji.`,
      });
    }

    // MIGRATION_GPW_TO_NC — odwrotny case (rzadki): stored='GPW' ale wszystkie
    // transakcje mają -NC. Może wskazywać że anchor wpis utknął przed
    // refaktorem albo że klasyfikacja była błędna od początku.
    if (txCount > 0 && allHaveNcSuffix && exchange !== 'NC') {
      findings.push({
        category: 'MIGRATION_GPW_TO_NC',
        portfolioId,
        isin: row.isin,
        ticker,
        name,
        detail: `Wszystkie transakcje (najnowsza ${latestTx?.date}) mają sufiks "-NC", ale stored exchange="${exchange}". Anchor utknął — fix:nc to naprawi.`,
      });
    }

    // 1. SUSPECTED_MIS_RESOLVE
    //    name w bazie pasuje do NC mapy, ale żadna transakcja nie ma -NC
    //    → resolver kiedyś źle zmapował na NC company (np. Orlen → ORZLOPONY)
    if (name && !hasNcSuffix) {
      const nc = findNcTicker(name);
      if (nc && nc.name.toUpperCase() === name.toUpperCase()) {
        findings.push({
          category: 'SUSPECTED_MIS_RESOLVE',
          portfolioId,
          isin: row.isin,
          ticker,
          name,
          detail: `name "${name}" pasuje do NC mapy (ticker=${nc.ticker}), ale żadna transakcja użytkownika nie ma sufiksu -NC. Możliwe że resolver źle nadał nazwę NC company innej spółce.`,
        });
      }
    }

    // 1a. NAME_TICKER_MISMATCH
    //    Stored name matchuje konkretny NC entry, ale ticker w bazie (bez .WA)
    //    NIE jest tym NC tickerem. Czyli nazwa wskazuje firmę X, ticker firmę Y.
    if (name) {
      const ncByName = NC_BY_NAME.get(name.toUpperCase());
      const tickerBase = ticker.replace(/\.WA$/i, '').toUpperCase();
      if (ncByName && tickerBase && ncByName.ticker.toUpperCase() !== tickerBase) {
        // Ignorujemy przypadek gdy ticker = ISIN (pseudo-ticker) — to złapie PSEUDO_TICKER
        if (tickerBase !== row.isin.toUpperCase()) {
          findings.push({
            category: 'NAME_TICKER_MISMATCH',
            portfolioId,
            isin: row.isin,
            ticker,
            name,
            detail: `name "${name}" wskazuje NC ticker ${ncByName.ticker}, ale w bazie ticker=${ticker}. Niespójność nazwa↔ticker.`,
          });
        }
      }
    }

    // 1b. ISIN_ALIAS_NAME_CONFLICT (Orlen → ORZLOPONY pattern)
    //    ISIN to mBank/XTB pseudo-ISIN który jest STARYM TICKEROM w STOOQ_ALIASES,
    //    AND stored name pasuje do NC byName — sugeruje że resolver dla GPW
    //    pseudo-ISIN podał nazwę innej (NC) spółki przez kolizję.
    const isinBase = row.isin.replace(/\.WA$/i, '').toUpperCase();
    if (STOOQ_ALIASES[isinBase]) {
      if (name && NC_BY_NAME.has(name.toUpperCase())) {
        const newTicker = STOOQ_ALIASES[isinBase];
        findings.push({
          category: 'ISIN_ALIAS_NAME_CONFLICT',
          portfolioId,
          isin: row.isin,
          ticker,
          name,
          detail: `ISIN "${row.isin}" to stary ticker (rebrand do "${newTicker}"), ale stored name "${name}" pasuje do NC mapy. Resolver pewnie pomylił spółkę przez kolizję ticker code'u.`,
        });
      }
    }

    // 1c. OLD_NAME_NOT_REBRANDED
    //    Stored name jest w NAME_ALIASES (stara nazwa zarejestrowanej spółki)
    //    → wpis powinien być re-resolvowany na nową nazwę.
    if (name && NAME_ALIASES[name.toUpperCase()]) {
      findings.push({
        category: 'OLD_NAME_NOT_REBRANDED',
        portfolioId,
        isin: row.isin,
        ticker,
        name,
        detail: `name "${name}" to stara nazwa firmy (rebrand → ISIN ${NAME_ALIASES[name.toUpperCase()]}). Wpis może wymagać aktualizacji.`,
      });
    }

    // 1d. PSEUDO_TICKER
    //    Stored ticker jest identyczny z ISIN-em (lub jego prefixem) — czyli
    //    resolver nie znalazł prawdziwego tickera. Yahoo/Stooq nie zna takiego
    //    "tickera", więc pobieranie cen nie zadziała.
    const tickerStripped = ticker.replace(/\.[A-Z]+$/i, '').toUpperCase();
    const isinStripped = row.isin.replace(/\.[A-Z]+$/i, '').toUpperCase();
    if (
      ticker &&
      (tickerStripped === isinStripped || tickerStripped === row.isin.toUpperCase()) &&
      isRealIsin(isinStripped)
    ) {
      findings.push({
        category: 'PSEUDO_TICKER',
        portfolioId,
        isin: row.isin,
        ticker,
        name,
        detail: `ticker = ISIN (${ticker}) — resolver nie znalazł real Stooq/Yahoo ticker'a, pobieranie ceny nie zadziała.`,
      });
    }

    // 2. NC_WRONG_SOURCE
    //    Najnowsza transakcja ma -NC ale exchange != 'NC' lub price_source != 'stooq'.
    //    Używamy najnowszej (a nie ANY) bo paperName -NC = moment zakupu, nie aktualny
    //    status — Bossa znakuje -NC nawet po migracji spółki na GPW jeśli stara tx jest
    //    z czasów NC. Najnowsza jest najbliższym proxy do "aktualnie NC".
    if (latestHasNc && (exchange !== 'NC' || priceSource !== 'stooq')) {
      findings.push({
        category: 'NC_WRONG_SOURCE',
        portfolioId,
        isin: row.isin,
        ticker,
        name,
        detail: `Najnowsza tx Bossa (${latestTx?.date}) z -NC ale exchange=${exchange}, price_source=${priceSource} (powinno: NC/stooq). Wymaga weryfikacji Stooq w post-processingu.`,
      });
    }

    // 3. EMPTY_FIELDS
    if (!name || !exchange || !currency || !priceSource) {
      const missing: string[] = [];
      if (!name) missing.push('name');
      if (!exchange) missing.push('exchange');
      if (!currency) missing.push('currency');
      if (!priceSource) missing.push('price_source');
      findings.push({
        category: 'EMPTY_FIELDS',
        portfolioId,
        isin: row.isin,
        ticker,
        name,
        detail: `brak: ${missing.join(', ')}`,
      });
    }

    // 4. CURRENCY_MISMATCH
    //    ticker sugeruje inną walutę niż zapisaną
    if (ticker.endsWith('.WA') && currency && currency !== 'PLN') {
      findings.push({
        category: 'CURRENCY_MISMATCH',
        portfolioId,
        isin: row.isin,
        ticker,
        name,
        detail: `ticker .WA ale currency=${currency} (oczekiwane PLN)`,
      });
    }
    if (ticker.endsWith('.DE') && currency && currency !== 'EUR') {
      findings.push({
        category: 'CURRENCY_MISMATCH',
        portfolioId,
        isin: row.isin,
        ticker,
        name,
        detail: `ticker .DE ale currency=${currency} (oczekiwane EUR)`,
      });
    }
    if (ticker.endsWith('.TO') && currency && currency !== 'CAD') {
      findings.push({
        category: 'CURRENCY_MISMATCH',
        portfolioId,
        isin: row.isin,
        ticker,
        name,
        detail: `ticker .TO ale currency=${currency} (oczekiwane CAD)`,
      });
    }

    // 5. ORPHAN_NO_TRANSACTIONS
    //    Wpis istnieje w ticker_map ale brak jakichkolwiek transakcji
    if (txCount === 0) {
      findings.push({
        category: 'ORPHAN_NO_TRANSACTIONS',
        portfolioId,
        isin: row.isin,
        ticker,
        name,
        detail: `0 transakcji dla tego ISIN-u (orphan / nieużywany wpis)`,
      });
    }

    // 7. STOOQ_FOR_GPW
    //    exchange='GPW' z price_source='stooq' (powinno być yahoo po migracji)
    if (exchange === 'GPW' && priceSource === 'stooq') {
      findings.push({
        category: 'STOOQ_FOR_GPW',
        portfolioId,
        isin: row.isin,
        ticker,
        name,
        detail: `exchange=GPW ale price_source=stooq (post-migration powinno być yahoo)`,
      });
    }
  }

  return findings;
}

function detectCrossPortfolioDivergence(perPortfolio: Map<string, TickerRow[]>): Finding[] {
  const byIsin = new Map<string, { pid: string; row: TickerRow }[]>();
  for (const [pid, rows] of perPortfolio) {
    for (const row of rows) {
      const arr = byIsin.get(row.isin);
      if (arr) arr.push({ pid, row });
      else byIsin.set(row.isin, [{ pid, row }]);
    }
  }

  const findings: Finding[] = [];
  for (const [isin, list] of byIsin) {
    if (list.length < 2) continue;
    const first = list[0];
    const divergent = list.some(
      (item) =>
        (item.row.ticker || '') !== (first.row.ticker || '') ||
        (item.row.exchange || '') !== (first.row.exchange || '') ||
        (item.row.name || '').toUpperCase() !== (first.row.name || '').toUpperCase(),
    );
    if (!divergent) continue;

    const variants = list
      .map(
        (it) =>
          `${shortPid(it.pid)}: ${it.row.ticker || '-'} ${it.row.name || '-'} ${
            it.row.exchange || '-'
          }`,
      )
      .join(' | ');
    findings.push({
      category: 'CROSS_PORTFOLIO_DIVERGENCE',
      portfolioId: list.map((it) => shortPid(it.pid)).join(','),
      isin,
      ticker: first.row.ticker || '',
      name: first.row.name || '',
      detail: variants,
    });
  }
  return findings;
}

async function main() {
  const { only, category, verifyStooq } = parseArgs();
  const portfolios = only ? [only] : listPortfolios();

  if (portfolios.length === 0) {
    console.log('No portfolio databases found in', config.dataDir);
    process.exit(0);
  }

  console.log(`Audyt ${portfolios.length} portfela/i w ${config.dataDir}`);
  if (category) console.log(`Filtr kategorii: ${category}`);
  if (verifyStooq)
    console.log(`Weryfikacja Stooq: WŁĄCZONA (--verify-stooq) — odfiltruje fałszywe migracje`);
  console.log('');

  const all: Finding[] = [];
  const perPortfolio = new Map<string, TickerRow[]>();

  for (const pid of portfolios) {
    try {
      const findings = auditPortfolio(pid);
      all.push(...findings);
      // Cache rows for cross-portfolio check
      const db = getDb(pid);
      const rows = db
        .prepare(
          `SELECT isin, ticker, name, exchange, currency, price_source, sector, supersector
             FROM ticker_map`,
        )
        .all() as TickerRow[];
      perPortfolio.set(pid, rows);
    } catch (err: any) {
      console.error(`  ${pid}: ERROR — ${err.message}`);
    }
  }

  // Post-processing: weryfikacja Stooq dla MIGRATION_* i NC_WRONG_SOURCE (best-effort)
  // Jeśli Stooq potwierdza że stored exchange == aktualny exchange — flag jest
  // false-positive (np. Woodpecker po migracji NC→GPW, ale historyczne tx z -NC).
  if (verifyStooq) {
    const verifiable = all.filter(
      (f) =>
        f.category === 'MIGRATION_NC_TO_GPW' ||
        f.category === 'MIGRATION_GPW_TO_NC' ||
        f.category === 'NC_WRONG_SOURCE',
    );
    const toRemove = new Set<Finding>();
    for (const f of verifiable) {
      const stooqExchange = await getStooqExchange(f.name);
      if (!stooqExchange) continue;
      const row = perPortfolio.get(f.portfolioId)?.find((r) => r.isin === f.isin);
      const storedExchange = row?.exchange || '';
      if (storedExchange === stooqExchange) {
        // Stored zgadza się z aktualnym Stooq → false positive, nie bug
        toRemove.add(f);
      } else {
        f.detail += ` [Stooq: ${stooqExchange} — POTWIERDZONE jako realny bug]`;
      }
    }
    if (toRemove.size > 0) {
      for (let i = all.length - 1; i >= 0; i--) {
        if (toRemove.has(all[i])) all.splice(i, 1);
      }
      console.log(`Stooq verification odfiltrował ${toRemove.size} fałszywych pozytywów.\n`);
    }
  }

  // Cross-portfolio analiza (po skonsolidowaniu)
  all.push(...detectCrossPortfolioDivergence(perPortfolio));

  const filtered = category ? all.filter((f) => f.category === category) : all;

  if (filtered.length === 0) {
    console.log('Brak znalezisk. Wszystko OK.');
    process.exit(0);
  }

  // Grupowanie i podsumowanie
  const byCategory = new Map<Category, Finding[]>();
  for (const f of filtered) {
    const arr = byCategory.get(f.category);
    if (arr) arr.push(f);
    else byCategory.set(f.category, [f]);
  }

  const order: Category[] = [
    'NC_WRONG_SOURCE',
    'MIGRATION_NC_TO_GPW',
    'MIGRATION_GPW_TO_NC',
    'ISIN_ALIAS_NAME_CONFLICT',
    'NAME_TICKER_MISMATCH',
    'PSEUDO_TICKER',
    'OLD_NAME_NOT_REBRANDED',
    'SUSPECTED_MIS_RESOLVE',
    'CURRENCY_MISMATCH',
    'EMPTY_FIELDS',
    'CROSS_PORTFOLIO_DIVERGENCE',
    'STOOQ_FOR_GPW',
    'ORPHAN_NO_TRANSACTIONS',
  ];

  console.log('═'.repeat(120));
  console.log('PODSUMOWANIE');
  console.log('═'.repeat(120));
  for (const cat of order) {
    const list = byCategory.get(cat);
    if (!list) continue;
    console.log(`  ${pad(cat, 30)} ${list.length}`);
  }
  console.log(`  ${pad('RAZEM', 30)} ${filtered.length}`);
  console.log('');

  for (const cat of order) {
    const list = byCategory.get(cat);
    if (!list) continue;
    console.log('─'.repeat(120));
    console.log(`### ${cat} (${list.length})`);
    console.log('─'.repeat(120));
    for (const f of list) {
      console.log(
        `  [${shortPid(f.portfolioId)}] ${pad(f.isin, 16)} ${pad(f.ticker, 12)} ${pad(
          f.name,
          22,
        )} — ${f.detail}`,
      );
    }
    console.log('');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
