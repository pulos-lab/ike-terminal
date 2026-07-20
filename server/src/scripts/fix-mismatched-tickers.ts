/* eslint-disable no-console */
/**
 * One-shot naprawa wpisów `ticker_map`, które wskazują na CUDZĄ SPÓŁKĘ.
 *
 * GENEZA (zgłoszenie 2026-07-20): portfel XTB pokazywał Reliance Global Group po
 * 395,93 USD zamiast 2,28 USD. Po zmianie tickera RELI→EZRA symbol zniknął z Yahoo,
 * a resolver brał pierwszy wynik wyszukiwarki — `RS | Reliance, Inc.`, dystrybutora
 * stali z S&P 500.
 *
 * Diagnostyka pokazała, że to nie jest odosobniony przypadek. Na produkcji siedzi
 * ~16 otwartych pozycji wskazujących na inną spółkę (Outlook Therapeutics→OUTDOORZY,
 * ALLEGRO→AILLERON, Vertiv→MPLVERBUM, FI→Grupo Financiero Galicia…). Większość
 * pochodzi z ERY STOOQA, gdy dopasowanie po uciętym 3-znakowym prefiksie nie miało
 * żadnej weryfikacji nazwy. Obecny resolver (katalog biznesradar z `namesOverlap`
 * + walidacja trafień Yahoo z `ticker-match.ts`) tych błędów już NIE popełnia —
 * dowodem są portfele, gdzie ten sam ISIN rozwiązał się poprawnie przy nowszym
 * imporcie (ANET→Arista Networks obok ANET→Planet B2B).
 *
 * Złe wpisy nie naprawiają się same, bo `upsertTickerMapEntry` jest KOTWICĄ: raz
 * zapisanego tickera nie nadpisuje. Wyjątek dla provisional stubów (PR #202) tu nie
 * działa — te wpisy mają prawdziwy ticker różny od nazwy. Stąd ten skrypt.
 *
 * Jak znajduje kandydatów: tym samym walidatorem, który zapobiega nowym błędom
 * (`isPlausibleMatch`). Wpis jest podejrzany, gdy ani symbol, ani nazwa nie mają
 * nic wspólnego z tym, o co pytaliśmy.
 *
 * Bezpieczniki:
 *   - tylko pseudo-ISIN-y (prawdziwe ISIN-y z DeGiro/IBKR zostawiamy — nie zmierzone)
 *   - pomijamy opcje (`OPT:`), obligacje, CFD i wpisy ręczne (`AUTO_`)
 *   - domyślnie tylko pozycje OTWARTE (`--include-closed` rozszerza)
 *   - zapis wyłącznie gdy NOWY wynik przechodzi walidację i różni się od starego
 *   - domyślnie DRY-RUN; `--apply` zapisuje
 *
 * WAŻNE: uruchamiać PO wdrożeniu tej gałęzi — na starym resolverze naprawa nie
 * miałaby z czego wziąć poprawnego wyniku.
 *
 * Usage (lokalnie):
 *   npx tsx server/src/scripts/fix-mismatched-tickers.ts
 *   npx tsx server/src/scripts/fix-mismatched-tickers.ts --apply
 *   npx tsx server/src/scripts/fix-mismatched-tickers.ts --only=2a70ab40-5fac-45c8-97bc-7e3de3c9ab6e
 *
 * PRODUKCJA — na prodzie NIE MA `tsx`, są tylko zbudowane pliki. DATA_DIR jest
 * OBOWIĄZKOWY, bez niego skrypt cicho nic nie zrobi (patrz PR #194):
 *   cd /opt/ike-terminal/app/server
 *   DATA_DIR=/opt/ike-terminal/data node dist/scripts/fix-mismatched-tickers.js
 *   DATA_DIR=/opt/ike-terminal/data node dist/scripts/fix-mismatched-tickers.js --apply
 *   systemctl restart ike-terminal   # invalidacja in-memory price cache
 */

import { readdirSync } from 'node:fs';
import { basename } from 'node:path';
import type { TickerMapEntry } from 'shared';
import { findCfdTicker } from 'shared';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { upsertTickerMapEntry } from '../db/ticker-map-repo.js';
import { resolveIsin, FOREIGN_TICKER_ALIASES } from '../services/isin-resolver.js';
import { isPlausibleMatch } from '../services/ticker-match.js';

const EXCLUDED = new Set(['auth.db', 'price_history.db', 'bug-reports.db', 'import_profiles.db']);

