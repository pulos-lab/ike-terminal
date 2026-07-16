import { ImportProfileSchema, type ImportProfile } from 'shared';
import { SUFFIX_CURRENCY } from '../../xtb-transactions.js';

/**
 * Golden profil: XTB — arkusz "Cash Operations" (format NOWY, eksporty
 * `PLN_*.xlsx` / `USD_*.xlsx`). Silnik czyta CSV, więc arkusz jest najpierw
 * konwertowany do wierszy (robi to harness; w przyszłości warstwa XLSX→CSV
 * przed fingerprintem).
 *
 * Nagłówek (wiersz 5, nad nim metadane konta → headerRow.scan):
 *   Type | Instrument | Time | Amount | ID | Comment | Product
 *
 * Najtrudniejszy format w repo — profil odwzorowuje:
 * - transakcje zakodowane w Comment: "OPEN BUY 99 @ 9.796", partial fill
 *   "OPEN BUY 53/60 @ 39.490", sprzedaż "CLOSE BUY 64 @ 26.07", fractional
 *   "BUY 0.3069 @ 494.15" → quantity/price przez regexExtract (jeden wzorzec
 *   łapie OPEN/CLOSE — sprzedaż XTB też pisze "BUY" w komentarzu),
 * - strona K/S z kolumny Type (Stock purchase/Stock sale),
 * - value/total wyliczane z qty×price; kwota w Amount (rozliczenie konta)
 *   zasila quoteCurrencyFromSettlement — detekcję waluty notowania z
 *   |Amount|/(qty×price) (konto PLN + instrument USD: cena w Comment jest
 *   w USD); wiersze "close trade" (P/L) parowane ze sprzedażą przez
 *   pairing.tradeClosePl, bo Amount sprzedaży to zwrócony nominał otwarcia,
 * - Instrument = pełna NAZWA spółki (nie ticker) → pseudo-ISIN = nazwa
 *   + needsNameResolution (ścieżka mBank),
 * - dywidenda ↔ withholding tax parowane po (Instrument, data, czas) — klucz
 *   `symbol|isoTime` parsera wbudowanego,
 * - wpłaty/wypłaty: kierunek po ZNAKU kwoty (storno wpłaty → withdrawal),
 * - model subkonta: jedna waluta na plik → currency jako const (parametr).
 *
 * Występują dwa układy nagłówka (dwa fingerprinty → dwa warianty profilu):
 *   bez kolumny Ticker : Type | Instrument | Time | Amount | ID | Comment | Product
 *   z kolumną Ticker   : Type | Ticker | Instrument | Time | Amount | ID | Comment | Product
 * W wariancie z Tickerem symbol instrumentu czytamy z Ticker ("MSFT.US").
 *
 * GRANICE SPEC (świadome, zostają w parserze wbudowanym):
 * - wiersze "commission" parowane FIFO do transakcji po (symbol, czas) —
 *   deklaratywnie niewykonalne; w nowym formacie akcje/ETF mają prowizję 0,
 * - mapowanie nazwa→ticker, kategoria stock/etf/cfd ORAZ mapa symbol→waluta
 *   notowania (options.symbolCurrency) z arkusza Closed Positions
 *   (cross-sheet lookup — harness buduje ją i wstrzykuje do profilu),
 * - translacja sufiksów XTB→Yahoo ("MSFT.US"→"MSFT", "CDR.PL"→"CDR.WA") —
 *   mapa krajów, nie regex,
 * - CFD z arkusza Closed Positions (syntetyczne pary K+S),
 * - stary szablon `account_*_pl` (scalone komórki, nagłówek w ~13. wierszu).
 */
