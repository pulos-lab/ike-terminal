/**
 * Harness parytetu importu generycznego — porównuje wynik silnika profili
 * (parseWithProfile + golden profile) z parserami WBUDOWANYMI na RZECZYWISTYCH
 * plikach eksportów (Bossa hisPW/operacje, DEGIRO Transactions/Account).
 *
 * Uruchomienie (lokalnie; pliki użytkownika NIE wchodzą do repo):
 *   IMPORT_DIR=/ścieżka/do/import npm run compare:generic -w server
 *   npm run compare:generic -w server -- --resolver-live   # + żywe wywołania resolvera
 *
 * Porównanie z resolverem tickerów: resolveIsin() jest deterministyczną funkcją
 * trójki (isin, paperName, txCurrency) — jeśli zbiory trójek z obu ścieżek są
 * IDENTYCZNE, wynikowe wpisy ticker_map (ticker, GPW/NC/zagranica, waluta,
 * źródło cen) są identyczne z definicji, bez wywołań sieciowych. Tryb
 * --resolver-live dodatkowo woła resolver na żywo dla trójek różniących się.
 *
 * Różnice OCZEKIWANE (poza zakresem silnika generycznego, zostają w parserach
 * wbudowanych): markery rekoncyliacji Bossy — wykupy certyfikatów/obligacji,
 * wezwania skupu, pary IPO, zwroty kapitału. Harness wydziela je do osobnej
 * sekcji raportu i nie traktuje jako porażki parytetu.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CashOperation, Transaction } from 'shared';
import { decodeCSVBuffer } from '../src/parsers/encoding.js';
import { isBossaFormat, parseBossaTransactions } from '../src/parsers/bossa-transactions.js';
import { isBossaOperationsFormat, parseBossaOperations } from '../src/parsers/bossa-operations.js';
import { isDegiroFormat, parseDegiroTransactions } from '../src/parsers/degiro-transactions.js';
import {
  isDegiroAccountFormat,
  parseDegiroOperations,
} from '../src/parsers/degiro-operations.js';
import { parseWithProfile } from '../src/parsers/generic/engine.js';
import { GenericParseError } from '../src/parsers/generic/value-parsers.js';
import { BOSSA_TRANSACTIONS_PROFILE } from '../src/parsers/generic/profiles/bossa-transactions.profile.js';
import { BOSSA_OPERATIONS_PROFILE } from '../src/parsers/generic/profiles/bossa-operations.profile.js';
import { DEGIRO_TRANSACTIONS_PROFILE } from '../src/parsers/generic/profiles/degiro-transactions.profile.js';
import { DEGIRO_ACCOUNT_PROFILE } from '../src/parsers/generic/profiles/degiro-account.profile.js';

const BATCH = 'parity-harness';
const RESOLVER_LIVE = process.argv.includes('--resolver-live');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR =
  process.env.IMPORT_DIR ?? path.resolve(scriptDir, '..', '..', 'import');

// Wzorce tytułów obsługiwanych przez rekoncyliację parsera wbudowanego (markery) —
// w imporcie generycznym lądują jako 'other'/skip i są różnicą OCZEKIWANĄ.
const EXPECTED_DIFF_TITLE = new RegExp(
  [
    '^Wykup certyfikat',
    '^Wykup (obligacji|papierów wartościowych|PW)',
    '^Rozliczenie oferty',
    'Obniżenie wartości nominalnej',
    '^Zapisy na akcje',
    '^Zwrot nadpłaty',
    '^(Wypłata\\s+)?[Oo]dset', // kupony obligacji rozpoznawane przez bond-map
    '^Subskrypcja akcji',
    '^Wyrównanie wykupu',
    '^Zwrot kapitału',
    '^Wykup w ofercie skupu',
    '^Prowizja od oferty skupu',
    '^Kupon ',
    // Niesparowany podatek u źródła: parser wbudowany go GUBI (pairing-only),
    // generyczny importuje jako fee — różnica oczekiwana na korzyść generycznego.
    '^Podatek Dywidendowy',
  ].join('|'),
);

let hardFailures = 0;

function walkCsv(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkCsv(full));
    else if (entry.toLowerCase().endsWith('.csv')) out.push(full);
  }
  return out.sort();
}

const txKey = (t: Transaction) => `${t.date}|${t.isin}|${t.side}|${t.quantity}|${t.price}`;
const opKey = (o: CashOperation) =>
  `${o.date}|${o.operationType}|${o.amount}|${o.currency}|${o.ticker ?? ''}|${o.fxRate ?? ''}|${o.fxPair ?? ''}|${o.subkind ?? ''}`;
const resolverTriple = (t: Transaction) => `${t.isin}|${t.paperName}|${t.currency}`;

/** Multiset-diff: elementy tylko w A i tylko w B. */
function multisetDiff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const count = new Map<string, number>();
  for (const k of a) count.set(k, (count.get(k) ?? 0) + 1);
  for (const k of b) count.set(k, (count.get(k) ?? 0) - 1);
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  for (const [k, c] of count) {
    for (let i = 0; i < c; i++) onlyA.push(k);
    for (let i = 0; i < -c; i++) onlyB.push(k);
  }
  return { onlyA, onlyB };
}

