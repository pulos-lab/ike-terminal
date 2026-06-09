import Papa from 'papaparse';
import type { Transaction, ParseResult, SkippedRow } from 'shared';
import { applyIsinAlias } from 'shared';
import { parseNumber, validateTradeFields, parseDottedDate } from './utils.js';

/**
 * Bossa sufiksuje tickery instrumentów nietypowych:
 * - `-C` — certyfikat strukturyzowany (np. `4MASS-C`, `HUUUGE-C`)
 * - `-NC-FIX` — NewConnect z ceną fix (`ROBSGROUP-NC-FIX`, `DUALITY-NC-FIX`)
 * - `-NC` — zwykły NewConnect (`PLATIGE-NC`)
 * - `_IPO` — ticker pre-IPO (`HUUUGE_IPO`)
 *
 * Usuwamy sufiks, żeby resolver (Yahoo/Stooq) mógł trafić na realnie notowany papier.
 * Oryginalny paperName zachowujemy w polu `paperName` transakcji — jest to ticker brokera
 * wyświetlany w UI. Kanoniczny ticker idzie do resolvera pośrednio przez `paperName`,
 * po stripowaniu sufiksów.
 *
 * UWAGA: NIE stripujemy dla zwykłych tickerów (nie mają tych sufiksów) — regex musi być ścisły.
 */
/**
 * Parse Bossa transaction CSV (hisPW.csv / hisPW-2.csv format)
 * Format: semicolon delimited, windows-1250 encoding (pre-decoded), comma decimals
 * Columns: data;papier;isin;ilość;-;cena;wartość;prowizja;po prowizji;waluta
 * Date format: DD.MM.YYYY HH:MM:SS
 */
/**
 * Detect Bossa CSV format by checking for characteristic headers: data, papier, isin.
 * Pierwsza linia splitowana średnikiem (delimiter Bossy) — wymagamy FAKTYCZNYCH nazw
 * kolumn, nie luźnych substringów (żeby np. linia metadanych zawierająca te słowa
 * nie klasyfikowała pliku jako Bossa).
 */
export function isBossaFormat(csvContent: string): boolean {
  const headerCols = (csvContent.split('\n')[0] || '')
    .split(';')
    .map((c) => c.trim().toLowerCase());
  return (
    headerCols.includes('data') && headerCols.includes('papier') && headerCols.includes('isin')
  );
}

export function parseBossaTransactions(
  csvContent: string,
  importBatch: string,
): ParseResult<Transaction> {
  const result = Papa.parse(csvContent.trim(), {
    delimiter: ';',
    header: true,
    skipEmptyLines: true,
  });

  // Validate that the CSV has expected headers — return empty array (not throw)
  const headers = result.meta?.fields || [];
  const hasDataCol = headers.some((h) => h.toLowerCase() === 'data');
  const hasIsinCol = headers.some((h) => h.toLowerCase() === 'isin');
  if (!hasDataCol || !hasIsinCol) {
    return { data: [], skipped: [] };
  }

  const transactions: Transaction[] = [];
  const skipped: SkippedRow[] = [];

  const rows = result.data as any[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-based, +1 for header
    const dateStr = row['data']?.trim();
    const paperName = row['papier']?.trim();
    const isin = row['isin']?.trim();
    const quantity = parseNumber(row['ilość']);
    const side = row['-']?.trim();
    const price = parseNumber(row['cena']);
    const value = parseNumber(row['wartość']);
    const commission = parseNumber(row['prowizja']);
    // Bossa podaje total wprost w kolumnie 'po prowizji' — ufamy CSV zamiast
    // przeliczać computeTotal() (broker jest źródłem prawdy dla rozliczenia).
    const total = parseNumber(row['po prowizji']);
    const currency = row['waluta']?.trim();

    // Wspólna walidacja pól (utils.validateTradeFields) — Bossa wymaga ISIN-u z CSV.
    const check = validateTradeFields({ date: dateStr, isin, side, quantity, price });
    if (!check.ok) {
      skipped.push({ row: rowNum, reason: check.reason, paperName });
      continue;
    }

    const isoDate = parseDottedDate(dateStr);

    // Zastosuj mapę aliasów ISIN jeśli (isin, paperName) to stary identyfikator papieru,
    // który zmienił ISIN/ticker w wyniku zdarzenia korporacyjnego (np. HUUUGE PL→US
    // redomiciliacja). Dzięki temu FIFO i ticker_map operują na jednym ISIN-ie.
    const { isin: canonicalIsin, paperName: canonicalPaperName } = applyIsinAlias(
      isin,
      paperName || '',
    );

    transactions.push({
      date: isoDate,
      paperName: canonicalPaperName,
      isin: canonicalIsin,
      quantity: Math.round(quantity), // GPW/NC: only whole shares; round removes CSV floating-point noise
      side,
      price,
      value,
      commission,
      total,
      currency: currency || 'PLN', // quote — co CSV `waluta` mówi o tym trade'ie
      paymentCurrency: 'PLN', // default — faktyczna waluta rozliczenia wyliczana post-insert przez
      // reconcilePaymentCurrencies() (symulacja salda walut). Bossa IKE/IKZE
      // pozwala trzymać subkonta walutowe (USD/EUR), więc zakup US może iść
      // bezpośrednio z salda USD zamiast auto-FX z PLN.
      source: 'bossa',
      importBatch,
    });
  }

  return { data: transactions, skipped };
}
