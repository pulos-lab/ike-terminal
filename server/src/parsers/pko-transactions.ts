import Papa from 'papaparse';
import type { Transaction, SkippedRow, ParseResult } from 'shared';
import { applyIsinAlias } from 'shared';
import {
  normalizeForDetect,
  parseNumber,
  computeTotal,
  roundTo2,
  roundFxRate,
  validateTradeFields,
  parseDashedDateTime,
  detectColumnShift,
  columnShiftWarning,
  rawRowForWarning,
} from './utils.js';

/**
 * Parser PKO BP Biuro Maklerskie (Supermakler) — „Raport transakcji" CSV.
 *
 * Format: separator średnik, UTF-8 z BOM, CRLF, nagłówek nazwany. Istnieją DWA
 * pokolenia nazw kolumn — bieżące (2026):
 *   Czas zawarcia;Walor;Giełda;Waluta notowania;Oferta;Ilość;Kurs;Waluta Kurs;
 *   Wartość;Waluta Wartość;Prowizja;Waluta Prowizja;Numer transakcji;
 *   Status zlecenia;Data rozliczenia;Id zlecenia;Kwota nieopłacona;
 *   Waluta Kwota nieopłacona;Kurs przewalutowania
 * i archiwalne (2021, `public-samples/pl-archiwum-2021/myfund__PKOBP.csv`):
 *   Czas zawarcia;Walor(Portfel);Oferta;Ilość;Kurs;Kurs - waluta;Wartość;
 *   Wartość - waluta;Prowizja;Prowizja - waluta;Nr.transakcji;Data rozliczenia;
 *   Kwota nieopłacona;Status zlecenia;ID zlecenia;Giełda;Kurs przewalutowania;
 * Między pokoleniami zmieniły się NAZWY, KOLEJNOŚĆ kolumn i format daty
 * (`2021-10-06` → `06-10-2021`) — mapujemy wyłącznie po nazwach (lekcja
 * z Trading 212), nigdy po indeksach.
 *
 * Pułapki formatu (zmierzone na realnym eksporcie z 2026-08, 119 wierszy):
 * - OSTATNI WIERSZ TO STOPKA SUM — bez daty i waloru, za to z sumami ilości,
 *   wartości i prowizji. Sumuje TAKŻE wiersze anulowane, więc nie nadaje się na
 *   sumę kontrolną importu (→ skip `summary_row`).
 * - `Status zlecenia` = „Unieważnione" dla transakcji wycofanych przez giełdę
 *   (9 z 119 wierszy, 10 838,80 PLN). Wpuszczenie ich zawyżyłoby sprzedaże,
 *   więc → skip `cancelled_trade` + zbiorcze ostrzeżenie (user musi wiedzieć,
 *   czemu liczba wierszy w pliku ≠ liczba transakcji).
 * - Prowizja jest rozdzielona między fills jednego zlecenia BEZ proporcji
 *   (0,00 obok 1,90 w sąsiednich wierszach), ale suma per `Id zlecenia` daje
 *   równą stawkę (0,190% na realnym rachunku). Bierzemy ją per wiersz wprost —
 *   suma po imporcie zgadza się co do grosza.
 * - Papier to 9-znakowy SKRÓT GPW (ELEKTROTI, CYBERFLKS), ISIN-u NIE MA →
 *   pseudo-ISIN = skrót (konwencja mBank), resolver dopina realny ticker:
 *   biznesradarowy `short_name` TO dokładnie ten skrót, więc `findByName`
 *   trafia bez zgadywania (zmierzone: 17/17 walorów realnego pliku).
 * - Archiwalne pliki niosą sufiks rynku w walorze (SIMFABRIC-NC) — NIE ścinamy
 *   go (wzorzec Bossy: `-NC` włącza guard NewConnectu w resolverze).
 *
 * Waluty: realny plik jest w całości złotowy (`Kurs przewalutowania` i „Kwota
 * nieopłacona" puste w każdym wierszu), a konwencji kolumny kursu nie da się
 * z niego odczytać. Dlatego przy rozjeździe walut kurs liczymy Z KWOT
 * (`Wartość` / (ilość × `Kurs`) — konwencja payment-per-quote, jak w mBanku),
 * a kolumna z pliku służy tylko do kontroli: rozjazd > 2% idzie w ostrzeżenie.
 */