function compareTransactions(
  label: string,
  builtin: Transaction[],
  generic: Transaction[],
): Set<string> {
  const TX_FIELDS: Array<keyof Transaction> = [
    'date',
    'paperName',
    'isin',
    'quantity',
    'side',
    'price',
    'value',
    'commission',
    'total',
    'currency',
    'paymentCurrency',
    'fxRate',
    'category',
  ];

  console.log(`  Transakcje: wbudowany=${builtin.length}, generyczny=${generic.length}`);

  // Multiset PEŁNYCH rekordów (modulo source) — odporne na zduplikowane klucze
  // (dwa fille tej samej transakcji o różnych prowizjach parują się poprawnie).
  const fullRecord = (t: Transaction) => {
    const rec: Record<string, unknown> = {};
    for (const f of TX_FIELDS) rec[f] = t[f] ?? null;
    return JSON.stringify(rec);
  };
  const { onlyA, onlyB } = multisetDiff(builtin.map(fullRecord), generic.map(fullRecord));
  if (onlyA.length === 0 && onlyB.length === 0) {
    console.log('  ✅ PARYTET: wszystkie pola identyczne (modulo source)');
  } else {
    hardFailures++;
    console.log(
      `  ❌ Rozbieżne rekordy — tylko wbudowany: ${onlyA.length}, tylko generyczny: ${onlyB.length}`,
    );
    onlyA.slice(0, 5).forEach((k) => console.log(`    [wbud] ${k}`));
    onlyB.slice(0, 5).forEach((k) => console.log(`    [gen ] ${k}`));
  }

  // Trójki wejściowe resolvera — równość ⇒ identyczne przypisania ticker_map.
  const triplesA = new Set(builtin.map(resolverTriple));
  const triplesB = new Set(generic.map(resolverTriple));
  const missing = [...triplesA].filter((t) => !triplesB.has(t));
  const extra = [...triplesB].filter((t) => !triplesA.has(t));
  if (missing.length === 0 && extra.length === 0) {
    console.log(
      `  ✅ RESOLVER: identyczne trójki (isin, papier, waluta) ×${triplesA.size} ⇒ identyczne przypisania PL/zagranica i kwotowań`,
    );
  } else {
    hardFailures++;
    console.log(`  ❌ RESOLVER: trójki różne — brak w generycznym: ${missing.length}, nadmiar: ${extra.length}`);
    missing.slice(0, 5).forEach((t) => console.log(`    [brak ] ${t}`));
    extra.slice(0, 5).forEach((t) => console.log(`    [extra] ${t}`));
  }
  return new Set([...missing, ...extra]);
}

