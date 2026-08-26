import Papa from 'papaparse';
import type { CashOperation, SkippedRow, RedemptionMarker, ParseResult } from 'shared';
import {
  normalizeForDetect,
  parseNumber,
  roundTo2,
  parseDashedDateTime,
  detectColumnShift,
  columnShiftWarning,
  rawRowForWarning,
} from './utils.js';

/**
 * Parse ING Biuro Maklerskie financial history CSV (historiaFinansowa_*.csv).
 *
 * Format: semicolon delimited, Windows-1250 (pre-decoded), BEZ nagłówka,
 * wiersze od NAJNOWSZYCH, 7 kolumn pozycyjnych:
 *   Lp;Data;Kategoria;Opis;Kwota;Saldo;Waluta
 * Pola z średnikiem w treści są cytowane (`"Blokada;PZE/…"`) — parsowanie
 * MUSI iść przez PapaParse z obsługą cudzysłowów, naiwny split się wywraca.
 *
 * ING eksportuje historię finansową OSOBNO per waluta rachunku (PLN, GBP, …);
 * waluta operacji idzie z ostatniej kolumny. Transakcje ING są wyłącznie w PLN,
 * a waluty obce to same wpływy (dywidendy, wykupy) — bez auto-przewalutowania.
 *
 * Model zdarzeń (zmierzony na realnych plikach):
 * - KUPNA nie mają wiersza rozliczenia — cash idzie przez rodzinę blokad
 *   (Blokada/Zwolnienie/Aktualizacja/Modyfikacja/Anulata) → wszystkie SKIP;
 *   źródłem transakcji jest plik historiaTransakcji.
 * - SPRZEDAŻE są zdublowane: fill w pliku transakcji + „Rozliczenie transakcji
 *   sprzedaży nr N do zlecenia M, ISIN, qty x cena" per fill tutaj → SKIP
 *   (settlement_record), inaczej cash liczyłby się podwójnie.
 * - Wiersze rozliczeń i blokad niosą parę (numer zlecenia, ISIN) — zbieramy ją
 *   do `orderIsinMap`; import-service doszywa realne ISIN-y do transakcji
 *   (plik transakcji ma tylko tickery GPW).
 * - Dywidendy: wiersz brutto `DVCA … - rozliczenie` + OSOBNY wiersz podatku
 *   `… - podatek` (tylko PLN; GBP bez podatku) + bywają `Anulata:` (storno).
 *   Parujemy po ISIN+dacie w jedną operację netto (wzorzec DEGIRO).
 * - Wykup przymusowy (`LAP1 Wykup przymusowy ISIN: qty x cena WAL`) ma PUSTĄ
 *   kategorię → RedemptionMarker(source 'ing') z jawnym qty/ceną z opisu.
 *
 * PUŁAPKA LICZB: kwoty w kolumnach mają kropkę dziesiętną, ale ilości w OPISACH
 * używają kropki jako separatora TYSIĘCY („1.000 x 4,70" = 1000 szt) —
 * parseNumber('1.000') dałby 1 → ilości z opisów idą przez parseIngDescQty.
 */

// ── Wynik parsera ──

export interface IngOperationsParseResult extends ParseResult<CashOperation> {
  /** Wykupy przymusowe → syntetyczna S w reconciliation (reconcileIngRedemptions). */
  redemptions: RedemptionMarker[];
  /**
   * numer zlecenia → realny ISIN, zebrane z opisów rozliczeń sprzedaży i blokad
   * kupna/IPO. import-service doszywa te ISIN-y do transakcji (po tx.orderId)
   * przed insertem — plik transakcji ING zna tylko tickery GPW.
   */
  orderIsinMap: Map<string, string>;
}

// ── Detekcja ──

/** Wiersz księgi ING: "2;30-07-2025;Wpłaty/wypłaty;…;-8770.63;0.00;PLN" */
const ING_OPS_ROW_RE = /^\d+;\d{2}-\d{2}-\d{4};/;

/**
 * Tokeny treści (po normalizeForDetect) potwierdzające księgę ING — sam kształt
 * `lp;data;…` mają też inne eksporty bankowe (np. NIBC w public-samples), ale
 * tamte zaczynają się nagłówkiem, a tych fraz nie zawierają.
 */
const ING_OPS_TOKENS = [
  'saldo poczatkowe',
  'saldo koncowe',
  'wplaty/wyplaty',
  'rozliczenie transakcji sprzedazy',
  'dvca dywidenda',
];

