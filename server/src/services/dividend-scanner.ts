/**
 * Automatic dividend scanner.
 *
 * Periodically checks OPEN positions for dividend events via Yahoo Finance
 * and inserts them as cash_operations with source='auto-yahoo'.
 *
 * Runs at most once per day per portfolio (tracked via portfolio_metadata).
 * Tax rates depend on portfolio account type (IKE/IKZE vs regular).
 */
import { getAllPortfolios, getPortfolio } from '../db/portfolio-registry.js';
import { getAllTransactions } from '../db/transactions-repo.js';
import { getTickerMap } from '../db/ticker-map-repo.js';
import {
  dividendExistsForDateAndTicker,
  insertOperationsWithDedup,
  getLatestDividendDate,
  getMetadata,
  setMetadata,
} from '../db/operations-repo.js';
import { getSplits } from '../db/splits-repo.js';
import { getSharesAtDate } from './portfolio-engine.js';
import { adjustTransactionsForSplits } from './split-detector.js';
import { fetchYahooDividendEvents, fetchDividendCalendar } from './yahoo-finance.js';
import { assumedPayoutsPerYear } from './dividend-estimate.js';
import { DIVIDEND_TAX_REGULAR, DIVIDEND_TAX_IKE_IKZE } from 'shared';
import type { CashOperation, PortfolioSettings, TickerMapEntry } from 'shared';

export interface ScanResult {
  scanned: number;
  newDividends: number;
  errors: string[];
  /** Pominięte podejrzane eventy (sanity-check kwoty) — nie blokują flagi "scan done". */
  warnings: string[];
}

const DEFAULT_LOOKBACK_DAYS = 90;
const PAYMENT_DATE_GRACE_DAYS = 30;

function getCountryFromExchange(exchange: string, ticker: string): string {
  if (exchange === 'GPW' || exchange === 'NC') return 'PL';
  if (exchange === 'XETRA') return 'DE';
  if (exchange === 'TSX') return 'CA';
  if (exchange === 'NYSE' || exchange === 'NASDAQ') return 'US';

  // Fallback: infer from ticker suffix
  if (ticker.endsWith('.WA')) return 'PL';
  if (ticker.endsWith('.DE')) return 'DE';
  if (ticker.endsWith('.L') || ticker.endsWith('.IL')) return 'GB';
  if (ticker.endsWith('.TO')) return 'CA';
  if (ticker.endsWith('.HK')) return 'HK';
  if (ticker.endsWith('.SI')) return 'SG';
  if (ticker.endsWith('.T')) return 'JP';
  if (ticker.endsWith('.AX')) return 'AU';
  if (ticker.endsWith('.BR')) return 'BE';
  if (ticker.endsWith('.PA')) return 'FR';
  if (ticker.endsWith('.SW')) return 'CH';
  if (ticker.endsWith('.OL')) return 'NO';
  if (ticker.endsWith('.AS')) return 'NL';

  return 'US'; // default for unrecognized
}