function compareOperations(label: string, builtin: CashOperation[], generic: CashOperation[]) {
  console.log(`  Operacje: wbudowany=${builtin.length}, generyczny=${generic.length}`);
  const byDesc = new Map<string, CashOperation>();
  for (const o of [...builtin, ...generic]) byDesc.set(opKey(o), o);

  let { onlyA, onlyB } = multisetDiff(builtin.map(opKey), generic.map(opKey));

  // Operacje "wzbogacone": ta sama (data, typ, kwota, waluta, ticker), różnica
  // tylko w fxRate/fxPair/subkind — np. generyczny sparował nogi FX, których
  // parser wbudowany nie umie sparować (dwa wiersze "FX Withdrawal" o
  // przeciwnych znakach). Dane bazowe zgodne → różnica miękka, nie porażka.
  const reducedKey = (k: string) => k.split('|').slice(0, 5).join('|');
  const reducedB = new Map<string, number>();
  for (const k of onlyB) reducedB.set(reducedKey(k), (reducedB.get(reducedKey(k)) ?? 0) + 1);
  const enriched: string[] = [];
  onlyA = onlyA.filter((k) => {
    const r = reducedKey(k);
    const n = reducedB.get(r) ?? 0;
    if (n > 0) {
      reducedB.set(r, n - 1);
      enriched.push(r);
      return false;
    }
    return true;
  });
  const enrichedSet = new Set<string>();
  let remaining = [...enriched];
  onlyB = onlyB.filter((k) => {
    const idx = remaining.indexOf(reducedKey(k));
    if (idx >= 0) {
      remaining.splice(idx, 1);
      enrichedSet.add(k);
      return false;
    }
    return true;
  });
  if (enriched.length > 0) {
    console.log(
      `  ℹ️  Operacje wzbogacone przez generyczny (kurs/para FX, te same kwoty): ${enriched.length}`,
    );
  }

  const classify = (keys: string[]) => {
    const expected: string[] = [];
    const unexpected: string[] = [];
    for (const k of keys) {
      const op = byDesc.get(k);
      const text = `${op?.description ?? ''} ${op?.details ?? ''}`;
      (EXPECTED_DIFF_TITLE.test(text) || op?.operationType === 'corporate_action_pending'
        ? expected
        : unexpected
      ).push(`${k}  „${op?.description ?? '?'}”`);
    }
    return { expected, unexpected };
  };
  const a = classify(onlyA);
  const b = classify(onlyB);

  if (a.unexpected.length === 0 && b.unexpected.length === 0) {
    console.log('  ✅ PARYTET operacji (klucze dedup + fx + subkind)');
  } else {
    hardFailures++;
    console.log(
      `  ❌ NIEOCZEKIWANE różnice operacji — tylko wbudowany: ${a.unexpected.length}, tylko generyczny: ${b.unexpected.length}`,
    );
    a.unexpected.slice(0, 8).forEach((k) => console.log(`    [wbud] ${k}`));
    b.unexpected.slice(0, 8).forEach((k) => console.log(`    [gen ] ${k}`));
  }
  if (a.expected.length > 0 || b.expected.length > 0) {
    console.log(
      `  ℹ️  Różnice OCZEKIWANE (markery rekoncyliacji — zostają w parserze wbudowanym): ` +
        `wbudowany ${a.expected.length}, generyczny ${b.expected.length}`,
    );
    [...a.expected.slice(0, 4), ...b.expected.slice(0, 4)].forEach((k) =>
      console.log(`    ${k}`),
    );
  }

  // Opisy — miękka różnica (nie wpływa na dedup ani metryki) — tylko statystyka.
  const descA = new Map(builtin.map((o) => [opKey(o), o.description]));
  let descDiffs = 0;
  for (const o of generic) {
    const d = descA.get(opKey(o));
    if (d !== undefined && d !== o.description) descDiffs++;
  }
  if (descDiffs > 0) {
    console.log(`  ℹ️  Opisy różne dla ${descDiffs} operacji (parser wbudowany humanizuje tytuły)`);
  }
}

async function resolverLive(triples: Set<string>) {
  if (triples.size === 0) return;
  const { resolveIsin } = await import('../src/services/isin-resolver.js');
  console.log(`\n— Żywe wywołania resolvera dla ${triples.size} różniących się trójek —`);
  for (const t of triples) {
    const [isin, paperName, currency] = t.split('|');
    try {
      const entry = await resolveIsin(isin, paperName, currency);
      console.log(
        `  ${t} → ${entry ? `${entry.ticker} [${entry.exchange}] ${entry.currency} (${entry.priceSource})` : 'NIEROZWIĄZANE'}`,
      );
    } catch (err) {
      console.log(`  ${t} → BŁĄD: ${(err as Error).message}`);
    }
  }
}

