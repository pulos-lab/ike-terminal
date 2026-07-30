import Papa from 'papaparse';
import type { Transaction, ParseResult, SkippedRow } from 'shared';
import {
  normalizeForDetect,
  parseNumber,
  roundTo2,
  computeTotal,
  validateTradeFields,
  parseDottedDate,
  detectColumnShift,
  columnShiftWarning,
  rawRowForWarning,
  roundFxRate,
} from './utils.js';

/**
 * Parse mBank eMakler transaction CSV.
 *
 * Real eMakler exports have ~34 lines of bank metadata before the actual data.
 * We scan for the header row, then parse data rows below it.
 *
 * Header: Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta
 *
 * Delimiter: auto-detected (semicolon in older exports, comma in newer ones).
 *
 * mBank does NOT provide ISIN — only instrument name ("Papier").
 * The ISIN field is set to the ticker name; real ISINs are resolved after import.
 *
 * Commission and currency columns may be empty in newer exports.
 * When empty, commission defaults to 0 (charged separately in operations file,
 * similar to DEGIRO), and currency is inferred from the exchange column (Giełda).
 */

/**
 * mBank exchange name → quote currency mapping.
 *
 * Fallback używany WYŁĄCZNIE gdy w pliku brakuje kolumny „Waluta" po kursie.
 * Kody z realnych eksportów (2007–2026) to `USA-NYSE`, `USA-NASDAQ`, `WWA-GPW`,
 * `GBR-LSE`, `DEU-XETRA`; warianty `UK-`/`GER-` zostają dla starszych plików.
 *
 * UWAGA na `GBR-LSE`: londyńskie ETF-y bywają kwotowane w USD (np. VUAA LN ETF
 * w realnym eksporcie ma `Kurs` w USD), więc GBP to tylko domysł. Użycie tego
 * fallbacku zawsze generuje ostrzeżenie — waluta z pliku ma pierwszeństwo.
 */
const EXCHANGE_CURRENCY: Record<string, string> = {
  'USA-NASDAQ': 'USD',
  'USA-NYSE': 'USD',
  'USA-AMEX': 'USD',
  'WWA-GPW': 'PLN',
  'WWA-NC': 'PLN',
  'DEU-XETRA': 'EUR',
  'DEU-FSE': 'EUR',
  'GER-XETRA': 'EUR',
  'GER-FSE': 'EUR',
  'GBR-LSE': 'GBP',
  'UK-LSE': 'GBP',
};

