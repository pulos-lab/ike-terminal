import { MBANK_TRANSACTIONS_PROFILE } from '../parsers/generic/profiles/mbank-transactions.profile.js';
import { DEGIRO_ACCOUNT_PROFILE } from '../parsers/generic/profiles/degiro-account.profile.js';

/**
 * Prompt generatora profili importu (LLM → ImportProfile JSON).
 *
 * System: skondensowana specyfikacja spec + JEDEN few-shot (golden profil mBank
 * — pokazuje scan nagłówka, occurrence dla zduplikowanych kolumn i ścieżkę
 * needsNameResolution). User: nagłówki + delimiter + ZREDAGOWANA próbka +
 * digesty unikalnych wartości per kolumna — digesty podają modelowi kolumny-
 * dyskryminatory (typ wiersza, strona K/S) na tacy, co jest najskuteczniejszą
 * pojedynczą mitygacją słabszych modeli.
 */

const FEW_SHOT_HEADERS =
  'Czas transakcji;Papier;Giełda;K/S;Liczba;Kurs;Waluta;Prowizja;Waluta;Wartość;Waluta';

// Drugi few-shot: plik OPERACJI wielotypowy (wpłaty/wypłaty/dywidendy/FX/opłaty) —
// pokazuje klasyfikację kolumny „Opis" na osobne klasy gotówkowe, mapowanie ISIN
// i parowanie. Kontrapunkt dla mBanku (który jest jednotypowy, bez ISIN).
const FEW_SHOT_HEADERS_ACCOUNT = 'Data,Czas,Data,Produkt,ISIN,Opis,Kurs,Zmiana,,Saldo,,Identyfikator zlecenia';