/**
 * Detect ING financial history CSV — bezgłówkowy: pierwsza niepusta linia musi
 * być wierszem księgi zakończonym kodem waluty, a treść zawierać znany token.
 */
export function isIngOperationsFormat(csvContent: string): boolean {
  const lines = csvContent.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) return false;
  const first = lines[0].trim();
  if (!ING_OPS_ROW_RE.test(first)) return false;
  if (!/;[A-Z]{3}$/.test(first)) return false;
  const normalized = normalizeForDetect(csvContent.slice(0, 20000));
  return ING_OPS_TOKENS.some((t) => normalized.includes(t));
}

// ── Wzorce klasyfikacji ──

/** ISIN: 2 litery kraju + 10 znaków. */
const ISIN = '([A-Z]{2}[A-Z0-9]{10})';

/** "Rozliczenie transakcji sprzedaży nr 1128 do zlecenia 937900176, PLPKN0000018, 78 x 83,84" */
const SELL_SETTLEMENT_RE = new RegExp(
  `^Rozliczenie transakcji sprzeda[żz]y nr \\d+ do zlecenia (\\d+), ${ISIN},`,
);

/** Rodzina blokad Z numerem zlecenia i ISIN-em — harvest pary, potem skip. */
const BLOCK_WITH_ISIN_RES: RegExp[] = [
  new RegExp(`^Blokada pod zlecenie kupna (\\d+), ${ISIN}`),
  new RegExp(`^Zwolnienie blokady pod zlecenie kupna (\\d+), ${ISIN}`),
  new RegExp(`^Anulata zlecenia kupna (\\d+), ${ISIN}`),
  new RegExp(`^Modyfikacja zlecenia kupna (\\d+), ${ISIN}`),
  new RegExp(`^Blokada pod zapis na IPO, (\\d+), ${ISIN}`),
  new RegExp(`^Anulowanie zapisu na IPO, (\\d+), ${ISIN}`),
];

/** Blokady bez pary (orderId, ISIN) — sam skip. */
const BLOCK_PLAIN_RES: RegExp[] = [
  /^Aktualizacja blokady$/,
  /^Zwolnienie blokady pod zapis na IPO/,
];

/** Wpłata: "WPL/3977466/Zasilenie rachunku" */
const DEPOSIT_RE = /^WPL\/\d+\/Zasilenie rachunku/;

/**
 * Wypłata na rachunek bankowy — TAK ją nazywa ING: "Blokada;PZE/4279207/Z … NA PL03…"
 * (średnik w treści → pole jest cytowane w CSV). Kierunek ze znaku kwoty.
 */
const WITHDRAWAL_PZE_RE = /^Blokada;PZE\//;

/** Dywidenda brutto: "DVCA Dywidenda pieniężna PLPKN0000018: 105 x 4,15 PLN - rozliczenie" */
const DIVIDEND_GROSS_RE = new RegExp(
  `^DVCA Dywidenda pieni[ęe][żz]na ${ISIN}: (\\S+) x ([\\d.,]+) ([A-Z]{3}) - rozliczenie$`,
);

/** Podatek od dywidendy: "… - podatek" (osobny wiersz, ujemny, tylko PLN). */
const DIVIDEND_TAX_RE = new RegExp(
  `^DVCA Dywidenda pieni[ęe][żz]na ${ISIN}: (\\S+) x ([\\d.,]+) ([A-Z]{3}) - podatek$`,
);

/** Storno dywidendy: "Anulata: DVCA Dywidenda pieniężna GB00B1YKG049: … - rozliczenie" */
const DIVIDEND_REVERSAL_RE = new RegExp(
  `^Anulata: DVCA Dywidenda pieni[ęe][żz]na ${ISIN}: (\\S+) x ([\\d.,]+) ([A-Z]{3}) - rozliczenie$`,
);

/**
 * Wykup przymusowy (squeeze-out): "LAP1 Wykup przymusowy GB00B1YKG049: 360 x 2,35 GBP - rozliczenie".
 * Prefiks kodu zdarzenia (LAP1) jest opcjonalny — nie znamy pełnego katalogu kodów ING.
 */
const FORCED_BUYOUT_RE = new RegExp(
  `^(?:[A-Z0-9]{2,6} )?Wykup przymusowy ${ISIN}: (\\S+) x ([\\d.,]+) ([A-Z]{3}) - rozliczenie$`,
);