async function main() {
  console.log(`Katalog danych: ${IMPORT_DIR}\n`);
  let files: string[];
  try {
    files = walkCsv(IMPORT_DIR);
  } catch {
    console.error(
      `Nie można odczytać ${IMPORT_DIR} — ustaw IMPORT_DIR na katalog z eksportami CSV.`,
    );
    process.exit(2);
  }

  const diffTriples = new Set<string>();

  for (const file of files) {
    const rel = path.relative(IMPORT_DIR, file);
    const content = decodeCSVBuffer(readFileSync(file));

    let kind: string | null = null;
    try {
      if (isBossaFormat(content)) {
        kind = 'Bossa transakcje';
        console.log(`▶ ${rel} (${kind})`);
        const builtin = parseBossaTransactions(content, BATCH);
        const generic = parseWithProfile(content, BOSSA_TRANSACTIONS_PROFILE, BATCH);
        compareTransactions(rel, builtin.data, generic.transactions.data).forEach((t) =>
          diffTriples.add(t),
        );
      } else if (isBossaOperationsFormat(content)) {
        kind = 'Bossa operacje';
        console.log(`▶ ${rel} (${kind})`);
        const builtin = parseBossaOperations(content, BATCH);
        const generic = parseWithProfile(content, BOSSA_OPERATIONS_PROFILE, BATCH);
        console.log(
          `  Markery rekoncyliacji (wbudowany): wykupy=${builtin.redemptions.length}, ` +
            `IPO=${builtin.ipoSubscriptions.length}, zwroty kapitału=${builtin.capitalReturns.length}`,
        );
        compareOperations(rel, builtin.data, generic.operations.data);
      } else if (isDegiroFormat(content)) {
        kind = 'DEGIRO transakcje';
        console.log(`▶ ${rel} (${kind})`);
        const builtin = parseDegiroTransactions(content, BATCH);
        const generic = parseWithProfile(content, DEGIRO_TRANSACTIONS_PROFILE, BATCH);
        compareTransactions(rel, builtin.data, generic.transactions.data).forEach((t) =>
          diffTriples.add(t),
        );
      } else if (isDegiroAccountFormat(content)) {
        kind = 'DEGIRO operacje';
        console.log(`▶ ${rel} (${kind})`);
        const builtin = parseDegiroOperations(content, BATCH);
        const generic = parseWithProfile(content, DEGIRO_ACCOUNT_PROFILE, BATCH);
        compareOperations(rel, builtin.data, generic.operations.data);
      } else {
        console.log(`▷ ${rel} — format nierozpoznany przez detektory wbudowane (pominięto)`);
        continue;
      }
    } catch (err) {
      if (err instanceof GenericParseError) {
        // W produkcji profil wybiera EXACT fingerprint nagłówków, więc profil
        // nigdy nie dostanie pliku w innym wariancie formatu. Harness paruje
        // plik↔profil zgrubnie (po detektorze brokera) — mismatch to informacja,
        // że wariant wymaga osobnego profilu, nie porażka parytetu.
        console.log(`  ℹ️  Silnik generyczny: ${err.message}`);
        console.log(
          '     (inny wariant formatu = inny fingerprint → wymaga osobnego profilu — zgodnie z projektem)',
        );
      } else {
        throw err;
      }
    }
    console.log('');
  }

  if (RESOLVER_LIVE) await resolverLive(diffTriples);

  console.log('═'.repeat(70));
  if (hardFailures === 0) {
    console.log('✅ PARYTET OSIĄGNIĘTY: brak nieoczekiwanych różnic na realnych plikach.');
  } else {
    console.log(`❌ Nieoczekiwane różnice w ${hardFailures} sekcjach — patrz raport wyżej.`);
    process.exit(1);
  }
}

main();
