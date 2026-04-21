import Papa from 'papaparse';
import type { CashOperation, OperationType, RedemptionMarker, SkippedRow } from 'shared';
import { parseNumber } from './utils.js';

/**
 * Parse Bossa cash operations CSV
 * Format: semicolon delimited, windows-1250 encoding (pre-decoded), comma decimals
 * Columns: data;tytuł operacji;szczegóły;kwota;waluta
 * Date format: YYYY-MM-DD
 */
/** Valid date format: YYYY-MM-DD */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface BossaOperationsParseResult {
  data: CashOperation[];
  skipped: SkippedRow[];
  /**
   * Markery domykające pozycje (Wykup certyfikatów, Rozliczenie oferty).
   * Nie są zapisywane jako CashOperation — reconciliation w import-service tworzy z nich
   * syntetyczną sprzedaż. Dzięki temu to samo cashflow nie jest liczone dwa razy (raz jako
   * deposit, raz jako wpływ ze sprzedaży).
   */
  redemptions: RedemptionMarker[];
}

export function parseBossaOperations(csvContent: string, importBatch: string): BossaOperationsParseResult {
  const result = Papa.parse(csvContent.trim(), {
    delimiter: ';',
    header: true,
    skipEmptyLines: true,
  });

  // Validate that the CSV has expected headers — return empty array (not throw)
  const headers = result.meta?.fields || [];
  const hasDataCol = headers.some(h => h.toLowerCase() === 'data');
  const hasKwotaCol = headers.some(h => h.toLowerCase() === 'kwota');
  if (!hasDataCol || !hasKwotaCol) {
    return { data: [], skipped: [], redemptions: [] };
  }

  const operations: CashOperation[] = [];
  const skipped: SkippedRow[] = [];

  // Dwa etapy: najpierw zbieramy wszystkie wiersze (potrzebujemy parować prowizje wezwań skupu),
  // potem emitujemy CashOperation + RedemptionMarker.
  type ParsedRow = {
    rowNum: number;
    dateStr: string;
    title: string;
    details: string;
    amount: number;
    currency: string;
  };
  const parsedRows: ParsedRow[] = [];

  const rows = result.data as any[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    const dateStr = row['data']?.trim();
    const title = row['tytuł operacji']?.trim() || row['tytu\u0142 operacji']?.trim() || '';
    const details = row['szczegóły']?.trim() || row['szczeg\u00f3\u0142y']?.trim() || '';
    const amount = parseNumber(row['kwota']);
    const currency = row['waluta']?.trim() || 'PLN';

    if (!dateStr) { skipped.push({ row: rowNum, reason: 'missing_date', paperName: title }); continue; }
    if (!DATE_RE.test(dateStr)) { skipped.push({ row: rowNum, reason: 'invalid_date', paperName: title }); continue; }
    if (amount === 0) { skipped.push({ row: rowNum, reason: 'zero_amount', paperName: title }); continue; }

    parsedRows.push({ rowNum, dateStr, title, details, amount, currency });
  }

  // Parowanie prowizji wezwań skupu: `Rozliczenie oferty - prowizja TICKER` z `Rozliczenie oferty TICKER`
  // na tę samą datę. Klucz: ticker+date.
  const offerCommissions = new Map<string, { amount: number; consumed: boolean }>();
  for (const pr of parsedRows) {
    if (!pr.title.includes('Rozliczenie oferty - prowizja')) continue;
    const tickerMatch = pr.title.match(/Rozliczenie oferty - prowizja\s+(\S+)/);
    if (!tickerMatch) continue;
    const key = `${tickerMatch[1]}|${pr.dateStr}`;
    offerCommissions.set(key, { amount: Math.abs(pr.amount), consumed: false });
  }

  const redemptions: RedemptionMarker[] = [];

  for (const pr of parsedRows) {
    const { rowNum, dateStr, title, details, amount, currency } = pr;

    const redemptionKind = detectRedemption(title);
    if (redemptionKind) {
      // Wykup certyfikatów lub główny wiersz Rozliczenie oferty → redemption marker, NIE CashOperation.
      const ticker = redemptionKind.ticker;
      const key = `${ticker}|${dateStr}`;
      const commissionEntry = offerCommissions.get(key);
      const commission = commissionEntry ? commissionEntry.amount : 0;
      if (commissionEntry) commissionEntry.consumed = true;

      redemptions.push({
        date: `${dateStr}T00:00:00`,
        ticker,
        amount,
        commission,
        description: humanizeDescription(title),
        currency,
        source: 'bossa',
      });
      skipped.push({ row: rowNum, reason: 'redemption_reconciled', paperName: title });
      continue;
    }

    // Prowizja od Rozliczenie oferty — jeśli już sparowana z redemption markerem, pomijamy.
    if (title.includes('Rozliczenie oferty - prowizja')) {
      const tickerMatch = title.match(/Rozliczenie oferty - prowizja\s+(\S+)/);
      if (tickerMatch) {
        const key = `${tickerMatch[1]}|${dateStr}`;
        const commissionEntry = offerCommissions.get(key);
        if (commissionEntry?.consumed) {
          skipped.push({ row: rowNum, reason: 'redemption_reconciled', paperName: title });
          continue;
        }
      }
      // Nie ma pasującego redemption markera (edge case) → wpada jako zwykła opłata niżej.
    }

    const operationType = classifyOperation(title);

    // Settlement records (Rozliczenie transakcji) → skip, należą do transakcji.
    if (operationType === 'skip') {
      skipped.push({ row: rowNum, reason: 'settlement_record', paperName: title });
      continue;
    }

    // Nieznany typ operacji → zapisujemy jako `other` (żeby zachować cashflow),
    // ale dodatkowo oznaczamy w `skipped` z `unknown_operation_type` — UI pokaże w warnings
    // żeby user mógł ręcznie zweryfikować klasyfikację (P3+P7).
    if (operationType === 'unknown') {
      skipped.push({ row: rowNum, reason: 'unknown_operation_type', paperName: title });
    }

    const effectiveType: OperationType = operationType === 'unknown' ? 'other' : operationType;
    const ticker = parseDividendTicker(title);
    const fxInfo = parseFxRate(title);

    operations.push({
      date: `${dateStr}T00:00:00`,
      operationType: effectiveType,
      description: humanizeDescription(title),
      details: details || undefined,
      amount,
      currency,
      ticker: ticker || undefined,
      fxRate: fxInfo?.rate,
      fxPair: fxInfo?.pair,
      source: 'bossa',
      importBatch,
    });
  }

  return { data: operations, skipped, redemptions };
}