/**
 * Ilość sztuk z OPISU zdarzenia ING — kropka jest tam separatorem TYSIĘCY
 * („1.000" = 1000 szt, „4.900" = 4900 szt), czego parseNumber nie może założyć
 * (dla kwot kropka to separator dziesiętny). Eksportowane do testów.
 */
export function parseIngDescQty(token: string): number {
  const t = token.trim();
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return parseInt(t.replace(/\./g, ''), 10);
  return parseNumber(t);
}

// ── Parser ──

interface DividendRow {
  rowNum: number;
  isoDate: string;
  isin: string;
  qtyToken: string;
  rateToken: string;
  amount: number;
  currency: string;
  description: string;
}

export function parseIngOperations(
  csvContent: string,
  importBatch: string,
): IngOperationsParseResult {
  const result = Papa.parse(csvContent.trim(), {
    delimiter: ';',
    header: false,
    skipEmptyLines: true,
  });

  const rows = result.data as string[][];
  const operations: CashOperation[] = [];
  const skipped: SkippedRow[] = [];
  const warnings: string[] = [];
  const redemptions: RedemptionMarker[] = [];
  const orderIsinMap = new Map<string, string>();
  /** Zlecenia z konfliktem ISIN — usunięte z mapy i nie wracają. */
  const conflictedOrders = new Set<string>();

  const harvest = (orderId: string, isin: string) => {
    if (conflictedOrders.has(orderId)) return;
    const existing = orderIsinMap.get(orderId);
    if (existing && existing !== isin) {
      orderIsinMap.delete(orderId);
      conflictedOrders.add(orderId);
      warnings.push(
        `ING: zlecenie ${orderId} występuje w historii finansowej z dwoma różnymi ISIN-ami ` +
          `(${existing}, ${isin}) — pomijam je przy uzupełnianiu ISIN-ów transakcji.`,
      );
      return;
    }
    orderIsinMap.set(orderId, isin);
  };

  // Dywidendy zbieramy do kubełków i parujemy PO pętli — plik jest od
  // najnowszych, a storno/podatek mogą stać po dowolnej stronie wiersza brutto.
  const grossRows: DividendRow[] = [];
  const taxRows: (DividendRow & { used?: boolean })[] = [];
  const reversalRows: (DividendRow & { used?: boolean })[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    if (!row || row.length < 7) {
      skipped.push({ row: rowNum, reason: 'short_row' });
      continue;
    }

    const dateStr = row[1]?.trim() ?? '';
    const category = row[2]?.trim() ?? '';
    const description = row[3]?.trim() ?? '';
    const amountStr = row[4]?.trim() ?? '';
    const currency = row[6]?.trim().toUpperCase() ?? '';

    // Salda otwarcia/zamknięcia — wiersze informacyjne bez kwoty operacji.
    if (description === 'Saldo początkowe' || description === 'Saldo końcowe') {
      skipped.push({ row: rowNum, reason: 'summary_row', paperName: description });
      continue;
    }

    // Ochrona przed przesunięciem kolumn (Opis bywa wolnym tekstem; cytowanie
    // łapie średniki, ale zepsuty ręcznie plik może się rozjechać).
    const shiftProblems = detectColumnShift([
      { label: 'Data', value: dateStr, kind: 'date' },
      { label: 'Kwota', value: amountStr, kind: 'number' },
      { label: 'Waluta', value: currency, kind: 'currency' },
    ]);
    if (shiftProblems.length > 0) {
      skipped.push({ row: rowNum, reason: 'column_shift', paperName: description });
      warnings.push(columnShiftWarning(rowNum, shiftProblems, rawRowForWarning(row, ';')));
      continue;
    }

    const isoDate = parseDashedDateTime(dateStr);
    const amount = parseNumber(amountStr);

    // ── Rozliczenia sprzedaży: harvest (orderId, ISIN) + skip (dublują plik transakcji) ──
    const sell = SELL_SETTLEMENT_RE.exec(description);
    if (sell) {
      harvest(sell[1], sell[2]);
      skipped.push({ row: rowNum, reason: 'settlement_record', paperName: description });
      continue;
    }

    // ── Rodzina blokad: harvest gdzie jest ISIN, zawsze skip ──
    const blockMatch = BLOCK_WITH_ISIN_RES.map((re) => re.exec(description)).find(Boolean);
    if (blockMatch) {
      harvest(blockMatch[1], blockMatch[2]);
      skipped.push({ row: rowNum, reason: 'settlement_record', paperName: description });
      continue;
    }
    if (BLOCK_PLAIN_RES.some((re) => re.test(description))) {
      skipped.push({ row: rowNum, reason: 'settlement_record', paperName: description });
      continue;
    }

    // ── Dywidendy → kubełki, parowanie po pętli ──
    const reversal = DIVIDEND_REVERSAL_RE.exec(description);
    if (reversal) {
      reversalRows.push({
        rowNum,
        isoDate,
        isin: reversal[1],
        qtyToken: reversal[2],
        rateToken: reversal[3],
        amount,
        currency,
        description,
      });
      continue;
    }
    const gross = DIVIDEND_GROSS_RE.exec(description);
    if (gross) {
      grossRows.push({
        rowNum,
        isoDate,
        isin: gross[1],
        qtyToken: gross[2],
        rateToken: gross[3],
        amount,
        currency,
        description,
      });
      continue;
    }
    const tax = DIVIDEND_TAX_RE.exec(description);
    if (tax) {
      taxRows.push({
        rowNum,
        isoDate,
        isin: tax[1],
        qtyToken: tax[2],
        rateToken: tax[3],
        amount,
        currency,
        description,
      });
      continue;
    }

    // ── Wykup przymusowy → RedemptionMarker (syntetyczna S w reconciliation) ──
    const buyout = FORCED_BUYOUT_RE.exec(description);
    if (buyout) {
      const [, isin, qtyToken, priceToken, buyoutCurrency] = buyout;
      const qty = parseIngDescQty(qtyToken);
      const tenderPrice = parseNumber(priceToken);
      if (qty > 0 && tenderPrice > 0 && amount !== 0) {
        redemptions.push({
          date: isoDate,
          ticker: isin,
          isin,
          quantity: qty,
          amount,
          commission: 0,
          description,
          currency: buyoutCurrency || currency,
          source: 'ing',
          kind: 'tender',
          tenderPrice,
        });
        skipped.push({ row: rowNum, reason: 'redemption_reconciled', paperName: description });
      } else {
        // Nieparsowalne liczby w opisie wykupu — nie zgadujemy, do kwarantanny.
        skipped.push({
          row: rowNum,
          reason: 'unknown_operation_type',
          paperName: description,
          raw: rawFor(row, isoDate, amount, currency, description),
        });
      }
      continue;
    }

    if (amount === 0) {
      skipped.push({ row: rowNum, reason: 'zero_amount', paperName: description });
      continue;
    }

    // ── Wpłaty / wypłaty (kierunek ze znaku kwoty — wzorzec mBank TRANSFER_RES) ──
    if (DEPOSIT_RE.test(description) || WITHDRAWAL_PZE_RE.test(description)) {
      operations.push({
        date: isoDate,
        operationType: amount > 0 ? 'deposit' : 'withdrawal',
        description,
        amount,
        currency,
        source: 'ing',
        importBatch,
      });
      continue;
    }

    // ── Fallbacki per kategoria ──
    const categoryNorm = normalizeForDetect(category);

    // Nieznany opis w kategorii przelewów — kategoria jest autorytatywna,
    // księgujemy wg znaku + sygnał bez `raw` (zaksięgowane nie idzie do
    // kwarantanny, bo jej resolve zdublowałby operację — wzorzec mBank).
    if (categoryNorm === 'wplaty/wyplaty') {
      skipped.push({ row: rowNum, reason: 'unknown_operation_type', paperName: description });
      operations.push({
        date: isoDate,
        operationType: amount > 0 ? 'deposit' : 'withdrawal',
        description,
        amount,
        currency,
        source: 'ing',
        importBatch,
      });
      continue;
    }

    // Nieznany opis w kategorii Dywidendy — księgujemy jako 'other' (saldo się
    // zgadza, user może przeklasyfikować ręcznie) + sygnał bez `raw`.
    if (categoryNorm === 'dywidendy') {
      skipped.push({ row: rowNum, reason: 'unknown_operation_type', paperName: description });
      operations.push({
        date: isoDate,
        operationType: 'other',
        description,
        amount,
        currency,
        source: 'ing',
        importBatch,
      });
      continue;
    }

    // Kategorie transakcyjne / blokadowe / pusta: NIE księgujemy (ryzyko
    // podwójnego liczenia z plikiem transakcji) → kwarantanna z surową treścią.
    skipped.push({
      row: rowNum,
      reason: 'unknown_operation_type',
      paperName: description,
      raw: rawFor(row, isoDate, amount, currency, description),
    });
  }

  // ── Parowanie dywidend ──

  // 1. Storno netuje wiersz brutto o tej samej kwocie (preferencja: ta sama data).
  for (const rev of reversalRows) {
    const targetIdx = pickReversalTarget(grossRows, rev);
    if (targetIdx >= 0) {
      grossRows.splice(targetIdx, 1);
      rev.used = true;
      continue;
    }
    warnings.push(
      `ING: storno dywidendy ${rev.isin} (${rev.isoDate.slice(0, 10)}, ${rev.amount} ${rev.currency}) ` +
        `bez pasującego wiersza brutto w pliku — zaksięgowano jako samodzielną korektę.`,
    );
    operations.push({
      date: rev.isoDate,
      operationType: 'dividend',
      description: `${rev.isin} — storno dywidendy (Anulata)`,
      amount: rev.amount, // ujemna kwota wprost z pliku
      currency: rev.currency,
      ticker: rev.isin,
      source: 'ing',
      importBatch,
    });
  }

  // 2. Brutto + podatek po ISIN i dacie; każdy wiersz podatku parowany RAZ.
  for (const gross of grossRows) {
    const tax = taxRows.find(
      (t) =>
        !t.used && t.isin === gross.isin && t.isoDate.slice(0, 10) === gross.isoDate.slice(0, 10),
    );
    if (tax) tax.used = true;

    const grossAmount = Math.abs(gross.amount);
    const taxAmount = tax ? Math.abs(tax.amount) : 0;
    const netAmount = roundTo2(grossAmount - taxAmount);
    const taxPct =
      grossAmount > 0 && taxAmount > 0 ? Math.round((taxAmount / grossAmount) * 100) : 0;

    const qty = parseIngDescQty(gross.qtyToken);
    const rate = parseNumber(gross.rateToken);
    const taxSuffix = taxPct > 0 ? `, podatek ${taxPct}%` : '';
    operations.push({
      date: gross.isoDate,
      operationType: 'dividend',
      description: `Dywidenda ${gross.isin} (${qty} szt × ${rate} ${gross.currency}${taxSuffix})`,
      amount: netAmount,
      currency: gross.currency,
      // Konwencja mBank/Bossa: w `ticker` trzymamy ISIN — resolver i panel
      // Dywidend łączą po nim z pozycją.
      ticker: gross.isin,
      source: 'ing',
      importBatch,
    });
  }

  // 3. Niesparowany podatek → samodzielna ujemna korekta + warning (wzorzec DEGIRO).
  for (const tax of taxRows) {
    if (tax.used) continue;
    warnings.push(
      `ING: podatek od dywidendy ${tax.isin} (${tax.isoDate.slice(0, 10)}) bez pasującego ` +
        `wiersza brutto w pliku — zaimportowano jako samodzielną korektę.`,
    );
    operations.push({
      date: tax.isoDate,
      operationType: 'dividend',
      description: `${tax.isin} — korekta podatku od dywidendy`,
      amount: tax.amount, // ujemna kwota wprost z pliku
      currency: tax.currency,
      ticker: tax.isin,
      source: 'ing',
      importBatch,
    });
  }

  return {
    data: operations,
    skipped,
    warnings: warnings.length > 0 ? warnings : undefined,
    redemptions,
    orderIsinMap,
  };
}

