/* eslint-disable no-console */
/**
 * Diagnostyka źródeł spin-offów NA ŻYWO — jednorazowa weryfikacja po deployu
 * (sandbox developerski blokuje ruch zewnętrzny, więc transport nie mógł być
 * sprawdzony przy implementacji; treść była kontraktowana realnymi fixture'ami).
 *
 * Uruchomienie:
 *   npm run check:spinoff-sources -w server            # discovery + ratio dla 3 zdarzeń
 *   npm run check:spinoff-sources -w server -- --all   # ratio dla wszystkich zdarzeń
 *
 * Skrypt NIE dotyka żadnej bazy (czyste funkcje + żywe fetch'e):
 *  1. pobiera stronę stockanalysis.com/actions/spinoffs/<rok>/ i parsuje tabelę,
 *  2. dla znalezionych zdarzeń pyta SEC EDGAR (8-K/10-12B) o ratio dystrybucji,
 *  3. wypisuje raport — każda linia mówi, które ogniwo działa/nie działa.
 */
import { parseStockanalysisSpinoffs } from '../src/services/spinoff-events.js';
import { resolveSpinoffRatioFromSec } from '../src/services/sec-ratio-resolver.js';
import { SPIN_OFF_MAP } from 'shared';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

const checkAll = process.argv.includes('--all');
const RATIO_CHECK_LIMIT = checkAll ? Infinity : 3;

async function main() {
  const year = new Date().getFullYear();
  const url = `https://stockanalysis.com/actions/spinoffs/${year}/`;

  console.log('══ 1/2: Discovery — stockanalysis.com ══');
  console.log(`GET ${url}`);
  let html: string;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (err) {
    console.error('✗ Strona niedostępna:', err);
    console.error('  (aplikacja zdegraduje do statycznej mapy — zdarzeń z mapy to nie dotyczy)');
    process.exit(1);
  }

  const { events, skipped } = parseStockanalysisSpinoffs(html);
  if (events.length === 0) {
    console.error(
      `✗ Parser nie wyłowił żadnego zdarzenia (pominięte wiersze: ${skipped}). ` +
        'Struktura strony mogła się zmienić — porównaj z fixture w testach ' +
        '(server/src/services/__tests__/__fixtures__/stockanalysis-spinoffs.html).',
    );
    process.exit(1);
  }
  console.log(`✓ Zdarzeń: ${events.length}, pominiętych wierszy: ${skipped}`);
  for (const e of events) {
    console.log(
      `  ${e.exDate}  ${e.parentTicker.padEnd(6)} → ${e.childTicker.padEnd(6)}` +
        `  (${e.parentName ?? '?'} → ${e.childName ?? '?'})`,
    );
  }

  console.log('\n══ 2/2: Ratio — SEC EDGAR (8-K / 10-12B) ══');
  if (!process.env.SEC_CONTACT) {
    console.log(
      'ℹ Brak env SEC_CONTACT — używam domyślnego User-Agent. SEC wymaga kontaktu ' +
        'w UA przy regularnym użyciu (SEC_CONTACT="Nazwa email@domena").',
    );
  }
  const toCheck = events.slice(0, RATIO_CHECK_LIMIT === Infinity ? undefined : RATIO_CHECK_LIMIT);
  let resolved = 0;
  for (const e of toCheck) {
    const result = await resolveSpinoffRatioFromSec({
      parentTicker: e.parentTicker,
      parentName: e.parentName,
      childTicker: e.childTicker,
      childName: e.childName,
      exDate: e.exDate,
    });
    if (result) {
      resolved++;
      console.log(
        `✓ ${e.parentTicker} → ${e.childTicker}: ratio = ${result.ratio}\n    źródło: ${result.sourceUrl}`,
      );
    } else {
      console.log(
        `— ${e.parentTicker} → ${e.childTicker}: brak jednoznacznego ratio ` +
          '(w aplikacji: zdarzenie czeka, badge "czekam na ratio" przy rodzicu)',
      );
    }
  }

  // Sanity: wpis z mapy (SPGI→MBGL) — ścieżka nadrzędna, niezależna od powyższych
  console.log('\n══ Mapa statyczna (ścieżka nadrzędna) ══');
  for (const m of SPIN_OFF_MAP) {
    console.log(
      `✓ ${m.parentTicker} → ${m.childTicker}  ex ${m.exDate}  ratio ${m.ratio}` +
        (m.costAllocPct !== undefined ? `  alokacja ${m.costAllocPct}` : '  (alokacja z cen)'),
    );
  }

  console.log(
    `\nPodsumowanie: discovery OK (${events.length} zdarzeń), ` +
      `ratio z SEC: ${resolved}/${toCheck.length} sprawdzonych` +
      (checkAll ? '' : ' (użyj --all dla wszystkich)') +
      `, mapa: ${SPIN_OFF_MAP.length} wpis(ów).`,
  );
}

main().catch((err) => {
  console.error('Nieoczekiwany błąd:', err);
  process.exit(1);
});