/**
 * Wykryj czy wiersz to marker redemption (wykup certyfikatu / wezwanie skupu).
 * Zwraca ticker jeśli tak, null jeśli nie.
 */
function detectRedemption(title: string): { ticker: string; kind: 'certificate' | 'tender' } | null {
  const certMatch = title.match(/Wykup certyfikat(?:ów|\u00f3w)\s+(\S+)/);
  if (certMatch) return { ticker: certMatch[1], kind: 'certificate' };

  // Rozliczenie oferty, ale NIE "- prowizja" (to obsługujemy osobno, parując z głównym)
  if (title.includes('Rozliczenie oferty - prowizja')) return null;
  const tenderMatch = title.match(/Rozliczenie oferty\s+(\S+)/);
  if (tenderMatch) return { ticker: tenderMatch[1], kind: 'tender' };

  return null;
}

/** Generate human-readable description from raw Bossa operation title */
function humanizeDescription(title: string): string {
  if (title === 'Zwrot prowizji') return 'Zwrot prowizji';
  if (title.startsWith('Przelew do DM')) return 'Zasilenie konta';
  if (title.startsWith('Przelew wewnętrzny') || title.startsWith('Przelew wewn\u0119trzny')) return title;

  // Dywidendy: "Wypłata dywidendy brutto ASBIS" → "Dywidenda brutto ASBIS"
  const divMatch = title.match(/Wypłata dywidendy\s+(.*)/i) || title.match(/Wyp\u0142ata dywidendy\s+(.*)/i);
  if (divMatch) return `Dywidenda ${divMatch[1]}`;

  // Rozliczenie oferty — humanize dla ewentualnych edge-case'ów (głównie idzie jako RedemptionMarker)
  const offerFeeMatch = title.match(/Rozliczenie oferty - prowizja\s+(\S+)/);
  if (offerFeeMatch) return `Prowizja od oferty skupu ${offerFeeMatch[1]}`;
  const offerMatch = title.match(/Rozliczenie oferty\s+(\S+)/);
  if (offerMatch) return `Wykup w ofercie skupu ${offerMatch[1]}`;

  // Wykup certyfikatów (głównie idzie jako RedemptionMarker)
  const certMatch = title.match(/Wykup certyfikat(?:ów|\u00f3w)\s+(\S+)/);
  if (certMatch) return `Wykup certyfikatów ${certMatch[1]}`;

  // Zapisy na akcje: "Zapisy na akcje BIOCELTIX S.A. SERIA G" → "Subskrypcja akcji BIOCELTIX (seria G)"
  const subMatch = title.match(/Zapisy na akcje\s+(.+?)(?:\s+SERIA\s+(\S+))?$/i);
  if (subMatch) {
    const name = subMatch[1].replace(/\s+S\.A\.$/, '');
    return subMatch[2] ? `Subskrypcja akcji ${name} (seria ${subMatch[2]})` : `Subskrypcja akcji ${name}`;
  }

  if (title.includes('przekroczony limit')) return 'Zwrot nadpłaty — przekroczony limit IKE/IKZE';
  const refundMatch = title.match(/Zwrot nadp(?:łaty|\u0142aty)\s+(.+?)(?:\s+S\.A\.)?$/);
  if (refundMatch) return `Zwrot nadpłaty z subskrypcji ${refundMatch[1].replace(/\s+S\.A\.$/, '')}`;

  const nominalMatch = title.match(/Obni(?:żenie|[\u017c]enie) warto(?:ści|[\u015b]ci) nominalnej\s+(\S+)/);
  if (nominalMatch) return `Umorzenie akcji ${nominalMatch[1]} (obniżenie nominału)`;

  return title;
}