export function buildSystemPrompt(): string {
  const fewShot = JSON.stringify(MBANK_TRANSACTIONS_PROFILE);
  const fewShotAccount = JSON.stringify(DEGIRO_ACCOUNT_PROFILE);
  return `You are a precise data engineer. Given the header row and a redacted sample of a broker's CSV export, output an ImportProfile JSON object that maps the file onto a canonical portfolio schema. Output ONLY the JSON object — no markdown, no commentary.

# ImportProfile rules (specVersion 1)

- Top-level: { "specVersion": 1, "brokerLabel", "file", "classify", "defaultClass", <mappings>, "pairing"?, "needsNameResolution"? }.
- "brokerLabel": short human guess of the broker name from headers/sample (max 60 chars).
- "file": { "delimiter": one of ";" "," "\\t" "|", "headerRow": {"strategy":"first"} or {"strategy":"scan","signature":[2-6 exact header names]} when metadata lines precede the header, "skipRows"?: conditions for summary rows, "footerStop"?: condition that marks the start of a footer, "decimalSeparator"?: "." or "," (pin it when the sample shows an unambiguous decimal mark), "amountSignPolicy"?: "auto"|"signed"|"magnitude" }.
- Column references: {"name":"<exact header text>","occurrence":N} (occurrence 0-based, for duplicated header names) or a 0-based column index. The name MUST be copied verbatim from the provided header list — never invent or translate names. Columns with EMPTY header names MUST be referenced by numeric index.
- Value sources: {"kind":"column","col":<ref>,"fallback"?:"<value when cell empty>"} | {"kind":"const","value":"…"} | {"kind":"regexExtract","col":<ref>,"pattern":"…","group":N} (extract e.g. ticker, quantity or fx pair from a description cell).
- "classify": ordered rules, first match wins: {"id","when":[matchers ANDed],"emit":<rowClass>}. Matcher: {"col":<ref>,"op":"equals"|"oneOf"|"contains"|"startsWith"|"regex"|"signPositive"|"signNegative"|"zeroNumber"|"nonzeroNumber"|"empty"|"notEmpty","values"?:[…],"pattern"?:"…"}. Row classes: trade, dividend, withholding_tax, coupon, interest, deposit, withdrawal, fx_leg, fee, trade_fee, commission_refund, capital_return, other, skip. "defaultClass": "skip" (unmatched rows reported) or "other" (imported as misc cashflow).
- Every emitted class needs its mapping section: "trade" for trades; cash classes use keys dividend/withholdingTax/coupon/interest/deposit/withdrawal/fxLeg/fee/tradeFee/commissionRefund/capitalReturn/other.
- "trade" mapping: { "date": {"source":<vs>,"formats":["YYYY-MM-DD"|"DD.MM.YYYY"|"DD-MM-YYYY"|"DD/MM/YYYY"|"MM/DD/YYYY"|"YYYY.MM.DD"|"YYYY/MM/DD"|"DD.MM.YY"|"DD/MM/YY"|"DD-MMM-YYYY"|"DD MMM YYYY"|"MMM DD, YYYY"],"timeSource"?:<vs>}, "paperName":<vs>, "isin"?:<vs>, "quantity":<vs>, "wholeShares"?:bool (true only for whole-share markets), "price":<vs>, "value"?:<vs> (omit to compute qty×price), "commission"?:<vs> (omit when fees are separate rows), "total"?:<vs>, "currency":<vs>, "paymentCurrency"?:<vs>, "fxRate"?:<vs>, "side": {"strategy":"column","col":<ref>,"buyValues":[…],"sellValues":[…]} | {"strategy":"signedQuantity","col":<ref>} | {"strategy":"signedAmount","col":<ref>} }. When the file has a SEPARATE time-of-day column, always set "timeSource" to it. "currency" = the currency the instrument is quoted/traded in; "paymentCurrency" = the currency the account was actually debited in — set it only when the file shows a distinct settlement/account currency (e.g. a total-in-account-currency column); omit when unknown.
- Cash mapping: { "date":{...}, "amount":<vs> (signed), "currency":<vs>, "description"?:<vs>, "ticker"?:<vs>, "isin"?:<vs>, "fxRate"?:<vs>, "fxPair"?:<vs> }. When extracting "ticker" from a free-text title with regexExtract, the capture group must match the instrument SYMBOL itself — an UPPERCASE token of 2-8 letters/digits that VARIES between rows (e.g. ELV, AVGO, PLAYWAY) — never a fixed adjacent word like "netto"/"brutto"/"DM". Anchor the pattern on the constant words around the symbol, e.g. "Dywidenda netto ELV 85% USD" → pattern "(?:netto|brutto)\\\\s+([A-Z0-9]{2,8})\\\\b" group 1. Omit "ticker" entirely when no reliable symbol token exists.
- "pairing": {"dividendWht":{"matchBy":["isin"|"ticker"|"date"|"time"],"windowDays":0-7,"handling":"subtract"|"fee_row"}} when the file has separate dividend + withholding-tax rows; {"fxLegs":{"pairKey":{"by":"column","col":<ref>}|{"by":"datetime"},"rateSource"?:<vs>}} when FX exchanges come as debit+credit leg rows. Single-row FX: classify as fx_leg WITHOUT pairing.fxLegs and put fxRate/fxPair in the fxLeg mapping (often regexExtract from the title).
- ISIN is the most reliable instrument identifier. If ANY column contains ISIN-like codes (2 letters + 10 alphanumerics, check digit last — e.g. US5949181045, IE00B4L5Y983, PLKGHM000017), you MUST map it: "isin": {"kind":"column","col":{"name":"<that header>"}}. Do this even if a paperName column also exists. ONLY when the file has NO ISIN column: omit "isin" and set "needsNameResolution": true. (Note: some brokers put a plain ticker like "BTC" instead of an ISIN in the same symbol column for crypto — that is fine, still map the column to "isin"; the resolver handles non-ISIN symbols by name.)
- If a trade has a per-transaction fee/commission column (header like fee/fees/prowizja/commission/charge, a small value alongside each trade), map it to "trade.commission" — otherwise the cost is silently lost. Omit "commission" ONLY when fees arrive as SEPARATE ROWS (then classify those rows as "fee").
- Classify cash rows, do NOT route them into "trade". A broker's type/category column typically mixes trades with NON-trade operations — deposits, withdrawals, transfers, interest, dividends, and promotional credits (bonus/reward/cashback/"stock perk"/free-share). Give EACH non-trade type its own classify rule emitting the right class (deposit/withdrawal/interest/dividend, and other for bonuses/rewards). Rows routed to "trade" but lacking a valid buy/sell side or a positive quantity are DROPPED silently — a deposit landing in "trade" disappears from the portfolio.
- Do NOT use a single catch-all rule (e.g. matching an always-present column like a date) as your ONLY classify rule when a type/category column has more than one distinct value. Key your rules on that type column (the value digests below list its distinct values). A catch-all on trades is acceptable ONLY when the file is single-type (every row is a trade).
- Numbers: parsed automatically (European and US separators) by default. When the sample makes the decimal mark unambiguous, set "file.decimalSeparator" to "." or "," so values like "1.234" are not mis-read — the other mark (and spaces) is then the thousands separator. Dates: pick formats from the closed enum above based on the sample; two-digit years ("DD.MM.YY", "DD/MM/YY") and month names ("DD-MMM-YYYY", "DD MMM YYYY", "MMM DD, YYYY"; English or Polish) are supported. Formats are DATE-ONLY — NEVER append a time part (use "DD.MM.YYYY", not "DD.MM.YYYY HH:mm:ss"); a trailing time in the cell is tolerated automatically, and "timeSource" exists when the time lives in a separate column.
- "file.amountSignPolicy": set "signed" when the amount column carries a real sign (e.g. withdrawals negative) so the sign drives deposit/withdrawal direction; set "magnitude" when amounts are always positive magnitudes and direction comes only from the row type/label (e.g. Trading 212); omit (or "auto") to let the engine infer from whether any amount in the file is negative.
- Side values: if the sample shows only one side (e.g. only buys), still provide the standard counterpart pair for that broker's language (K/S, BUY/SELL, Buy/Sell, Kupno/Sprzedaż).
- Prefer column references by NAME. Be conservative: when a row type is not clearly identifiable, let it fall to defaultClass instead of guessing.
- Corporate actions that move share count but do NOT fit the standard trade columns (stock splits, share transfers in/out, reorganizations, in-kind/stock distributions) often use a DIFFERENT column layout than ordinary trades (e.g. quantity in another column, an id where the price should be). Do NOT force them into "trade"/"other" — that produces garbage. Classify them as skip WITH a reason: {"id":…,"when":[…],"emit":"skip","skipReason":"corporate_action"}. They are reported to the user (not silently dropped) and do not lower confidence.

# Example 1 — trades, no ISIN column (name resolution), header after metadata lines

Input headers (delimiter ";", header found after ~30 metadata lines):
${FEW_SHOT_HEADERS}

Correct output:
${fewShot}

# Example 2 — multi-type operations file: classify a description column into cash classes, map ISIN, pair dividend↔tax

Input headers (delimiter ","), the "Opis" column carries the operation type (Depozyt/Wypłata/Dywidenda/FX Credit/…):
${FEW_SHOT_HEADERS_ACCOUNT}

Correct output:
${fewShotAccount}`;
}