/** Nazwy kolumn obu pokoleń eksportu — po `normalizeForDetect`. */
const COLUMN_ALIASES = {
  date: ['czas zawarcia'],
  paper: ['walor', 'walor(portfel)'],
  exchange: ['gielda'],
  side: ['oferta'],
  quantity: ['ilosc'],
  price: ['kurs'],
  quoteCurrency: ['waluta notowania'],
  priceCurrency: ['waluta kurs', 'kurs - waluta'],
  value: ['wartosc'],
  valueCurrency: ['waluta wartosc', 'wartosc - waluta'],
  commission: ['prowizja'],
  commissionCurrency: ['waluta prowizja', 'prowizja - waluta'],
  transactionId: ['numer transakcji', 'nr.transakcji'],
  status: ['status zlecenia'],
  fxRate: ['kurs przewalutowania'],
} as const;

type ColumnKey = keyof typeof COLUMN_ALIASES;
type ColumnMap = Record<ColumnKey, number>;

/** Statusy zlecenia oznaczające transakcję DOSZŁĄ DO SKUTKU (oba pokolenia). */
const EXECUTED_STATUSES = new Set(['zrealizowane', 'wykonane']);

/**
 * Kody giełd PKO → waluta notowania. Realne pliki znają dwa: „WWA" (2026)
 * i „POL-GPW" (2021) — oba złotowe, oba używane także dla NewConnectu
 * (archiwalny sampel ma SIMFABRIC-NC z giełdą POL-GPW). Kodów rynków
 * zagranicznych nie znamy z żadnego pliku, więc ich NIE zgadujemy —
 * nierozpoznany kod bez kolumn walutowych daje ostrzeżenie.
 */
const EXCHANGE_CURRENCY: Record<string, string> = {
  wwa: 'PLN',
  'pol-gpw': 'PLN',
};

/** Indeks kolumny po dowolnym z aliasów; −1 = kolumny nie ma w nagłówku. */
function findColumn(cols: string[], aliases: readonly string[]): number {
  return cols.findIndex((c) => aliases.includes(c));
}

function buildColumnMap(headerCols: string[]): ColumnMap {
  const map = {} as ColumnMap;
  for (const key of Object.keys(COLUMN_ALIASES) as ColumnKey[]) {
    map[key] = findColumn(headerCols, COLUMN_ALIASES[key]);
  }
  return map;
}

/** Wiersz nagłówka + jego mapa kolumn; headerIdx = −1 gdy nagłówka nie ma. */
function findHeaderRow(rows: string[][]): { headerIdx: number; colMap: ColumnMap | null } {
  for (let i = 0; i < rows.length; i++) {
    const cols = (rows[i] ?? []).map((c) => normalizeForDetect(c ?? ''));
    const colMap = buildColumnMap(cols);
    if (colMap.date >= 0 && colMap.side >= 0 && colMap.transactionId >= 0) {
      return { headerIdx: i, colMap };
    }
  }
  return { headerIdx: -1, colMap: null };
}

/**
 * Detekcja formatu PKO — po nazwach kolumn nagłówka. Trójka „Czas zawarcia" +
 * „Oferta" + „Numer transakcji"/„Nr.transakcji" jest rozłączna z pozostałymi
 * parserami: mBank wymaga „Rodzaj"/„K/S", Bossa kolumny „ISIN", ING „Numer
 * zlecenia" albo bezgłówkowego kształtu wiersza (drugie pole = liczba).
 */
export function isPkoFormat(csvContent: string): boolean {
  const lines = csvContent.split('\n').filter((l) => l.trim() !== '');
  return lines.slice(0, 10).some((line) => {
    const cols = line.split(';').map((c) => normalizeForDetect(c));
    const colMap = buildColumnMap(cols);
    return colMap.date >= 0 && colMap.side >= 0 && colMap.transactionId >= 0;
  });
}