function getDividendTaxRate(country: string, settings: PortfolioSettings): number {
  const table = settings.isIKE || settings.isIKZE ? DIVIDEND_TAX_IKE_IKZE : DIVIDEND_TAX_REGULAR;
  return table[country] ?? DIVIDEND_TAX_REGULAR['PL'];
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Maksymalny akceptowany odchył kwoty eventu od oczekiwanej raty per wypłatę. */
const SUSPICIOUS_DEVIATION = 4;

/**
 * Sanity-check kwoty dywidendy per akcję z eventu Yahoo.
 *
 * Yahoo potrafi zwrócić błędną kwotę eventu (realny przypadek: BKNG 0.42 USD
 * zamiast ~9.60 — odchył ×23). Porównujemy z oczekiwaną ratą per wypłatę
 * (bieżąca roczna stawka `dividendRate` / liczba wypłat w roku); odchył
 * > SUSPICIOUS_DEVIATION w którąkolwiek stronę → podejrzane. Bez referencji
 * (brak dividendRate) nie oceniamy. Świadomy kompromis: legalna dywidenda
 * specjalna >4× raty też wpadnie — wolimy ostrzeżenie i ręczne dodanie niż
 * cichy śmieciowy wpis.
 */
export function isSuspiciousDividendAmount(
  eventAmount: number,
  annualRate: number | null,
  payoutsPerYear: number,
): { suspicious: false } | { suspicious: true; expected: number; ratio: number } {
  if (!annualRate || annualRate <= 0 || payoutsPerYear <= 0 || eventAmount <= 0) {
    return { suspicious: false };
  }
  const expected = annualRate / payoutsPerYear;
  const ratio = eventAmount > expected ? eventAmount / expected : expected / eventAmount;
  if (ratio <= SUSPICIOUS_DEVIATION) return { suspicious: false };
  return { suspicious: true, expected, ratio };
}

/**
 * Scan a single portfolio for new dividend events.
 * Only scans tickers with currently open positions (shares > 0).
 * Runs at most once per day (tracked in portfolio_metadata).
 */
export async function scanDividends(portfolioId: string): Promise<ScanResult> {
  const portfolio = getPortfolio(portfolioId);
  if (!portfolio) {
    return {
      scanned: 0,
      newDividends: 0,
      errors: [`Portfolio ${portfolioId} not found`],
      warnings: [],
    };
  }

  // Skip if already scanned today
  const today = new Date().toISOString().split('T')[0];
  const lastScan = getMetadata(portfolioId, 'last_dividend_scan');
  if (lastScan === today) {
    return { scanned: 0, newDividends: 0, errors: [], warnings: [] };
  }

  const settings = portfolio.settings;
  const transactions = getAllTransactions(portfolioId);
  const tickerMap = getTickerMap(portfolioId);

  if (transactions.length === 0) {
    return { scanned: 0, newDividends: 0, errors: [], warnings: [] };
  }

  // Liczba akcji musi być liczona na transakcjach skorygowanych o splity —
  // inaczej po splicie 1:10 scanner policzyłby dywidendę od 10x za małej pozycji.
  const savedSplits = getSplits(portfolioId).map((s) => ({
    ticker: s.ticker,
    isin: s.isin,
    date: s.splitDate,
    ratio: s.ratio,
    txPrice: 0,
    providerPrice: 0,
    source: s.source,
  }));
  const adjustedTxs = adjustTransactionsForSplits(transactions, savedSplits);

  // Determine scan start date: from last broker-imported dividend, or 90 days back
  const latestDiv = getLatestDividendDate(portfolioId);
  let startDate: string;
  if (latestDiv) {
    startDate = latestDiv;
  } else {
    const lookbackDate = new Date();
    lookbackDate.setDate(lookbackDate.getDate() - DEFAULT_LOOKBACK_DAYS);
    const lookbackStr = lookbackDate.toISOString().split('T')[0];
    const earliestTx = transactions.reduce(
      (min, t) => (t.date < min ? t.date : min),
      transactions[0].date,
    );
    startDate = earliestTx > lookbackStr ? lookbackStr : earliestTx;
  }

  // Collect unique ISINs with their ticker map entries.
  // Exclude only NC (NewConnect) — Yahoo nie listuje NC, więc brak danych o dywidendach.
  // NIE filtrujemy po priceSource === 'stooq': spółki GPW mogą mieć Stooq jako fallback
  // cenowy, ale dywidendy i tak pobieramy z Yahoo po tickerze .WA.
  // Only include tickers with currently open positions (shares > 0)
  const isinEntries = new Map<string, TickerMapEntry>();
  for (const [isin, entry] of tickerMap) {
    // NC i Catalyst: Yahoo ich nie listuje (kupony obligacji przychodzą z CSV brokera).
    if (entry.exchange === 'NC' || entry.exchange === 'CATALYST') continue;
    // Opcje (pseudo-ISIN OPT:...) nie płacą dywidend — skan byłby zbędnym strzałem do Yahoo.
    if (isin.startsWith('OPT:')) continue;
    // Stan posiadania "na dziś" — włącznie z dzisiejszymi transakcjami (includeDate=true).
    const shares = getSharesAtDate(adjustedTxs, isin, today, true);
    if (shares <= 0) continue;
    isinEntries.set(isin, entry);
  }

  const newOperations: CashOperation[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let scanned = 0;

  for (const [isin, entry] of isinEntries) {
    try {
      const events = await fetchYahooDividendEvents(entry.ticker, startDate);
      scanned++;

      for (const event of events) {
        // Skip if dividend already exists (from any source)
        if (dividendExistsForDateAndTicker(portfolioId, event.date, entry.ticker)) {
          continue;
        }

        const daysSinceEvent = Math.floor(
          (Date.now() - new Date(event.date).getTime()) / 86_400_000,
        );

        // For recent dividends (< 30 days), check if payment has actually occurred
        if (daysSinceEvent < PAYMENT_DATE_GRACE_DAYS) {
          const calendar = await fetchDividendCalendar(entry.ticker).catch(() => null);

          // Payment date known and in the future → not yet paid, skip
          if (
            calendar?.paymentDate &&
            calendar.exDividendDate === event.date &&
            calendar.paymentDate > today
          ) {
            continue;
          }
          // No payment date available for this recent ex-date → skip, wait for next scan
          if (!calendar?.paymentDate && calendar?.exDividendDate === event.date) {
            continue;
          }
        }
        // daysSinceEvent >= 30 → payment certainly occurred, no calendar check needed

        // Prawo do dywidendy: akcje posiadane PRZED ex-date (exclusive, domyślne).
        const shares = getSharesAtDate(adjustedTxs, isin, event.date);
        if (shares <= 0) continue;

        // Sanity-check kwoty eventu vs bieżąca roczna stawka (cache 12h per ticker;
        // dla świeżych eventów kalendarz i tak był już pobrany wyżej).
        const calForSanity = await fetchDividendCalendar(entry.ticker).catch(() => null);
        const sanity = isSuspiciousDividendAmount(
          event.amount,
          calForSanity?.dividendRate ?? null,
          assumedPayoutsPerYear(entry.ticker),
        );
        if (sanity.suspicious) {
          warnings.push(
            `${entry.ticker}: pominięto podejrzaną dywidendę z ${event.date.slice(0, 10)} — ` +
              `${event.amount} ${entry.currency}/akcję przy oczekiwanych ~${sanity.expected.toFixed(2)} ` +
              `(odchył ×${sanity.ratio.toFixed(1)}). Jeśli kwota jest poprawna, dodaj dywidendę ręcznie.`,
          );
          continue;
        }

        const country = getCountryFromExchange(entry.exchange, entry.ticker);
        const taxRate = getDividendTaxRate(country, settings);
        const grossAmount = roundTo2(event.amount * shares);
        const taxAmount = roundTo2(grossAmount * taxRate);
        const netAmount = roundTo2(grossAmount - taxAmount);

        const taxPct = Math.round(taxRate * 100);
        const accountType = settings.isIKE || settings.isIKZE ? 'IKE/IKZE' : 'zwykłe';
        const description = `Dywidenda ${entry.ticker} (${shares} szt. × ${event.amount} ${entry.currency}, podatek ${taxPct}% [${accountType}])`;

        newOperations.push({
          date: event.date,
          operationType: 'dividend',
          description,
          amount: netAmount,
          currency: entry.currency,
          ticker: entry.ticker,
          source: 'auto-yahoo',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${entry.ticker}: ${msg}`);
    }
  }

  let inserted = 0;
  if (newOperations.length > 0) {
    const result = insertOperationsWithDedup(newOperations, portfolioId);
    inserted = result.inserted;
    console.log(
      `[dividend-scanner] ${portfolioId}: scanned ${scanned} tickers (open positions), inserted ${inserted} new dividends`,
    );
  } else if (scanned > 0) {
    console.log(
      `[dividend-scanner] ${portfolioId}: scanned ${scanned} tickers (open positions), no new dividends`,
    );
  }

  if (warnings.length > 0) {
    console.warn(`[dividend-scanner] ${portfolioId}:\n  ${warnings.join('\n  ')}`);
  }

  // Mark scan as done for today — ale NIE gdy wszystko się wysypało (np. outage Yahoo)
  // i nic nie weszło: wtedy zostawiamy flagę, żeby kolejny request spróbował ponownie.
  // Warnings (pominięte podejrzane eventy) celowo NIE blokują flagi — uporczywie
  // błędny event Yahoo nie może wymuszać rescanu przy każdym wywołaniu.
  if (!(errors.length > 0 && inserted === 0)) {
    setMetadata(portfolioId, 'last_dividend_scan', today);
  }

  return { scanned, newDividends: inserted, errors, warnings };
}

/**
 * Scan all portfolios for new dividends.
 * Called by the scheduled job.
 */
export async function scanAllPortfolios(): Promise<void> {
  const portfolios = getAllPortfolios();
  for (const p of portfolios) {
    try {
      await scanDividends(p.id);
    } catch (err) {
      console.error(`[dividend-scanner] Error scanning ${p.id}:`, err);
    }
  }
}
