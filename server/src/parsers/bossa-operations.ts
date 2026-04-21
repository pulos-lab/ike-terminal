import Papa from 'papaparse';
import type { CashOperation, OperationType, ParseResult, SkippedRow } from 'shared';
import { parseNumber } from './utils.js';

/**
 * Parse Bossa cash operations CSV
 * Format: semicolon delimited, windows-1250 encoding (pre-decoded), comma decimals
 * Columns: data;tytuł operacji;szczegóły;kwota;waluta
 * Date format: YYYY-MM-DD
 */
/** Valid date format: YYYY-MM-DD */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseBossaOperations(csvContent: string, importBatch: string): ParseResult<CashOperation> {
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
    return { data: [], skipped: [] };
  }

  const operations: CashOperation[] = [];
  const skipped: SkippedRow[] = [];

  const rows = result.data as any[];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-based, +1 for header
    const dateStr = row['data']?.trim();
    const title = row['tytuł operacji']?.trim() || row['tytu\u0142 operacji']?.trim() || '';
    const details = row['szczegóły']?.trim() || row['szczeg\u00f3\u0142y']?.trim() || '';
    const amount = parseNumber(row['kwota']);
    const currency = row['waluta']?.trim();

    if (!dateStr) { skipped.push({ row: rowNum, reason: 'missing_date', paperName: title }); continue; }
    if (!DATE_RE.test(dateStr)) { skipped.push({ row: rowNum, reason: 'invalid_date', paperName: title }); continue; }
    if (amount === 0) { skipped.push({ row: rowNum, reason: 'zero_amount', paperName: title }); continue; }

    const operationType = classifyOperation(title, amount);

    // Skip transaction settlement records — they belong to transactions, not cash operations
    if (operationType === 'skip') { skipped.push({ row: rowNum, reason: 'settlement_record', paperName: title }); continue; }

    const ticker = parseDividendTicker(title);
    const fxInfo = parseFxRate(title);

    operations.push({
      date: `${dateStr}T00:00:00`,
      operationType,
      description: humanizeDescription(title),
      details: details || undefined,
      amount,
      currency: currency || 'PLN',
      ticker: ticker || undefined,
      fxRate: fxInfo?.rate,
      fxPair: fxInfo?.pair,
      source: 'bossa',
      importBatch,
    });
  }

  return { data: operations, skipped };
}

/** Generate human-readable description from raw Bossa operation title */
function humanizeDescription(title: string): string {
  if (title === 'Zwrot prowizji') return 'Zwrot prowizji';
  if (title.startsWith('Przelew do DM')) return 'Zasilenie konta';
  if (title.startsWith('Przelew wewnętrzny') || title.startsWith('Przelew wewn\u0119trzny')) return title;

  // Dywidendy: "Wypłata dywidendy brutto ASBIS" → "Dywidenda brutto ASBIS"
  const divMatch = title.match(/Wypłata dywidendy\s+(.*)/i) || title.match(/Wyp\u0142ata dywidendy\s+(.*)/i);
  if (divMatch) return `Dywidenda ${divMatch[1]}`;

  // Rozliczenie oferty
  const offerFeeMatch = title.match(/Rozliczenie oferty - prowizja\s+(\S+)/);
  if (offerFeeMatch) return `Prowizja od oferty skupu ${offerFeeMatch[1]}`;
  const offerMatch = title.match(/Rozliczenie oferty\s+(\S+)/);
  if (offerMatch) return `Wykup w ofercie skupu ${offerMatch[1]}`;

  // Wykup certyfikatów: strip "(kwota brutto)"
  const certMatch = title.match(/Wykup certyfikat(?:ów|\u00f3w)\s+(\S+)/);
  if (certMatch) return `Wykup certyfikatów ${certMatch[1]}`;

  // Zapisy na akcje: "Zapisy na akcje BIOCELTIX S.A. SERIA G" → "Subskrypcja akcji BIOCELTIX (seria G)"
  const subMatch = title.match(/Zapisy na akcje\s+(.+?)(?:\s+SERIA\s+(\S+))?$/i);
  if (subMatch) {
    const name = subMatch[1].replace(/\s+S\.A\.$/, '');
    return subMatch[2] ? `Subskrypcja akcji ${name} (seria ${subMatch[2]})` : `Subskrypcja akcji ${name}`;
  }

  // Zwrot nadpłaty
  if (title.includes('przekroczony limit')) return 'Zwrot nadpłaty — przekroczony limit IKE/IKZE';
  const refundMatch = title.match(/Zwrot nadp(?:łaty|\u0142aty)\s+(.+?)(?:\s+S\.A\.)?$/);
  if (refundMatch) return `Zwrot nadpłaty z subskrypcji ${refundMatch[1].replace(/\s+S\.A\.$/, '')}`;

  // Obniżenie wartości nominalnej
  const nominalMatch = title.match(/Obni(?:żenie|[\u017c]enie) warto(?:ści|[\u015b]ci) nominalnej\s+(\S+)/);
  if (nominalMatch) return `Umorzenie akcji ${nominalMatch[1]} (obniżenie nominału)`;

  // Opłaty — keep as-is, already clear
  return title;
}

function classifyOperation(title: string, amount: number): OperationType | 'skip' {
  if (title.includes('Rozliczenie transakcji')) return 'skip';

  // Rozliczenie oferty (buyback/tender offer) — prowizja = fee, wpływ = deposit
  if (title.includes('Rozliczenie oferty')) {
    return title.includes('prowizja') ? 'fee' : 'deposit';
  }

  if (title.includes('Przelew')) return amount < 0 ? 'withdrawal' : 'deposit';
  if (title.toLowerCase().includes('dywidendy')) return 'dividend';
  if (title.includes('Wymiana waluty')) return 'fx_exchange';

  // Opłaty (transakcyjne, WZA, blokady, inne)
  if (title.startsWith('Opłata za') || title.startsWith('Op\u0142ata za')) return 'fee';

  if (title.includes('Zwrot prowizji')) return 'commission_refund';

  // Wykup certyfikatów (redempcja przez emitenta) → wpływ gotówki
  if (title.includes('Wykup certyfikatów') || title.includes('Wykup certyfikat\u00f3w')) return 'deposit';

  // Zapisy na akcje (IPO/SPO) → wypływ gotówki
  if (title.includes('Zapisy na akcje')) return 'withdrawal';

  // Zwrot nadpłaty (limit IKE/IKZE lub subskrypcja)
  if (title.includes('Zwrot nadpłaty') || title.includes('Zwrot nadp\u0142aty')) return amount > 0 ? 'deposit' : 'withdrawal';

  // Obniżenie wartości nominalnej (corporate action) → wpływ
  if (title.includes('Obniżenie wartości nominalnej') || title.includes('Obni\u017cenie warto\u015bci nominalnej')) return 'deposit';

  return 'other';
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
 * Extract certificate ticker from buyout title
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

