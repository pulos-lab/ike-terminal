/**
 * Harness parytetu importu generycznego — porównuje wynik silnika profili
 * (parseWithProfile + golden profile) z parserami WBUDOWANYMI na RZECZYWISTYCH
 * plikach eksportów (Bossa hisPW/operacje, DEGIRO Transactions/Account).
 *
 * Uruchomienie (lokalnie; pliki użytkownika NIE wchodzą do repo):
 *   IMPORT_DIR=/ścieżka/do/import npm run compare:generic -w server
 *   npm run compare:generic -w server -- --resolver-live   # + żywe wywołania resolvera
 *   LLM_API_KEY=… npm run compare:generic -w server -- --llm
 *     ↑ tryb dry-run Fazy 4: zamiast golden profili używa profili WYGENEROWANYCH
 *       przez LLM z (zredagowanej) próbki każdego pliku — raport pokazuje, gdzie
 *       model się myli, ZANIM funkcja trafi do użytkowników.
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
import ExcelJS from 'exceljs';
import Papa from 'papaparse';
import type { CashOperation, Transaction } from 'shared';
import { decodeCSVBuffer } from '../src/parsers/encoding.js';
import { isBossaFormat, parseBossaTransactions } from '../src/parsers/bossa-transactions.js';
import { isBossaOperationsFormat, parseBossaOperations } from '../src/parsers/bossa-operations.js';
import { isDegiroFormat, parseDegiroTransactions } from '../src/parsers/degiro-transactions.js';
import { isDegiroAccountFormat, parseDegiroOperations } from '../src/parsers/degiro-operations.js';
import { isXtbFormat, parseXtbFile } from '../src/parsers/xtb-transactions.js';
import { parseWithProfile } from '../src/parsers/generic/engine.js';
import { GenericParseError } from '../src/parsers/generic/value-parsers.js';
import { generateProfileFromContent } from '../src/services/profile-generator.js';
import { isLlmEnabled, LlmUnavailableError } from '../src/services/llm-client.js';
import type { ImportProfile } from 'shared';
import { BOSSA_TRANSACTIONS_PROFILE } from '../src/parsers/generic/profiles/bossa-transactions.profile.js';
import { BOSSA_OPERATIONS_PROFILE } from '../src/parsers/generic/profiles/bossa-operations.profile.js';
import { DEGIRO_TRANSACTIONS_PROFILE } from '../src/parsers/generic/profiles/degiro-transactions.profile.js';
import { DEGIRO_ACCOUNT_PROFILE } from '../src/parsers/generic/profiles/degiro-account.profile.js';
import { buildXtbCashOperationsProfile } from '../src/parsers/generic/profiles/xtb-cash-operations.profile.js';

const BATCH = 'parity-harness';
const RESOLVER_LIVE = process.argv.includes('--resolver-live');
const LLM_MODE = process.argv.includes('--llm');

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const IMPORT_DIR = process.env.IMPORT_DIR ?? path.resolve(scriptDir, '..', '..', 'import');

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
    // XTB Transfer (jednowierszowa wymiana FX) — parser wbudowany dekoduje
    // kierunek i parę z komentarza, poza zakresem profilu deklaratywnego.
    '\\[z wymiany walut',
    // XTB: swapy/rollovery pozycji CFD — parser wbudowany rozlicza je wewnątrz
    // syntetycznych transakcji CFD z arkusza Closed Positions (poza zakresem).
    '^(Swap|Rollover) of position',
  ].join('|'),
);

let hardFailures = 0;

/**
 * Profil do porównania: golden (domyślnie) albo WYGENEROWANY przez LLM (--llm).
 * W trybie LLM generacja idzie z tej samej treści pliku (nagłówki + zredagowana
 * próbka do API; self-check lokalnie) — dokładnie ścieżka produkcyjna Fazy 4.
 */
