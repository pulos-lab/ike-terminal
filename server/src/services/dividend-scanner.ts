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
import { buildFxToPlnLookup, type FxToPlnLookup } from './fx-history.js';
import { DIVIDEND_TAX_REGULAR, DIVIDEND_TAX_IKE_IKZE } from 'shared';
import type { CashOperation, PortfolioSettings, TickerMapEntry, Transaction } from 'shared';

export interface ScanResult {
  scanned: number;
  newDividends: number;
  errors: string[];
  /** Pominięte podejrzane eventy (sanity-check kwoty) — nie blokują flagi "scan done". */
  warnings: string[];
}

const DEFAULT_LOOKBACK_DAYS = 90;
const PAYMENT_DATE_GRACE_DAYS = 30;
// Próg „posiadanych akcji" na ex-date. Poniżej = reszta zmiennoprzecinkowa po pełnej
// sprzedaży (frakcyjne akcje sięgają ~1e-4, residua FP ~1e-13 — 1e-6 rozdziela je pewnie).
const SHARE_EPSILON = 1e-6;

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
 * Waluta, w której dywidenda REALNIE wpływa na konto — u brokera zależy od tego,
 * jak rozliczane są zakupy: papier USD kupiony za PLN (auto-FX brokera, np. Bossa
 * z kontem PLN) dostaje dywidendy już przewalutowane na PLN; papier kupiony wprost
 * z subkonta USD dostaje je w USD. Tę samą informację niesie `paymentCurrency`
 * transakcji K (parsery XTB/mBank wprost, Bossa/DEGIRO przez reconciler).
 *
 * Dywidenda za całą pozycję wpływa w JEDNEJ walucie, nie per-lot — przybliżamy ją
 * walutą rozliczenia dominującą po liczbie akcji wśród kupien sprzed ex-date
 * (mieszane loty / pozycja z kilku brokerów = świadome przybliżenie). Remis
 * rozstrzyga ostatnie kupno — odzwierciedla bieżącą konfigurację konta.
 */
export function inferDividendPayoutCurrency(
  adjustedTxs: Transaction[],
  isin: string,
  exDate: string,
  quoteCurrency: string,
): string {
  const exKey = exDate.slice(0, 10);
  const sharesByCcy = new Map<string, number>();
  let lastCcy: string | null = null;
  let lastDate = '';

  for (const tx of adjustedTxs) {
    if (tx.isin !== isin || tx.side !== 'K') continue;
    // CFD nie rozliczają się przez cash ledger; prawo do dywidendy = kupno PRZED ex-date.
    if (tx.category === 'cfd' || tx.date.slice(0, 10) >= exKey) continue;
    const ccy = (tx.paymentCurrency ?? tx.currency).toUpperCase();
    sharesByCcy.set(ccy, (sharesByCcy.get(ccy) ?? 0) + tx.quantity);
    if (tx.date >= lastDate) {
      lastDate = tx.date;
      lastCcy = ccy;
    }
  }

  let maxShares = 0;
  for (const shares of sharesByCcy.values()) {
    if (shares > maxShares) maxShares = shares;
  }
  if (maxShares <= 0) return quoteCurrency.toUpperCase();

  const leaders = Array.from(sharesByCcy.entries())
    .filter(([, shares]) => Math.abs(shares - maxShares) <= SHARE_EPSILON)
    .map(([ccy]) => ccy);
  if (lastCcy && leaders.includes(lastCcy)) return lastCcy;
  return leaders[0];
}

export interface DividendPayoutConversion {
  /** Kwota netto do zaksięgowania (round2 po konwersji; bez konwersji = netQuote). */
  amount: number;
  currency: string;
  /** Kurs payout-per-quote (kanoniczna konwencja jak Transaction.fxRate) — tylko gdy skonwertowano. */
  fxRate?: number;
  /** Para do audytu, np. 'USD/PLN' — tylko gdy skonwertowano. */
  fxPair?: string;
  /** true = konwersja była potrzebna, ale zabrakło kursu → fallback do waluty notowania. */
  missingRate: boolean;
}

/**
 * Przelicza netto dywidendy z waluty notowania na walutę faktycznej wypłaty po
 * kursie dziennym (lookup PLN-owy działa też dla par bez PLN: quote→payout =
 * fx(quote)/fx(payout), dla PLN mianownik = 1). Kurs rynkowy z ex-date to
 * przybliżenie — broker przewalutowuje po własnym kursie (ze spreadem) w dniu
 * wypłaty, którego skaner nie zna; wpis auto-yahoo jest z natury estymatą do
 * czasu importu wyciągu brokera. Brak kursu NIE ucina wpisu — zapisujemy jak
 * dotąd w walucie notowania (zero regresji), a wywołujący raportuje warning.
 */