export function buildXtbCashOperationsProfile(
  accountCurrency: string,
  options: {
    hasTickerColumn?: boolean;
    /** Mapa dokładny symbol → waluta notowania dla wariantu z nazwami spółek
     *  (harness buduje ją cross-sheet z Closed Positions — poza spec v1). */
    symbolCurrency?: Record<string, string>;
  } = {},
): ImportProfile {
  const TYPE = { name: 'Type' } as const;
  const SYMBOL = options.hasTickerColumn
    ? ({ name: 'Ticker' } as const)
    : ({ name: 'Instrument' } as const);
  const cash = {
    date: { source: { kind: 'column', col: { name: 'Time' } }, formats: ['YYYY-MM-DD'] },
    amount: { kind: 'column', col: { name: 'Amount' } },
    currency: { kind: 'const', value: accountCurrency },
    description: { kind: 'column', col: { name: 'Comment' } },
  } as const;
  const cashWithTicker = { ...cash, ticker: { kind: 'column', col: SYMBOL } };

  return ImportProfileSchema.parse({
    specVersion: 1,
    brokerLabel: 'XTB',
    file: {
      delimiter: ';',
      headerRow: {
        strategy: 'scan',
        signature: ['Type', 'Instrument', 'Time', 'Amount'],
        maxScanRows: 20,
      },
    },
    classify: [
      // "close trade" niesie P/L zamknięcia — parowany ze sprzedażą przez
      // pairing.tradeClosePl (wartość sprzedaży w walucie konta = |Amount| + P/L,
      // wsad do detekcji quoteCurrencyFromSettlement). Sam nic nie emituje.
      {
        id: 'close-trade-pl',
        when: [{ col: TYPE, op: 'equals', values: ['close trade'] }],
        emit: 'trade_close_pl',
      },
      // Wpisy techniczne: "commission"/"Sec Fee" parser wbudowany dokleja do
      // transakcji (FIFO) — deklaratywnie niewykonalne, zostają poza profilem.
      {
        id: 'technical',
        when: [{ col: TYPE, op: 'oneOf', values: ['commission', 'Sec Fee'] }],
        emit: 'skip',
        skipReason: 'settlement_record',
      },
      {
        id: 'trade',
        when: [{ col: TYPE, op: 'oneOf', values: ['Stock purchase', 'Stock sale', 'Stock sell'] }],
        emit: 'trade',
      },
      {
        id: 'dividend',
        // Trzecia wartość: dywidenda spółki zagranicznej notowanej na GPW
        // (np. ASB.PL/Asbis) — lustro aliasu parsera wbudowanego.
        when: [
          {
            col: TYPE,
            op: 'oneOf',
            values: ['dividend', 'divident', 'Dividend from foreign company on PL market'],
          },
        ],
        emit: 'dividend',
      },
      {
        id: 'wht',
        when: [{ col: TYPE, op: 'equals', values: ['withholding tax'] }],
        emit: 'withholding_tax',
      },
      {
        id: 'deposit',
        when: [{ col: TYPE, op: 'oneOf', values: ['deposit', 'IKZE deposit', 'IKE deposit'] }],
        emit: 'deposit',
      },
      {
        id: 'withdrawal',
        when: [{ col: TYPE, op: 'equals', values: ['withdrawal'] }],
        emit: 'withdrawal',
      },
      // Odsetki od wolnych środków: parser wbudowany daje 'other' (bez subkind),
      // wariant "tax" → fee. Klasa 'other' zamiast 'interest' dla parytetu 1:1.
      {
        id: 'funds-interest-tax',
        when: [{ col: TYPE, op: 'equals', values: ['Free funds interest tax'] }],
        emit: 'fee',
      },
      {
        id: 'funds-interest',
        when: [{ col: TYPE, op: 'equals', values: ['Free funds interest'] }],
        emit: 'other',
      },
      {
        id: 'rights-issue',
        when: [{ col: TYPE, op: 'equals', values: ['rights issue'] }],
        emit: 'other',
      },
      // Koszty przypięte do pozycji (swap/rollover/tax IFTT) → trade_fee.
      // Dla pozycji CFD parser wbudowany rozlicza je w syntetycznych K/S
      // z arkusza Closed Positions — te wiersze raportuje harness jako
      // różnicę oczekiwaną (CFD poza zakresem profilu).
      {
        id: 'trade-costs',
        when: [{ col: TYPE, op: 'oneOf', values: ['swap', 'rollover', 'tax iftt'] }],
        emit: 'trade_fee',
      },
    ],
    defaultClass: 'skip',
    trade: {
      date: { source: { kind: 'column', col: { name: 'Time' } }, formats: ['YYYY-MM-DD'] },
      paperName: { kind: 'column', col: SYMBOL },
      quantity: {
        kind: 'regexExtract',
        col: { name: 'Comment' },
        pattern: 'BUY ([\\d.]+)(?:/[\\d.]+)? @ ([\\d.]+)',
        group: 1,
      },
      price: {
        kind: 'regexExtract',
        col: { name: 'Comment' },
        pattern: 'BUY ([\\d.]+)(?:/[\\d.]+)? @ ([\\d.]+)',
        group: 2,
      },
      currency: { kind: 'const', value: accountCurrency },
      paymentCurrency: { kind: 'const', value: accountCurrency },
      // Detekcja waluty notowania z kwoty rozliczenia — lustro parsera
      // wbudowanego (konto PLN + instrument USD: cena w Comment jest w USD,
      // Amount w PLN). Etykieta z sufiksu symbolu (wariant Ticker) albo z mapy
      // symbolCurrency (harness, cross-sheet); nazwy bez etykiety → cena
      // przeliczana na walutę konta.
      quoteCurrencyFromSettlement: {
        settlementAmount: { kind: 'column', col: { name: 'Amount' } },
        tolerance: 0.02,
        // Silnik stosuje sufiks tylko dla wzorca ticker.XX — bezpieczne także
        // w wariancie z nazwami spółek (nazwy nie mają sufiksu kraju).
        suffixCurrency: { ...SUFFIX_CURRENCY },
        suffixFallback: 'USD',
        ...(options.symbolCurrency ? { symbolCurrency: options.symbolCurrency } : {}),
        unlabeledFallback: 'convertToSettlement',
        // Szablon z kolumną Ticker: Amount sprzedaży = pełna wartość sprzedaży
        // także przy obecnych wierszach close trade (występują tam tylko dla
        // CFD) — lustro layout.hasTicker parsera wbudowanego.
        ...(options.hasTickerColumn ? { saleAmountIsFullValue: true } : {}),
      },
      side: {
        strategy: 'column',
        col: TYPE,
        buyValues: ['Stock purchase'],
        sellValues: ['Stock sale', 'Stock sell'],
      },
      category: { rules: [], default: 'stock' },
    },
    dividend: cashWithTicker,
    withholdingTax: cashWithTicker,
    deposit: cash,
    withdrawal: cash,
    fee: cashWithTicker,
    tradeFee: cashWithTicker,
    other: cashWithTicker,
    pairing: {
      dividendWht: { matchBy: ['ticker', 'date', 'time'], windowDays: 0, handling: 'subtract' },
      // Klucz jak `symbol|isoTime` parsera wbudowanego; kwoty P/L pod tym samym
      // kluczem sumują się (partial fille).
      tradeClosePl: {
        amount: { kind: 'column', col: { name: 'Amount' } },
        matchBy: ['ticker', 'date', 'time'],
      },
    },
    needsNameResolution: true,
  } satisfies Record<string, unknown>);
}