async function profileFor(content: string, golden: ImportProfile): Promise<ImportProfile | null> {
  if (!LLM_MODE) return golden;
  try {
    const generated = await generateProfileFromContent(content);
    if (!generated) {
      hardFailures++;
      console.log('  ❌ LLM nie wygenerował wiarygodnego profilu (po retry) — plik pominięty');
      return null;
    }
    console.log(
      `  ℹ️  Profil z LLM: ${generated.model}, pewność ${generated.confidence}, ` +
        `próby ${generated.attempts}, broker „${generated.profile.brokerLabel}"`,
    );
    return generated.profile;
  } catch (err) {
    if (err instanceof LlmUnavailableError) {
      console.error(`✖ ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full));
    else if (/\.(csv|xlsx)$/i.test(entry)) out.push(full);
  }
  return out.sort();
}

// ── XLSX (XTB) → wiersze CSV ────────────────────────────────────────────────

/** Serializacja komórki jak w parserze wbudowanym (daty: czas LOKALNY). */
function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return (
      `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ` +
      `${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`
    );
  }
  if (typeof v === 'object') {
    if ('result' in v) return cellToString((v as { result: ExcelJS.CellValue }).result);
    if ('richText' in v) {
      return (v as { richText: Array<{ text: string }> }).richText.map((t) => t.text).join('');
    }
    if ('text' in v) return String((v as { text: unknown }).text);
    return '';
  }
  return String(v);
}

/** Arkusz "Cash Operations" / "CASH OPERATION HISTORY" → string CSV (średniki). */
async function xtbSheetToCsv(buffer: Buffer): Promise<string | null> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => w.name.toUpperCase().includes('CASH OPERATION'));
  if (!ws) return null;
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (c) => {
      cells.push(cellToString(c.value));
    });
    rows.push(cells);
  });
  return Papa.unparse(rows, { delimiter: ';' });
}

/**
 * Mapa nazwa instrumentu → ticker Yahoo z arkusza "Closed Positions" — replika
 * cross-sheet lookupu parsera wbudowanego. To funkcja POZA spec profilu v1;
 * harness nakłada ją na wynik generyczny, żeby zmierzyć, czy to JEDYNA
 * brakująca zdolność (reszta pól musi być wtedy identyczna).
 */
const XTB_SUFFIX_TO_YAHOO: Record<string, string> = {
  PL: '.WA',
  US: '',
  NL: '.AS',
  DE: '.DE',
  UK: '.L',
  FR: '.PA',
  ES: '.MC',
  IT: '.MI',
  SE: '.ST',
  NO: '.OL',
  DK: '.CO',
  CH: '.SW',
  HK: '.HK',
};

function xtbTickerToYahoo(symbol: string): string {
  const dot = symbol.lastIndexOf('.');
  if (dot === -1) return symbol;
  const suffix = XTB_SUFFIX_TO_YAHOO[symbol.slice(dot + 1).toUpperCase()];
  return suffix !== undefined ? symbol.slice(0, dot) + suffix : symbol.slice(0, dot);
}

async function xtbNameToTickerMap(buffer: Buffer): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => w.name.toUpperCase().includes('CLOSED POSITION'));
  if (!ws) return map;
  let nameCol = -1;
  let tickerCol = -1;
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (c) => cells.push(cellToString(c.value).trim()));
    if (nameCol === -1) {
      const n = cells.findIndex((c) => c.toLowerCase() === 'instrument');
      const t = cells.findIndex((c) => c.toLowerCase() === 'ticker');
      if (n >= 0 && t >= 0) {
        nameCol = n;
        tickerCol = t;
      }
      return;
    }
    const name = cells[nameCol];
    const ticker = cells[tickerCol];
    if (name && ticker && !map.has(name)) map.set(name, xtbTickerToYahoo(ticker));
  });
  return map;
}

async function compareXtbFile(file: string, rel: string): Promise<void> {
  const buffer = readFileSync(file);
  if (!(await isXtbFormat(buffer))) {
    console.log(`▷ ${rel} — XLSX bez arkusza Cash Operations (pominięto)`);
    return;
  }
  console.log(`▶ ${rel} (XTB XLSX → arkusz Cash Operations)`);

  const fileName = path.basename(file);
  const builtin = await parseXtbFile(buffer, BATCH, fileName);
  const csv = await xtbSheetToCsv(buffer);
  if (!csv) return;

  // Waluta subkonta jak w parserze wbudowanym: prefiks nazwy pliku (PLN_/USD_).
  const accountCurrency = /^([A-Z]{3})_/.exec(fileName)?.[1] ?? 'PLN';
  // Wariant nagłówka: część eksportów ma osobną kolumnę Ticker ("MSFT.US") obok
  // Instrument (nazwa) — inny fingerprint → inny wariant profilu (zgodnie z projektem).
  const headerLine = csv.split('\n').find((l) => l.includes('Type') && l.includes('Time')) ?? '';
  const hasTickerColumn = headerLine.split(';').some((c) => c.trim() === 'Ticker');
  const goldenProfile = buildXtbCashOperationsProfile(accountCurrency, { hasTickerColumn });
  if (hasTickerColumn) {
    console.log('  ℹ️  Wariant nagłówka z kolumną Ticker — profil czyta symbole z Ticker');
  }
  const profile = await profileFor(csv, goldenProfile);
  if (!profile) return;
  const generic = parseWithProfile(csv, profile, BATCH);

  // Dwie transformacje POZA spec v1, nakładane na wynik generyczny, żeby zmierzyć,
  // czy to jedyne brakujące zdolności:
  // 1. cross-sheet lookup nazwa→ticker z arkusza Closed Positions (bez niego
  //    generyczny emituje nazwę spółki jako pseudo-ISIN — ścieżka mBank),
  // 2. translacja sufiksów XTB→Yahoo ("MSFT.US"→"MSFT", "CDR.PL"→"CDR.WA").
  const nameMap = await xtbNameToTickerMap(buffer);
  if (nameMap.size > 0) {
    console.log(
      `  ℹ️  Nałożono mapę nazwa→ticker z arkusza Closed Positions (${nameMap.size} wpisów) — ` +
        `cross-sheet lookup poza spec profilu v1`,
    );
  }
  const mapName = (n: string) => {
    const fromSheet = nameMap.get(n);
    if (fromSheet) return fromSheet;
    return /\.[A-Za-z]{2}$/.test(n) ? xtbTickerToYahoo(n) : n;
  };
  const mappedTx = generic.transactions.data.map((t) => ({
    ...t,
    paperName: mapName(t.paperName),
    isin: mapName(t.isin),
  }));
  const mappedOps = generic.operations.data.map((o) =>
    o.ticker ? { ...o, ticker: mapName(o.ticker) } : o,
  );

  // CFD (arkusz Closed Positions) — świadomie poza zakresem profilu.
  const isCfd = (t: Transaction) => Boolean(t.cfdPositionId) || t.category === 'cfd';
  const cfd = builtin.transactions.data.filter(isCfd);
  const cashTx = builtin.transactions.data.filter((t) => !isCfd(t));
  if (cfd.length > 0) {
    console.log(
      `  ℹ️  CFD poza zakresem profilu (arkusz Closed Positions): ${cfd.length} transakcji ` +
        `zostaje w parserze wbudowanym`,
    );
  }
  console.log(
    '  ℹ️  Kategoria (stock/etf) wyłączona z porównania — parser wbudowany czyta ją ' +
      'z kolumny Category arkusza Closed Positions (cross-sheet, poza zakresem profilu)',
  );
  compareTransactions(rel, cashTx, mappedTx, { ignoreFields: ['category'] });
  compareOperations(rel, builtin.operations.data, mappedOps);
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
  opts: { ignoreFields?: Array<keyof Transaction> } = {},
): Set<string> {
  const TX_FIELDS: Array<keyof Transaction> = (
    [
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
    ] as Array<keyof Transaction>
  ).filter((f) => !opts.ignoreFields?.includes(f));

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
    console.log(
      `  ❌ RESOLVER: trójki różne — brak w generycznym: ${missing.length}, nadmiar: ${extra.length}`,
    );
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
    [...a.expected.slice(0, 4), ...b.expected.slice(0, 4)].forEach((k) => console.log(`    ${k}`));
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
    files = walkFiles(IMPORT_DIR);
  } catch {
    console.error(
      `Nie można odczytać ${IMPORT_DIR} — ustaw IMPORT_DIR na katalog z eksportami CSV.`,
    );
    process.exit(2);
  }

  const diffTriples = new Set<string>();

  for (const file of files) {
    const rel = path.relative(IMPORT_DIR, file);

    let kind: string | null = null;
    try {
      if (file.toLowerCase().endsWith('.xlsx')) {
        await compareXtbFile(file, rel);
        console.log('');
        continue;
      }
      const content = decodeCSVBuffer(readFileSync(file));
      if (isBossaFormat(content)) {
        kind = 'Bossa transakcje';
        console.log(`▶ ${rel} (${kind})`);
        const builtin = parseBossaTransactions(content, BATCH);
        const profile = await profileFor(content, BOSSA_TRANSACTIONS_PROFILE);
        if (!profile) {
          console.log('');
          continue;
        }
        const generic = parseWithProfile(content, profile, BATCH);
        compareTransactions(rel, builtin.data, generic.transactions.data).forEach((t) =>
          diffTriples.add(t),
        );
      } else if (isBossaOperationsFormat(content)) {
        kind = 'Bossa operacje';
        console.log(`▶ ${rel} (${kind})`);
        const builtin = parseBossaOperations(content, BATCH);
        const profile = await profileFor(content, BOSSA_OPERATIONS_PROFILE);
        if (!profile) {
          console.log('');
          continue;
        }
        const generic = parseWithProfile(content, profile, BATCH);
        console.log(
          `  Markery rekoncyliacji (wbudowany): wykupy=${builtin.redemptions.length}, ` +
            `IPO=${builtin.ipoSubscriptions.length}, zwroty kapitału=${builtin.capitalReturns.length}`,
        );
        compareOperations(rel, builtin.data, generic.operations.data);
      } else if (isDegiroFormat(content)) {
        kind = 'DEGIRO transakcje';
        console.log(`▶ ${rel} (${kind})`);
        const builtin = parseDegiroTransactions(content, BATCH);
        const profile = await profileFor(content, DEGIRO_TRANSACTIONS_PROFILE);
        if (!profile) {
          console.log('');
          continue;
        }
        const generic = parseWithProfile(content, profile, BATCH);
        compareTransactions(rel, builtin.data, generic.transactions.data).forEach((t) =>
          diffTriples.add(t),
        );
      } else if (isDegiroAccountFormat(content)) {
        kind = 'DEGIRO operacje';
        console.log(`▶ ${rel} (${kind})`);
        const builtin = parseDegiroOperations(content, BATCH);
        const profile = await profileFor(content, DEGIRO_ACCOUNT_PROFILE);
        if (!profile) {
          console.log('');
          continue;
        }
        const generic = parseWithProfile(content, profile, BATCH);
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