/** Surowa treść wiersza do kwarantanny (cells + hint do prefillu dialogów). */
function rawFor(
  row: string[],
  isoDate: string,
  amount: number,
  currency: string,
  description: string,
): NonNullable<SkippedRow['raw']> {
  return {
    cells: row.map((c) => c ?? ''),
    hint: {
      date: isoDate.slice(0, 10),
      amount: amount !== 0 ? amount : undefined,
      currency: currency || undefined,
      description,
    },
  };
}

/**
 * Wybór wiersza brutto netowanego przez storno: ta sama kwota co |storno|,
 * preferencyjnie ten sam dzień (ING księguje storno i ponowne rozliczenie
 * tego samego dnia), inaczej pierwszy pasujący kwotą.
 */
function pickReversalTarget(grossRows: DividendRow[], rev: DividendRow): number {
  const absRev = Math.abs(rev.amount);
  let fallback = -1;
  for (let i = 0; i < grossRows.length; i++) {
    const g = grossRows[i];
    if (g.isin !== rev.isin || Math.abs(Math.abs(g.amount) - absRev) > 0.005) continue;
    if (g.isoDate.slice(0, 10) === rev.isoDate.slice(0, 10)) return i;
    if (fallback < 0) fallback = i;
  }
  return fallback;
}