export interface UserPromptInput {
  headers: string[];
  delimiter: string;
  headerRowIndex: number;
  /** ZREDAGOWANE wiersze próbki (sample-redactor) — max ~20. */
  sampleRows: string[][];
  /** ZREDAGOWANA nazwa pliku — wskazówka wyłącznie dla brokerLabel. */
  fileName?: string;
  /**
   * ZREDAGOWANE wiersze do digestów wartości — domyślnie CAŁY plik (capped).
   * Rzadkie typy operacji często nie trafiają do 20-wierszowej próbki; digest
   * z całego pliku podaje modelowi pełną listę dyskryminatorów. Gdy brak,
   * digesty liczą się z sampleRows.
   */
  digestRows?: string[][];
}

/**
 * Normalizacja wartości tekstowej do WZORCA: liczby/daty/kwoty → {N},
 * kody pisane wersalikami (tickery, waluty, giełdy) → {SYM}. Setki tytułów
 * operacji z wieloletniej historii zapadają się do kilkunastu wzorców —
 * dokładnie tego potrzebuje model, żeby napisać reguły contains/regex.
 */
function valuePattern(value: string): string {
  return value
    .replace(/\d[\d\s.,:/-]*\d|\d/g, '{N}')
    .replace(/(?<![\p{L}\d])[A-Z][A-Z0-9]{1,7}(?![\p{L}\d])/gu, '{SYM}')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Digesty kolumn: dla kolumn o małej liczbie unikalnych wartości wypisz je
 * wszystkie (kandydaci na dyskryminatory classify/side); dla kolumn
 * wysokokardynalnych (wolny tekst tytułów) wypisz WZORCE wartości z licznikami
 * i przykładem. Liczone z wierszy ZREDAGOWANYCH — nic ponad to nie idzie
 * do promptu.
 */
function buildColumnDigests(headers: string[], sampleRows: string[][]): string[] {
  // 40: kolumny-dyskryminatory (typ operacji) miewają ~30 wartości w pełnej
  // historii — pełna lista to najcenniejsza informacja w całym prompcie.
  const MAX_DISTINCT = 40;
  const MAX_PATTERNS = 25;
  return headers.map((header, col) => {
    const values: string[] = [];
    const seen = new Set<string>();
    const patterns = new Map<string, { count: number; example: string }>();
    let nonEmpty = 0;
    for (const row of sampleRows) {
      const v = (row[col] ?? '').trim();
      if (!v) continue;
      nonEmpty++;
      if (!seen.has(v) && seen.size <= MAX_DISTINCT) {
        seen.add(v);
        values.push(v);
      }
      const pattern = valuePattern(v);
      const entry = patterns.get(pattern);
      if (entry) entry.count++;
      else patterns.set(pattern, { count: 1, example: v });
    }
    const label = header.trim() || `(unnamed col ${col})`;
    if (nonEmpty === 0) return `[${col}] "${label}": always empty`;
    if (seen.size <= MAX_DISTINCT) {
      return `[${col}] "${label}": ${seen.size} distinct values: ${values.map((v) => JSON.stringify(v)).join(', ')}`;
    }
    // Wolny tekst: wzorce posortowane po częstości, każdy z przykładem —
    // model pisze reguły contains/regex po stabilnych słowach wzorca.
    const top = [...patterns.entries()].sort((a, b) => b[1].count - a[1].count);
    const lines = top
      .slice(0, MAX_PATTERNS)
      .map(
        ([pattern, { count, example }]) =>
          `    - ${JSON.stringify(pattern)} ×${count} (e.g. ${JSON.stringify(example.slice(0, 80))})`,
      );
    const omitted =
      top.length > MAX_PATTERNS ? `\n    …and ${top.length - MAX_PATTERNS} rarer patterns` : '';
    return (
      `[${col}] "${label}": free text, ${top.length} value patterns ` +
      `({N}=number/date/amount, {SYM}=ticker/currency/exchange code) — cover EVERY pattern ` +
      `with a classify rule (match on the stable words):\n${lines.join('\n')}${omitted}`
    );
  });
}

export function buildUserPrompt(input: UserPromptInput): string {
  const sampleLines = input.sampleRows.map((row) => row.join(input.delimiter)).join('\n');
  const digestSource = input.digestRows ?? input.sampleRows;
  const digests = buildColumnDigests(input.headers, digestSource).join('\n');
  const digestScopeNote = input.digestRows
    ? ' (computed over the ENTIRE file — write classify rules for EVERY row type listed here, including ones absent from the sample rows below)'
    : '';

  const fileNameLine = input.fileName
    ? `File name (redacted): ${JSON.stringify(input.fileName)} — use ONLY as a hint for "brokerLabel"; never for column mappings.\n`
    : '';

  return `# File to map

${fileNameLine}Delimiter: ${JSON.stringify(input.delimiter)}
Header row index in file: ${input.headerRowIndex}${input.headerRowIndex > 0 ? ' (metadata lines precede it — use headerRow strategy "scan")' : ' (use headerRow strategy "first")'}
Headers (${input.headers.length} columns, 0-based indices):
${input.headers
  .map(
    (h, i) =>
      `[${i}] ${JSON.stringify(h)}${h.trim() === '' ? ` ← UNNAMED: reference as bare index ${i}, e.g. {"kind":"column","col":${i}}` : ''}`,
  )
  .join('\n')}

# Column value digests (redacted)${digestScopeNote}

${digests}

# Redacted sample rows (${input.sampleRows.length})

${sampleLines}

Return the ImportProfile JSON object now.`;
}

/** Feedback dla retry — doklejany do promptu user po nieudanej próbie. */
export function buildRetryFeedback(errors: string[]): string {
  return `\n\n# Previous attempt was rejected

Fix these problems and return the corrected ImportProfile JSON:
${errors
  .slice(0, 12)
  .map((e) => `- ${e}`)
  .join('\n')}`;
}
