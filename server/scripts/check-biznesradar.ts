/* eslint-disable no-console */
/**
 * Diagnostyka biznesradar.pl NA ŻYWO — smoke wszystkich powierzchni, z których
 * korzysta aplikacja (sandbox developerski blokuje ruch zewnętrzny, więc to
 * skrypt po-deployowy / ręczny; wzorzec check-spinoff-sources).
 *
 * Uruchomienie:
 *   npm run check:biznesradar -w server                  # golden ticker EXC (NC)
 *   npm run check:biznesradar -w server -- --ticker=PCX  # inny ticker
 *
 * Skrypt NIE dotyka żadnej bazy ani guarda (czyste parsery + żywe fetch'e):
 *  1. kurs live `/notowania/<ticker>`            (parser q_ch_act),
 *  2. historia `/notowania-historyczne/<ticker>` (tabela qTableFull),
 *  3. katalog tickerów `service-data-short-js/1` + strona GlobalConnect,
 *  4. kalendarze dywidend `/dywidendy/` i `/dywidendy/newconnect`.
 * Każda sekcja mówi, które ogniwo działa; blokada anti-bot jest raportowana
 * ODRĘBNIE od zmiany markupu (inna reakcja: przeczekać vs naprawić parser).
 */
import {
  parseBiznesradarPrice,
  parseBiznesradarHistoryTable,
} from '../src/services/biznesradar.js';
import { detectBiznesradarBlock } from '../src/services/biznesradar-guard.js';
import {
  parseBrCatalog,
  parseGcTickers,
  MIN_PLAUSIBLE_ENTRIES,
} from '../src/services/biznesradar-catalog.js';
import { parseBiznesradar as parseBrDividends } from '../src/services/gpw-dividend-calendar.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const POLITENESS_DELAY_MS = 1_000;

const tickerArg = process.argv.find((a) => a.startsWith('--ticker='));
const TICKER = (tickerArg ? tickerArg.split('=')[1] : 'EXC').toUpperCase();

let failures = 0;

function ok(label: string, detail: string): void {
  console.log(`✓ ${label}: ${detail}`);
}

function fail(label: string, detail: string): void {
  failures++;
  console.error(`✗ ${label}: ${detail}`);
}

/** Fetch strony; wynik rozróżnia blokadę anti-bot od zwykłej awarii. */
async function fetchPage(url: string): Promise<{ html: string; status: number } | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    const html = await resp.text().catch(() => '');
    if (detectBiznesradarBlock(resp.status, html)) {
      fail(url, `BLOKADA/ANTI-BOT (HTTP ${resp.status}) — biznesradar wycina nasz ruch`);
      return null;
    }
    if (!resp.ok) {
      fail(url, `HTTP ${resp.status}`);
      return null;
    }
    return { html, status: resp.status };
  } catch (err) {
    fail(url, `fetch nieudany: ${err}`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`══ 1/4: Kurs live — /notowania/${TICKER} ══`);
  const live = await fetchPage(`https://www.biznesradar.pl/notowania/${TICKER}`);
  if (live) {
    const price = parseBiznesradarPrice(live.html);
    if (price != null) ok('kurs live', `${price} (parser q_ch_act żyje)`);
    else fail('kurs live', 'HTTP 200, ale parser q_ch_act nic nie wyciągnął — ZMIANA MARKUPU?');
  }

  await sleep(POLITENESS_DELAY_MS);
  console.log(`\n══ 2/4: Historia — /notowania-historyczne/${TICKER} ══`);
  const hist = await fetchPage(`https://www.biznesradar.pl/notowania-historyczne/${TICKER}`);
  if (hist) {
    const rows = parseBiznesradarHistoryTable(hist.html);
    if (rows.length >= 10) ok('historia', `${rows.length} sesji (tabela qTableFull żyje)`);
    else
      fail(
        'historia',
        `HTTP 200, ale tabela qTableFull dała ${rows.length} wierszy — ZMIANA MARKUPU?`,
      );
  }

  await sleep(POLITENESS_DELAY_MS);
  console.log('\n══ 3/4: Katalog tickerów — service-data-short-js/1 + GlobalConnect ══');
  const catalog = await fetchPage('https://www.biznesradar.pl/service-data-short-js/1');
  if (catalog) {
    try {
      const entries = parseBrCatalog(catalog.html);
      if (entries.length >= MIN_PLAUSIBLE_ENTRIES)
        ok('katalog', `${entries.length} wpisów (próg ${MIN_PLAUSIBLE_ENTRIES})`);
      else fail('katalog', `tylko ${entries.length} wpisów (próg ${MIN_PLAUSIBLE_ENTRIES})`);
    } catch (err) {
      fail('katalog', `payload nie parsuje się jako katalog: ${err}`);
    }
  }
  await sleep(POLITENESS_DELAY_MS);
  const gc = await fetchPage('https://www.biznesradar.pl/gielda/akcje_globalconnect');
  if (gc) {
    const gcTickers = parseGcTickers(gc.html);
    if (gcTickers.size >= 5) ok('GlobalConnect', `${gcTickers.size} tickerów wykluczeń`);
    else fail('GlobalConnect', `tylko ${gcTickers.size} tickerów — możliwa zmiana strony`);
  }

  await sleep(POLITENESS_DELAY_MS);
  console.log('\n══ 4/4: Kalendarze dywidend — /dywidendy/ + /dywidendy/newconnect ══');
  for (const url of [
    'https://www.biznesradar.pl/dywidendy/',
    'https://www.biznesradar.pl/dywidendy/newconnect',
  ]) {
    const page = await fetchPage(url);
    if (page) {
      const rows = parseBrDividends(page.html, new Date());
      // Strony zawierają też wpisy historyczne — nigdy nie są legalnie puste.
      if (rows.length >= 1) ok(url, `${rows.length} wierszy dywidend`);
      else fail(url, 'HTTP 200, ale 0 wierszy dywidend — ZMIANA MARKUPU?');
    }
    await sleep(POLITENESS_DELAY_MS);
  }

  console.log(
    failures === 0
      ? `\nPodsumowanie: wszystkie powierzchnie biznesradar OK (ticker ${TICKER}).`
      : `\nPodsumowanie: ${failures} awarii — patrz wyżej (blokada = przeczekać/sprawdzić zabezpieczenia; zmiana markupu = naprawić parser).`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err);
  process.exit(1);
});