/**
 * Waluta podpowiadana przy ponownej próbie rozwiązania, gdy pierwsza (z walutą
 * zapisaną w transakcji) zwróciła `null`. Dowolna nie-PLN — jedyne, co robi, to
 * zdejmuje z resolvera założenie „to papier z GPW". Patrz `reResolve`.
 */
const NEUTRAL_CURRENCY = 'USD';

/** ISIN w rozumieniu formatu (2 litery + 10 alfanumerycznych) — tak jak w resolverze. */
function isRealIsin(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{10}$/.test(value);
}

interface TickerRow {
  isin: string;
  ticker: string;
  name: string;
  exchange: string;
  currency: string;
}

interface Candidate {
  portfolioId: string;
  row: TickerRow;
  paperName: string;
  txCurrency: string;
  netQty: number;
}

interface Outcome {
  portfolioId: string;
  isin: string;
  oldDesc: string;
  newDesc: string;
  status: 'fixed' | 'skipped';
  reason?: string;
}

function listPortfolios(): string[] {
  return readdirSync(config.dataDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.db') && !EXCLUDED.has(e.name))
    .map((e) => basename(e.name, '.db'))
    .sort();
}

function findCandidates(portfolioId: string, includeClosed: boolean): Candidate[] {
  const db = getDb(portfolioId);
  let rows: TickerRow[];
  try {
    rows = db
      .prepare('SELECT isin, ticker, name, exchange, currency FROM ticker_map')
      .all() as TickerRow[];
  } catch {
    return []; // baza bez ticker_map (np. świeży portfel)
  }

  const txStmt = db.prepare(
    `SELECT paper_name, currency, category,
            SUM(CASE WHEN side = 'K' THEN quantity ELSE -quantity END) AS net,
            COUNT(*) AS n
     FROM transactions WHERE isin = ?`,
  );

  const out: Candidate[] = [];
  for (const row of rows) {
    const isin = row.isin.toUpperCase();
    // Prawdziwe ISIN-y, opcje, wpisy ręczne — poza zakresem.
    if (isRealIsin(isin) || isin.startsWith('OPT:') || isin.startsWith('AUTO_')) continue;
    // CFD/surowce/forex: symbol z definicji nie przypomina zapytania (OIL→BZ=F).
    if (findCfdTicker(row.isin) || findCfdTicker(row.name || '')) continue;

    const tx = txStmt.get(row.isin) as
      | {
          paper_name: string | null;
          currency: string | null;
          category: string | null;
          net: number | null;
          n: number;
        }
      | undefined;
    if (!tx || tx.n === 0) continue;
    if (tx.category === 'bond' || tx.category === 'option') continue;

    const netQty = tx.net ?? 0;
    if (!includeClosed && Math.abs(netQty) <= 0.001) continue;

    const paperName = tx.paper_name || row.isin;
    // Sedno: czy obecny wpis w ogóle odpowiada temu, o co pytaliśmy? Alias musi być
    // wśród zapytań, inaczej poprawnie naprawiony wpis (RELI→EZRA) byłby zgłaszany
    // jako podejrzany przy każdym kolejnym przebiegu.
    const alias = FOREIGN_TICKER_ALIASES[isin];
    if (
      isPlausibleMatch([alias, row.isin, paperName], {
        symbol: row.ticker,
        name: row.name || '',
      })
    ) {
      continue;
    }

    out.push({
      portfolioId,
      row,
      paperName,
      txCurrency: (tx.currency || 'USD').toUpperCase(),
      netQty,
    });
  }
  return out;
}

async function reResolve(c: Candidate, apply: boolean): Promise<Outcome> {
  const oldDesc = `${c.row.ticker} ${c.row.exchange}/${c.row.currency} (${c.row.name || '?'})`;
  const base = { portfolioId: c.portfolioId, isin: c.row.isin, oldDesc };

  let entry: TickerMapEntry | null = null;
  try {
    entry = await resolveIsin(c.row.isin, c.paperName, c.txCurrency);

    // ── Przerwanie zakleszczenia waluta ↔ ticker ──
    // Kandydatem jest wpis, który NIE przechodzi walidacji, czyli wskazuje cudzą
    // spółkę. Wtedy zapisana przy nim waluta transakcji jest równie niewiarygodna
    // co sam ticker — a `PLN` wpycha resolver w gałąź polską, gdzie zagranicznego
    // papieru z definicji nie ma. Powstaje pętla: backfill walut pomija ten wiersz,
    // bo ticker_map nie przechodzi walidacji, a naprawa tickera zwraca `null`,
    // bo waluta mówi „to polskie".
    //
    // Ponawiamy więc z walutą neutralną. To NIE narzuca wyniku — jest wyłącznie
    // sygnałem „nie zakładaj, że to GPW"; resolver i tak zwraca własną walutę
    // (zweryfikowane: ABEA.DE → EUR, ASML.AS → EUR, mimo podpowiedzi USD).
    // Bezpieczeństwo zapewnia walidacja `isPlausibleMatch` niżej: gdyby neutralna
    // waluta wyprodukowała fałszywe trafienie zagraniczne, zostanie odrzucone.
    if (!entry && c.txCurrency === 'PLN') {
      entry = await resolveIsin(c.row.isin, c.paperName, NEUTRAL_CURRENCY);
    }
  } catch (err: any) {
    return { ...base, newDesc: '—', status: 'skipped', reason: `resolveIsin: ${err.message}` };
  }

  if (!entry) {
    return {
      ...base,
      newDesc: '—',
      status: 'skipped',
      reason: 'resolver zwrócił null — pozycja zostanie stubem i ponowi się przy imporcie',
    };
  }

  const newDesc = `${entry.ticker} ${entry.exchange}/${entry.currency} (${entry.name || '?'})`;

  if (entry.ticker.toUpperCase() === c.row.ticker.toUpperCase()) {
    return { ...base, newDesc, status: 'skipped', reason: 'resolver zwrócił ten sam ticker' };
  }

  // Nie zamieniamy jednego złego trafienia na drugie. Alias rebrandingowy musi być
  // wśród zapytań — po zmianie RELI→EZRA ani symbol, ani nazwa nie przypominają już
  // starego tickera, a mimo to jest to poprawne rozwiązanie.
  const alias = FOREIGN_TICKER_ALIASES[c.row.isin.toUpperCase()];
  if (
    !isPlausibleMatch([alias, c.row.isin, c.paperName], {
      symbol: entry.ticker,
      name: entry.name || '',
    })
  ) {
    return {
      ...base,
      newDesc,
      status: 'skipped',
      reason: 'nowy wynik też nie przechodzi walidacji',
    };
  }

  if (apply) upsertTickerMapEntry(entry, c.portfolioId, true); // force — zdejmujemy kotwicę
  return { ...base, newDesc, status: 'fixed' };
}

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

async function main() {
  const apply = process.argv.includes('--apply');
  const includeClosed = process.argv.includes('--include-closed');
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length) : null;

  const portfolios = only ? [only] : listPortfolios();
  console.log(
    `Przeszukuję ${portfolios.length} portfel(i)${includeClosed ? ' (także pozycje zamknięte)' : ' (tylko otwarte pozycje)'}...`,
  );

  const candidates = portfolios.flatMap((p) => findCandidates(p, includeClosed));
  if (candidates.length === 0) {
    console.log('Brak wpisów wskazujących na cudzą spółkę. Nic do zrobienia.');
    return;
  }
  console.log(
    `Znaleziono ${candidates.length} podejrzan(ych) wpis(ów). Ponowne rozwiązywanie...\n`,
  );

  // Sekwencyjnie — resolver i tak ma wewnętrzne limitery; nie zalewamy Yahoo/BR.
  const outcomes: Outcome[] = [];
  for (const c of candidates) outcomes.push(await reResolve(c, apply));

  const fixed = outcomes.filter((o) => o.status === 'fixed');
  const skipped = outcomes.filter((o) => o.status === 'skipped');

  console.log('─'.repeat(150));
  console.log(pad('PORTFEL', 20), pad('ISIN', 22), pad('BYŁO', 44), '→  JEST');
  console.log('─'.repeat(150));
  for (const o of outcomes) {
    console.log(
      o.status === 'fixed' ? '✓' : '✗',
      pad(o.portfolioId.slice(0, 18), 18),
      pad(o.isin, 22),
      pad(o.oldDesc, 44),
      `→  ${o.newDesc}${o.reason ? `   [${o.reason}]` : ''}`,
    );
  }
  console.log('─'.repeat(150));
  console.log(`\nNaprawialne: ${fixed.length}, pominięte: ${skipped.length}`);

  if (!apply) {
    console.log('\nDRY-RUN — nic nie zapisano. Uruchom ponownie z --apply, aby wprowadzić zmiany.');
    return;
  }
  console.log(`\nZaktualizowano ${fixed.length} wpisów ticker_map.`);
  console.log('Zrestartuj serwer, żeby zinvalidować in-memory price cache.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