export function parseMbankTransactions(
  csvContent: string,
  importBatch: string,
): ParseResult<Transaction> & { warnings?: string[] } {
  const lines = csvContent.split('\n');

  // Find header row — look for line containing "Czas" and "Papier" (or legacy "Walor")
  const { headerIdx, colMap, delimiter } = findHeaderRow(lines);
  if (headerIdx < 0 || !colMap) return { data: [], skipped: [] };

  // Join only data rows (after header) and parse with Papa
  const dataSection = lines.slice(headerIdx + 1).join('\n');
  const result = Papa.parse(dataSection.trim(), {
    delimiter,
    header: false,
    skipEmptyLines: true,
  });

  const rows = result.data as string[][];
  const transactions: Transaction[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: string[] = [];
  /** Wiersze walutowe bez możliwości wyliczenia kursu (brak kolumny „Wartość"). */
  let fxUnavailable = 0;
  /** Wiersze, w których prowizja w innej walucie musiała zostać pominięta. */
  let commissionDropped = 0;
  /** Wiersze, w których walutę zgadywano z kolumny „Giełda". */
  let exchangeFallback = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = headerIdx + 2 + i; // 1-based, accounting for header offset
    const paperName = row ? row[colMap.paper]?.trim() : undefined;

    if (!row || row.length < 6) {
      skipped.push({ row: rowNum, reason: 'short_row', paperName });
      continue;
    }

    // Kolumny z indeksem −1 = nieobecne w nagłówku → pole traktowane jako puste
    // (prowizja 0, waluta z giełdy / PLN) zamiast czytania zgadywanego indeksu.
    const at = (idx: number): string | undefined => (idx >= 0 ? row[idx] : undefined);
    const dateStr = at(colMap.date)?.trim();
    const side = at(colMap.side)?.trim();
    const quantity = parseNumber(at(colMap.quantity));
    const price = parseNumber(at(colMap.price));
    const priceCurrency = at(colMap.priceCurrency)?.trim();
    const commission = parseNumber(at(colMap.commission));
    const exchange = at(colMap.exchange)?.trim();
    // Kolumna „Wartość" = kwota rozliczenia w walucie rachunku (PLN), NIE ilość×kurs.
    // Zweryfikowane na 267 wierszach realnego rachunku: dla wierszy jednowalutowych
    // Wartość == ilość×kurs co do grosza (68/68), prowizja nigdy nie wchodzi do Wartości.
    const settleValue = parseNumber(at(colMap.value));
    const settleCurrency = at(colMap.valueCurrency)?.trim();
    const commissionCurrency = at(colMap.commissionCurrency)?.trim();

    // Ochrona przed cichym przesunięciem kolumn (dodatkowy separator w którymś polu):
    // sygnały treści, nie liczba kolumn. Kolumny z indeksem −1 dają undefined = brak sygnału.
    const shiftProblems = detectColumnShift([
      { label: 'Czas transakcji', value: dateStr, kind: 'date' },
      { label: 'Liczba', value: at(colMap.quantity), kind: 'number' },
      { label: 'Kurs', value: at(colMap.price), kind: 'number' },
      { label: 'Prowizja', value: at(colMap.commission), kind: 'number' },
      { label: 'Waluta', value: priceCurrency, kind: 'currency' },
    ]);
    if (shiftProblems.length > 0) {
      skipped.push({ row: rowNum, reason: 'column_shift', paperName: paperName || undefined });
      warnings.push(columnShiftWarning(rowNum, shiftProblems, rawRowForWarning(row, delimiter)));
      continue;
    }

    // Wspólna walidacja pól (utils.validateTradeFields) — mBank wymaga nazwy papieru,
    // ISIN nie istnieje w eksporcie (resolwowany po imporcie).
    const check = validateTradeFields({ date: dateStr, paperName, side, quantity, price });
    if (!check.ok) {
      skipped.push({ row: rowNum, reason: check.reason, paperName: paperName || undefined });
      continue;
    }

    const isoDate = parseDottedDate(dateStr!);
    const value = roundTo2(quantity * price);
    // Infer currency from exchange column when price currency is empty
    const currency = priceCurrency || EXCHANGE_CURRENCY[exchange || ''] || 'PLN';
    if (!priceCurrency && exchange && EXCHANGE_CURRENCY[exchange]) exchangeFallback++;

    // Waluta rozliczenia z pliku. eMakler to rachunek złotowy — przy papierze
    // notowanym w USD/EUR mBank przewalutowuje po WŁASNYM kursie i obciąża konto
    // kwotą z kolumny „Wartość". Wcześniej paymentCurrency było zaszyte na 'PLN'.
    const paymentCurrency = settleCurrency || 'PLN';

    // Kurs rozliczenia wprost z pliku (konwencja payment-per-quote, jak Transaction.fxRate
    // i parser XTB): Wartość[PLN] / (ilość × Kurs[USD]). Na realnym rachunku daje
    // 3,54–4,36 dla USD/PLN (mediana 3,7035) z rozrzutem w dniu <0,35% (spread mBanku
    // per zlecenie). Bez tego silnik przeliczał total kursem rynkowym z Yahoo.
    let fxRate: number | undefined;
    if (paymentCurrency !== currency && settleValue > 0 && value > 0) {
      fxRate = roundFxRate(settleValue / value);
    }

    // Prowizja jest naliczana od kwoty W PLN (0,29% zagranica / 0,39% GPW wg taryfy,
    // potwierdzone co do grosza na 114 ze 164 zleceń zagranicznych — reszta to prowizja
    // minimalna). `total` musi zostać w walucie kwotowania, bo silnik liczy przepływ
    // jako total × fxRate — więc prowizję przeliczamy na walutę kwotowania.
    const commissionCcy = commissionCurrency || paymentCurrency;
    let commissionQuote = commission;
    if (commission !== 0 && commissionCcy !== currency) {
      if (fxRate) {
        commissionQuote = roundTo2(commission / fxRate);
      } else {
        commissionQuote = 0; // lepiej pominąć niż doliczyć złotówki do dolarów
        commissionDropped++;
      }
    }
    const total = computeTotal(side as 'K' | 'S', value, commissionQuote);

    if (paymentCurrency !== currency && !fxRate) fxUnavailable++;

    transactions.push({
      date: isoDate,
      paperName: paperName!, // zwalidowane w validateTradeFields wyżej
      isin: paperName!, // Placeholder — resolved after import via ticker name
      quantity: Math.round(quantity), // GPW/NC: only whole shares; round removes CSV floating-point noise
      side: side as 'K' | 'S',
      price,
      value,
      commission: commissionQuote, // w walucie kwotowania (patrz wyżej); 0 gdy plik jej nie podaje
      total,
      currency, // quote — priceCurrency or inferred from exchange
      paymentCurrency, // waluta rozliczenia z kolumny przy „Wartość" (rachunek eMakler = PLN)
      fxRate, // kurs mBanku z pliku; undefined gdy rozliczenie w walucie kwotowania
      source: 'mbank',
      importBatch,
    });
  }

  // Jedno zagregowane ostrzeżenie gdy w nagłówku brakuje opcjonalnych kolumn —
  // wcześniej kod zgadywał stałe indeksy (prowizja→7, waluta→6, giełda→2) i mógł
  // cicho czytać złe kolumny. Teraz pole jest nieobecne + user dostaje informację.
  const missingCols: string[] = [];
  if (colMap.commission < 0) missingCols.push('Prowizja (przyjęto 0)');
  if (colMap.priceCurrency < 0) missingCols.push('Waluta kursu (inferowana z giełdy lub PLN)');
  if (colMap.exchange < 0) missingCols.push('Giełda (waluta domyślnie PLN)');
  if (colMap.value < 0) missingCols.push('Wartość (brak kursu przewalutowania)');
  if (missingCols.length > 0 && transactions.length > 0) {
    // Ostrzeżenie o brakujących kolumnach zostaje JEDNO i zagregowane — dopisujemy
    // do niego skutek inferencji zamiast mnożyć komunikaty o tej samej przyczynie.
    const fallbackNote =
      exchangeFallback > 0
        ? ` Walutę kwotowania wywnioskowano z kolumny „Giełda" w ${exchangeFallback} transakcjach — ` +
          `sprawdź papiery z LSE, bywają notowane w USD mimo giełdy w GBR.`
        : '';
    warnings.push(
      `mBank: w nagłówku pliku brakuje kolumn: ${missingCols.join('; ')} — ` +
        `zweryfikuj prowizje i waluty zaimportowanych transakcji.${fallbackNote}`,
    );
  }
  if (fxUnavailable > 0) {
    warnings.push(
      `mBank: ${fxUnavailable} transakcji w walucie obcej bez kwoty rozliczenia w pliku — ` +
        `kurs przewalutowania nie został wyliczony, silnik użyje kursu rynkowego z dnia transakcji.`,
    );
  }
  if (commissionDropped > 0) {
    warnings.push(
      `mBank: w ${commissionDropped} transakcjach pominięto prowizję — jest podana w innej ` +
        `walucie niż kurs, a bez kwoty rozliczenia nie da się jej przeliczyć.`,
    );
  }

  return { data: transactions, skipped, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * Detect if CSV content looks like mBank eMakler transaction format.
 * Scans all lines (real exports have ~34 lines of metadata before headers).
 */
export function isMbankFormat(csvContent: string): boolean {
  const lines = csvContent.split('\n');
  for (const line of lines) {
    const lower = normalizeForDetect(line);
    // Real export header: "Czas transakcji;Papier;Giełda;K/S;..."
    // or comma-delimited: "Czas transakcji,Papier,Giełda,K/S,..."
    if (lower.includes('czas transakcji') && lower.includes('papier') && lower.includes('k/s')) {
      return true;
    }
    // Legacy/test format: "Czas;Walor;Giełda;Rodzaj;..."
    if (lower.includes('czas') && lower.includes('walor') && lower.includes('rodzaj')) {
      return true;
    }
  }
  // Also check for mBank metadata markers
  const content = normalizeForDetect(csvContent.substring(0, 2000));
  return content.includes('emakler') && content.includes('historia transakcji');
}

/**
 * Find header row, auto-detect delimiter, and build column index map.
 * Supports both semicolon (older exports) and comma (newer exports) delimiters.
 * Supports both real export format and legacy/test format.
 */
function findHeaderRow(lines: string[]): {
  headerIdx: number;
  colMap: ColumnMap | null;
  delimiter: string;
} {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();

    // Auto-detect delimiter: if the line has semicolons use ';', otherwise ','
    const delimiter = lower.includes(';') ? ';' : ',';
    const cols = line.split(delimiter).map((c) => c.trim().toLowerCase());

    // Real format: "Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta"
    const dateIdx = cols.findIndex((c) => c === 'czas transakcji' || c === 'czas');
    const paperIdx = cols.findIndex((c) => c === 'papier' || c === 'walor');
    const sideIdx = cols.findIndex((c) => c === 'k/s' || c === 'rodzaj');

    if (dateIdx >= 0 && paperIdx >= 0 && sideIdx >= 0) {
      // Find other columns by name
      const exchangeIdx = cols.findIndex(
        (c) => c === 'gie\u0142da' || c === 'gielda' || c === 'gie\u00b3da',
      );
      const quantityIdx = cols.findIndex((c) => c === 'liczba');
      const priceIdx = cols.findIndex((c) => c === 'kurs');

      // Find commission (Prowizja) — may appear before or after Wartość
      const prowizjaIdx = cols.indexOf('prowizja');

      // Price currency is the first Waluta after Kurs
      const priceCurrencyIdx = priceIdx >= 0 ? cols.indexOf('waluta', priceIdx + 1) : -1;

      // Kwota rozliczenia + jej waluta: „…;Prowizja;Waluta;Wartość;Waluta".
      // startsWith('warto') zamiast równości — pliki bywają dekodowane z CP1250
      // niepoprawnie i „Wartość" przychodzi jako „Warto¶æ" (tak jak „Giełda"→„Gie³da").
      const commissionCurrencyIdx = prowizjaIdx >= 0 ? cols.indexOf('waluta', prowizjaIdx + 1) : -1;
      const valueIdx = cols.findIndex((c) => c.startsWith('warto'));
      const valueCurrencyIdx = valueIdx >= 0 ? cols.indexOf('waluta', valueIdx + 1) : -1;

      // Indeksy pozycyjne TYLKO tam, gdzie są niezbędne dla znanego formatu legacy
      // ("Czas;Walor;Giełda;Rodzaj;Liczba;Kurs;..."): liczba→4 i kurs→5 — bez nich
      // legacy nie sparsowałby się wcale (pola obowiązkowe walidacji). Pozostałe
      // kolumny (giełda/waluta/prowizja) przy braku nagłówka dostają −1 = pole
      // NIEOBECNE: prowizja = 0, waluta z giełdy lub PLN. Zgadywanie stałych
      // indeksów (2/6/7) potrafiło cicho czytać złe kolumny w wariantach layoutu.
      return {
        headerIdx: i,
        delimiter,
        colMap: {
          date: dateIdx,
          paper: paperIdx,
          exchange: exchangeIdx,
          side: sideIdx,
          quantity: quantityIdx >= 0 ? quantityIdx : 4,
          price: priceIdx >= 0 ? priceIdx : 5,
          priceCurrency: priceCurrencyIdx,
          commission: prowizjaIdx,
          commissionCurrency: commissionCurrencyIdx,
          value: valueIdx,
          valueCurrency: valueCurrencyIdx,
        },
      };
    }
  }

  return { headerIdx: -1, colMap: null, delimiter: ',' };
}

interface ColumnMap {
  date: number;
  paper: number;
  /** −1 = kolumna nieobecna w nagłówku — brak inferencji waluty z giełdy */
  exchange: number;
  side: number;
  quantity: number;
  price: number;
  /** −1 = kolumna nieobecna w nagłówku — waluta inferowana z giełdy / PLN */
  priceCurrency: number;
  /** −1 = kolumna nieobecna w nagłówku — prowizja przyjęta jako 0 */
  commission: number;
  /** Waluta prowizji (kolumna „Waluta" po „Prowizja"). −1 = przyjmujemy walutę rozliczenia. */
  commissionCurrency: number;
  /** Kwota rozliczenia („Wartość"). −1 = brak → nie da się wyliczyć kursu przewalutowania. */
  value: number;
  /** Waluta kwoty rozliczenia (kolumna „Waluta" po „Wartość"). −1 = przyjmujemy PLN. */
  valueCurrency: number;
}