/** „06-10-2021 16:26:34" (bieżące) albo „2021-10-06 16:26:34" (archiwalne) → ISO. */
function parsePkoDateTime(dateStr: string): string {
  const iso = dateStr.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?/);
  if (iso) return `${iso[1]}T${iso[2] ?? '00:00:00'}`;
  return parseDashedDateTime(dateStr);
}

export function parsePkoTransactions(
  csvContent: string,
  importBatch: string,
): ParseResult<Transaction> {
  const parsed = Papa.parse(csvContent.trim(), {
    delimiter: ';',
    header: false,
    skipEmptyLines: true,
  });

  const rows = parsed.data as string[][];
  const transactions: Transaction[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: string[] = [];

  const { headerIdx, colMap } = findHeaderRow(rows);
  if (headerIdx < 0 || !colMap) return { data: [], skipped: [] };

  /** Statusy odrzuconych wierszy → licznik, do zbiorczego ostrzeżenia. */
  const cancelledByStatus = new Map<string, number>();
  /** Kody giełd, dla których nie znamy waluty i nie było kolumny walutowej. */
  const unknownExchanges = new Set<string>();
  /** Wiersze, w których „Wartość" ≠ ilość × kurs (± tolerancja). */
  let valueMismatches = 0;
  /** Wiersze, w których kolumna „Kurs przewalutowania" ≠ kurs z kwot. */
  let fxRateMismatches = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rowNum = i + 1;
    const at = (idx: number) => (idx >= 0 ? (row[idx]?.trim() ?? '') : '');

    const dateStr = at(colMap.date);
    const paper = at(colMap.paper);
    const valueStr = at(colMap.value);

    // Stopka: sumy bez daty i waloru. Świadomy skip BEZ `raw` — nie ma czego
    // wyjaśniać w skrzynce, a wartości i tak obejmują wiersze anulowane.
    if (!dateStr && !paper && (valueStr || at(colMap.quantity))) {
      skipped.push({ row: rowNum, reason: 'summary_row' });
      continue;
    }

    const statusNorm = normalizeForDetect(at(colMap.status));
    if (statusNorm && !EXECUTED_STATUSES.has(statusNorm)) {
      const label = at(colMap.status);
      cancelledByStatus.set(label, (cancelledByStatus.get(label) ?? 0) + 1);
      skipped.push({ row: rowNum, reason: 'cancelled_trade', paperName: paper });
      continue;
    }

    const qtyStr = at(colMap.quantity);
    const priceStr = at(colMap.price);
    const commissionStr = at(colMap.commission);

    // Ochrona przed przesunięciem kolumn — sygnały treści, nie liczba kolumn.
    const shiftProblems = detectColumnShift([
      { label: 'Czas zawarcia', value: dateStr, kind: 'date' },
      { label: 'Ilość', value: qtyStr, kind: 'number' },
      { label: 'Kurs', value: priceStr, kind: 'number' },
      { label: 'Wartość', value: valueStr, kind: 'number' },
      { label: 'Prowizja', value: commissionStr, kind: 'number' },
      { label: 'Waluta Kurs', value: at(colMap.priceCurrency), kind: 'currency' },
      { label: 'Waluta Wartość', value: at(colMap.valueCurrency), kind: 'currency' },
    ]);
    if (shiftProblems.length > 0) {
      skipped.push({ row: rowNum, reason: 'column_shift', paperName: paper });
      warnings.push(columnShiftWarning(rowNum, shiftProblems, rawRowForWarning(row, ';')));
      continue;
    }

    const sideNorm = normalizeForDetect(at(colMap.side));
    const side: 'K' | 'S' | '' =
      sideNorm === 'kupno' || sideNorm === 'k'
        ? 'K'
        : sideNorm === 'sprzedaz' || sideNorm === 's'
          ? 'S'
          : '';
    const quantity = parseNumber(qtyStr);
    const price = parseNumber(priceStr);

    const check = validateTradeFields({
      date: dateStr,
      paperName: paper,
      side,
      quantity,
      price,
    });
    if (!check.ok) {
      skipped.push({ row: rowNum, reason: check.reason, paperName: paper });
      continue;
    }

    const isoDate = parsePkoDateTime(dateStr);
    const commission = parseNumber(commissionStr);
    const expectedValue = roundTo2(quantity * price);
    const value = valueStr ? parseNumber(valueStr) : expectedValue;

    const exchange = normalizeForDetect(at(colMap.exchange));
    const quoteCurrency = at(colMap.quoteCurrency) || at(colMap.priceCurrency);
    const currency = quoteCurrency || EXCHANGE_CURRENCY[exchange] || 'PLN';
    if (!quoteCurrency && exchange && !EXCHANGE_CURRENCY[exchange]) unknownExchanges.add(exchange);
    const paymentCurrency = at(colMap.valueCurrency) || currency;

    // Kontrola spójności kwot — TYLKO w jednej walucie: przy rozliczeniu w innej
    // walucie niż notowanie „Wartość" z definicji nie równa się ilość × kurs
    // (o to chodzi w kursie niżej). Papier notowany w % nominału (obligacje
    // Catalyst) rozjedzie się tu z natury — ostrzegamy, ale wiersza nie odrzucamy.
    if (
      paymentCurrency === currency &&
      Math.abs(value - expectedValue) > Math.max(0.02, expectedValue * 0.005)
    ) {
      valueMismatches++;
    }

    // Kurs bierzemy Z KWOT (payment-per-quote), a nie z kolumny pliku — jej
    // konwencji nie potwierdza żaden realny plik. Kolumna służy do kontroli.
    let fxRate: number | undefined;
    if (paymentCurrency !== currency) {
      const implied = expectedValue > 0 ? roundFxRate(value / expectedValue) : 0;
      const fromFile = parseNumber(at(colMap.fxRate));
      if (implied > 0) {
        fxRate = implied;
        if (fromFile > 0 && Math.abs(fromFile - implied) / implied > 0.02) fxRateMismatches++;
      } else if (fromFile > 0) {
        fxRate = fromFile;
      }
    }

    // Pseudo-ISIN = skrót GPW (konwencja mBank); alias PDA→akcje (ZKA1→ZABKA)
    // przed zapisem, żeby obie nogi pozycji zbiegły do jednego papieru.
    const alias = applyIsinAlias(paper, paper, isoDate);

    transactions.push({
      date: isoDate,
      paperName: alias.paperName,
      isin: alias.isin,
      quantity: Math.round(quantity),
      side: side as 'K' | 'S',
      price,
      value: roundTo2(value),
      commission,
      total: computeTotal(side as 'K' | 'S', roundTo2(value), commission),
      currency,
      paymentCurrency,
      fxRate,
      source: 'pko',
      importBatch,
    });
  }

  const cancelledTotal = [...cancelledByStatus.values()].reduce((s, n) => s + n, 0);
  if (cancelledTotal > 0) {
    const breakdown = [...cancelledByStatus.entries()]
      .map(([status, count]) => `„${status}" — ${count}`)
      .join('; ');
    warnings.push(
      `PKO: pominięto ${cancelledTotal} wierszy o statusie innym niż „Zrealizowane" ` +
        `(${breakdown}). To zlecenia wycofane — nie są transakcjami, ale liczy je ` +
        `wiersz podsumowania na końcu raportu.`,
    );
  }
  if (unknownExchanges.size > 0) {
    warnings.push(
      `PKO: nieznane kody giełd (${[...unknownExchanges].join(', ').toUpperCase()}) w pliku bez ` +
        `kolumny waluty notowania — przyjęto PLN. Zgłoś ten plik, jeśli dotyczy rynku zagranicznego.`,
    );
  }
  if (valueMismatches > 0) {
    warnings.push(
      `PKO: w ${valueMismatches} wierszach „Wartość" różni się od ilość × kurs — sprawdź te ` +
        `transakcje. Typowa przyczyna to papier notowany w % nominału (obligacje Catalyst).`,
    );
  }
  if (fxRateMismatches > 0) {
    warnings.push(
      `PKO: w ${fxRateMismatches} wierszach „Kurs przewalutowania" z pliku różni się o >2% od ` +
        `kursu wyliczonego z kwot — użyto kursu z kwot. Zgłoś ten plik, żebyśmy ustalili ` +
        `konwencję kolumny.`,
    );
  }

  return {
    data: transactions,
    skipped,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}