export function convertDividendToPayoutCurrency(
  netQuote: number,
  quoteCurrency: string,
  payoutCurrency: string,
  date: string,
  fx: FxToPlnLookup,
): DividendPayoutConversion {
  const quote = quoteCurrency.toUpperCase();
  const payout = payoutCurrency.toUpperCase();
  if (quote === payout) {
    return { amount: netQuote, currency: quote, missingRate: false };
  }
  const quotePln = fx(quote, date);
  const payoutPln = fx(payout, date);
  if (quotePln == null || payoutPln == null || payoutPln <= 0) {
    return { amount: netQuote, currency: quote, missingRate: true };
  }
  const rate = quotePln / payoutPln;
  return {
    amount: roundTo2(netQuote * rate),
    currency: payout,
    fxRate: rate,
    fxPair: `${quote}/${payout}`,
    missingRate: false,
  };
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

  // Prefetch kursów do konwersji na walutę wypłaty: unia waluty notowania i WSZYSTKICH
  // walut rozliczenia kupien danego ISIN (finalna waluta wypłaty liczona per event
  // z realnym ex-date, więc bierzemy pełną unię, nie tylko dzisiejszego zwycięzcę).
  // Portfel bez rozjazdu quote/payment (np. czysto PLN-GPW) → zero dodatkowych fetchy.
  const settlementByIsin = new Map<string, Set<string>>();
  for (const tx of adjustedTxs) {
    if (tx.side !== 'K' || tx.category === 'cfd' || !isinEntries.has(tx.isin)) continue;
    const set = settlementByIsin.get(tx.isin) ?? new Set<string>();
    set.add((tx.paymentCurrency ?? tx.currency).toUpperCase());
    settlementByIsin.set(tx.isin, set);
  }
  const fxCurrencies = new Set<string>();
  for (const [isin, entry] of isinEntries) {
    const settlements = settlementByIsin.get(isin);
    if (!settlements) continue;
    const quote = entry.currency.toUpperCase();
    if (Array.from(settlements).some((ccy) => ccy !== quote)) {
      fxCurrencies.add(quote);
      for (const ccy of settlements) fxCurrencies.add(ccy);
    }
  }
  const fx: FxToPlnLookup =
    fxCurrencies.size > 0
      ? await buildFxToPlnLookup(Array.from(fxCurrencies), startDate)
      : (cur) => (cur.toUpperCase() === 'PLN' ? 1 : null);

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
        // Epsilon zamiast `<= 0`: pozycja kupiona i sprzedana w całości przed ex-date
        // zostawia w sumie FIFO resztę zmiennoprzecinkową (~1e-16), która przechodziła
        // przez `<= 0` i tworzyła widmową dywidendę 0,00 z opisem "8.88e-16 szt.".
        const shares = getSharesAtDate(adjustedTxs, isin, event.date);
        if (shares < SHARE_EPSILON) continue;

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

        // Księgujemy w walucie FAKTYCZNEJ wypłaty (np. PLN dla papieru USD kupionego
        // przez auto-FX brokera), nie w walucie notowania — inaczej saldo gotówki
        // dostaje fikcyjną walutę, której na koncie nie ma.
        const payoutCurrency = inferDividendPayoutCurrency(
          adjustedTxs,
          isin,
          event.date,
          entry.currency,
        );
        const conv = convertDividendToPayoutCurrency(
          netAmount,
          entry.currency,
          payoutCurrency,
          event.date,
          fx,
        );
        if (conv.missingRate) {
          warnings.push(
            `${entry.ticker}: brak kursu ${entry.currency}/${payoutCurrency} na ` +
              `${event.date.slice(0, 10)} — dywidenda zapisana w ${entry.currency}; ` +
              `skoryguj ręcznie lub zaimportuj wyciąg brokera.`,
          );
        }

        const taxPct = Math.round(taxRate * 100);
        // Zwięzły opis — ticker jest w osobnej kolumnie widoku Dywidendy, a liczba akcji
        // wynika z kwoty. Zostawiamy tylko to, czego nie widać gdzie indziej: stawkę
        // na akcję (w walucie notowania), pobrany podatek u źródła i ew. kurs konwersji.
        const description =
          `${event.amount} ${entry.currency}/szt · podatek ${taxPct}%` +
          (conv.fxRate !== undefined ? ` · kurs ${conv.fxRate.toFixed(4)}` : '');

        newOperations.push({
          date: event.date,
          operationType: 'dividend',
          description,
          amount: conv.amount,
          currency: conv.currency,
          ticker: entry.ticker,
          fxRate: conv.fxRate,
          fxPair: conv.fxPair,
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