/**
 * Klasyfikacja operacji. Zwraca:
 * - konkretny OperationType dla rozpoznanych typów
 * - 'skip' dla settlement records (Rozliczenie transakcji)
 * - 'unknown' dla nierozpoznanego tytułu (traktowane jako 'other' + dodane do warnings przez caller)
 *
 * UWAGA: Wykup certyfikatów i Rozliczenie oferty NIE przechodzą już przez tę funkcję —
 * są przechwytywane wcześniej jako RedemptionMarker (source-of-truth = synthetic sell
 * z reconciliation, nie deposit).
 */
function classifyOperation(title: string): OperationType | 'skip' | 'unknown' {
  if (title.includes('Rozliczenie transakcji')) return 'skip';

  if (title.includes('Przelew')) {
    // Kierunek (deposit/withdrawal) rozpozna caller po znaku amount — tu wystarczy klasyfikacja.
    // Konwencja istniejąca: zwracamy 'deposit' dla dodatnich, 'withdrawal' dla ujemnych.
    // Robimy to przez odczyt amount z closure w wywołaniu — ale classifyOperation dostaje tylko title,
    // więc zwracamy rozpoznany typ, a caller zadecyduje o deposit vs withdrawal jeśli trzeba.
    // Prosty heurystyk: Przelew wewnętrzny = deposit (bo zwyczajowo zasila konto), Przelew do DM = deposit.
    // Dla withdrawal (Przelew z rachunku gdzieś dalej) Bossa używa innych tytułów.
    return 'deposit';
  }
  if (title.toLowerCase().includes('dywidendy')) return 'dividend';
  if (title.includes('Wymiana waluty')) return 'fx_exchange';
  if (title.startsWith('Opłata za') || title.startsWith('Op\u0142ata za')) return 'fee';
  if (title.includes('Zwrot prowizji')) return 'commission_refund';
  // P6: Zwrot prowizji (90 wierszy w eksporcie testowym) pozostaje osobnym cashflowem.
  // NIE parujemy go do konkretnej transakcji — transakcje mają już `prowizja` zapłaconą
  // w kolumnie `prowizja` z hisPW, a zwrot to niezależne cash-eventy (często z anulowanych zleceń).
  // Dashboard XIRR liczy cashflow z wpłat/wypłat, więc zwrot jako `commission_refund`
  // nie zniekształca metryk. Parowanie heurystyczne miałoby duże ryzyko false-positive.
  if (title.includes('Zapisy na akcje')) return 'withdrawal';
  if (title.includes('Zwrot nadpłaty') || title.includes('Zwrot nadp\u0142aty')) return 'deposit'; // caller może zmienić na withdrawal wg znaku
  if (title.includes('Obniżenie wartości nominalnej') || title.includes('Obni\u017cenie warto\u015bci nominalnej')) return 'deposit';

  return 'unknown';
}

/**
 * Extract dividend ticker from title
 * "Wypłata dywidendy PLAYWAY" -> "PLAYWAY"
 * "Wypłata dywidendy netto NVO 73% PLN" -> "NVO"
 */
function parseDividendTicker(title: string): string | null {
  const match = title.match(/dywidendy(?:\s+(?:netto|brutto))?\s+(\w+)/i);
  return match ? match[1] : null;
}

/**
 * Extract certificate ticker from buyout title — kept for backward compat with reconciliation.
 * "Wykup certyfikatów INTLGLD46805 (kwota brutto)" -> "INTLGLD46805"
 */
export function parseCertificateTicker(title: string): string | null {
  const match = title.match(/Wykup certyfikat(?:ów|\u00f3w)\s+(\S+)/);
  return match ? match[1] : null;
}

/**
 * Extract FX rate from title
 * "Wymiana waluty PLN/USD 3.5713" -> { pair: "PLN/USD", rate: 3.5713 }
 */
function parseFxRate(title: string): { pair: string; rate: number } | null {
  const match = title.match(/Wymiana waluty (\w+\/\w+) ([\d.]+)/);
  if (match) {
    return { pair: match[1], rate: parseFloat(match[2]) };
  }
  return null;
}
