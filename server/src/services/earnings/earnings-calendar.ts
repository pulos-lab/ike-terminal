/**
 * Kalendarz publikacji wyników — orkiestracja źródeł i punkt wejścia dla API.
 *
 * ZASADA NACZELNA: ścieżka requestu NIGDY nie czeka na sieć. `getUpcomingForPositions`
 * jest synchroniczna i czyta wyłącznie z bazy; odświeżanie chodzi w tle z timerów
 * w `index.ts`. To odstępstwo od `gpw-dividend-calendar`, które awaituje refresh
 * w handlerze — tam to 3 requesty, tutaj zamiatanie US to kilkadziesiąt (~15 s),
 * co zamieniłoby `/positions` w wąskie gardło.
 *
 * Drugie: kalendarz nie może wywrócić widoku portfela. Każde wejście łapie błędy
 * i degraduje do pustej listy.
 */
import type { Position, UpcomingEarnings } from 'shared';
import { config } from '../../config.js';
import path from 'path';
import { createEarningsStore, type EarningsMarket, type EarningsStore } from './earnings-store.js';
import {
  buildUpcomingEarnings,
  selectEarningsCandidates,
  EARNINGS_HORIZON_DAYS,
  type EarningsCandidate,
} from './earnings-window.js';
import { resolveEarningsMarket, resolveEarningsSymbol } from './symbol-resolver.js';
import { fetchNasdaqWindow } from './nasdaq-earnings.js';
import { fetchBankierCompany } from './bankier-earnings.js';
import { getBankierGuard, getNasdaqGuard } from './earnings-guards.js';
import { fetchEarningsCalendar, type YahooEarningsDate } from '../yahoo-finance.js';
import type { SourceGuard } from '../source-guard.js';

/** Pełne zamiatanie US raz na dobę; bliskie okno częściej (terminy potrafią się przesunąć). */
const US_FULL_WINDOW_DAYS = EARNINGS_HORIZON_DAYS;
const US_NEAR_WINDOW_DAYS = 9;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Jak często WOLNO odświeżyć dane źródło. Musi odpowiadać interwałowi timera
 * w `index.ts` — wcześniej wszystko chodziło po wspólnym progu 24 h, przez co
 * timer bliskiego okna (6 h) odpalał się co 6 h, ale za każdym razem odbijał się
 * od bramki świeżości i realnie działał raz na dobę.
 */
const REFRESH_INTERVAL_BY_PREFIX: Record<string, number> = {
  us: REFRESH_INTERVAL_MS,
  'us-near': 6 * 60 * 60 * 1000,
};

/**
 * Tolerancja przy porównaniu ze świeżością. Timer odpala się co DOKŁADNIE tyle,
 * ile wynosi próg, a `last_success` zapisuje się po zakończeniu zamiatania —
 * czyli kilkanaście sekund PÓŹNIEJ. Bez marginesu każdy tik wypada tuż przed
 * progiem, jest odrzucany i odświeżanie dryfuje do dwukrotności interwału.
 */
const REFRESH_TOLERANCE_MS = 5 * 60 * 1000;

/** Grzeczność wobec bankiera: 1 s przerwy i twardy limit spółek na jeden przebieg. */
const PL_POLITENESS_DELAY_MS = 1000;
const PL_MAX_SLUGS_PER_RUN = 40;
const FOREIGN_MAX_PER_RUN = 40;

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Minimalny udział poprzedniego wyniku, poniżej którego NIE podmieniamy terminarza.
 * Ochrona przed cichym wyczyszczeniem danych, gdy serwis zmieni szablon HTML:
 * lepiej podać wczorajszy terminarz niż żaden. Patrz też `registerParseMiss`.
 */
const HEALTH_MIN_RATIO = 0.5;

export interface EarningsCalendarServiceOptions {
  fetchFn?: typeof fetch;
  dbFile?: string;
  now?: () => Date;
  politenessDelayMs?: number;
  nasdaqGuard?: SourceGuard;
  bankierGuard?: SourceGuard;
  /** Wstrzykiwane w testach — produkcyjnie Yahoo quoteSummary. */
  fetchForeignEarnings?: (ticker: string) => Promise<YahooEarningsDate | null>;
}

export interface EarningsCalendarService {
  /** Czysto odczytowa — bez sieci, bez awaitów. Błąd → pusta lista. */
  getUpcomingForPositions(positions: Position[], todayIso?: string): UpcomingEarnings[];
  refreshUs(opts?: { nearWindowOnly?: boolean }): Promise<void>;
  /** Bez argumentu odświeża spółki poznane wcześniej (wejście dla timera). */
  refreshPl(slugs?: string[]): Promise<void>;
  /** Giełdy spoza kalendarza Nasdaq (XETRA/TSX) — przez Yahoo, per ticker. */
  refreshForeign(tickers?: string[]): Promise<void>;
  refreshAll(): Promise<void>;
  close(): void;
}

/** `YYYY-MM-DD` z daty w UTC — spójne z arytmetyką dni w `earnings-window`. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Kolejne dni kalendarzowe od `start` (włącznie), w formacie ISO. */
export function isoDateRange(start: Date, days: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime());
    d.setUTCDate(d.getUTCDate() + i);
    out.push(toIsoDate(d));
  }
  return out;
}

export function createEarningsCalendarService(
  options: EarningsCalendarServiceOptions = {},
): EarningsCalendarService {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const politenessDelayMs = options.politenessDelayMs ?? 300;
  const dbFile = options.dbFile ?? path.join(config.dataDir, 'price_history.db');

  let store: EarningsStore | null = null;
  // Osobny in-flight per źródło: zamiatanie US nie może blokować odświeżenia PL.
  const inFlight = new Map<string, Promise<void>>();

  function getStore(): EarningsStore {
    if (!store) store = createEarningsStore({ dbFile });
    return store;
  }

  const nasdaqGuard = () => options.nasdaqGuard ?? getNasdaqGuard();
  const bankierGuard = () => options.bankierGuard ?? getBankierGuard();

  /** Serializacja odświeżeń per źródło (drugi równoległy wołacz dostaje ten sam promise). */
  function once(key: string, run: () => Promise<void>): Promise<void> {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const promise = run().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  /** Czy wolno próbować: dane stale ORAZ minął backoff po nieudanej próbie. */
  function shouldAttempt(prefix: string): boolean {
    const s = getStore();
    const nowMs = now().getTime();
    const interval = REFRESH_INTERVAL_BY_PREFIX[prefix] ?? REFRESH_INTERVAL_MS;
    const lastSuccess = s.getStateMs(`${prefix}:last_success`);
    const lastAttempt = s.getStateMs(`${prefix}:last_attempt`);
    const isStale = lastSuccess === null || nowMs - lastSuccess >= interval - REFRESH_TOLERANCE_MS;
    // Backoff po nieudanej próbie nie może być dłuższy niż sam interwał odświeżania,
    // inaczej dla źródeł częstszych niż 1 h zjadłby wszystkie tiki.
    const retry = Math.min(RETRY_INTERVAL_MS, interval);
    const canAttempt = lastAttempt === null || nowMs - lastAttempt >= retry - REFRESH_TOLERANCE_MS;
    return isStale && canAttempt;
  }

  /**
   * Czy podmiana jest bezpieczna. Zamiatanie niekompletne (część dni padła) albo
   * podejrzanie ubogie względem poprzedniego wyniku → zostawiamy stare dane.
   */
  function isSafeToReplace(
    prefix: string,
    market: EarningsMarket,
    rowCount: number,
    complete: boolean,
    fromDate: string,
  ): boolean {
    if (!complete) {
      console.warn(`[earnings/${prefix}] zamiatanie niekompletne — zostawiam poprzedni terminarz`);
      return false;
    }
    if (rowCount === 0) {
      console.warn(`[earnings/${prefix}] zero wierszy — zostawiam poprzedni terminarz`);
      return false;
    }
    const previous = getStore().countFrom(market, fromDate);
    if (previous > 0 && rowCount < previous * HEALTH_MIN_RATIO) {
      console.warn(
        `[earnings/${prefix}] podejrzanie mało wierszy (${rowCount} vs ${previous}) — ` +
          'parser prawdopodobnie się rozjechał, NIE podmieniam terminarza',
      );
      return false;
    }
    return true;
  }

  async function doRefreshUs(nearWindowOnly: boolean): Promise<void> {
    const s = getStore();
    const prefix = nearWindowOnly ? 'us-near' : 'us';
    s.setState(`${prefix}:last_attempt`, now().toISOString());

    const today = now();
    const dates = isoDateRange(today, nearWindowOnly ? US_NEAR_WINDOW_DAYS : US_FULL_WINDOW_DAYS);
    const fromDate = dates[0];
    const { rows, complete } = await fetchNasdaqWindow(dates, {
      fetchFn,
      guard: nasdaqGuard(),
      politenessDelayMs,
    });

    // Bliskie okno podmienia tylko swój wycinek dat, żeby nie skasować dalszej części
    // terminarza zebranej pełnym zamiataniem.
    const toDate = dates[dates.length - 1];
    const scoped = rows.filter((r) => r.reportDate >= fromDate && r.reportDate <= toDate);
    if (!isSafeToReplace(prefix, 'US', scoped.length, complete, fromDate)) return;

    if (nearWindowOnly) {
      s.replaceSource('nasdaq', 'US', scoped, { fromDate, fetchedAt: now().toISOString(), toDate });
    } else {
      s.replaceSource('nasdaq', 'US', scoped, { fromDate, fetchedAt: now().toISOString() });
    }
    s.setState(`${prefix}:last_success`, now().toISOString());
    s.pruneBefore(toIsoDate(new Date(today.getTime() - 90 * 86_400_000)));
    console.log(`[earnings/${prefix}] terminarz US zaktualizowany: ${scoped.length} publikacji`);
  }

  /**
   * Terminarz polskich spółek pobieramy PER SPÓŁKA, bo kalendarz zbiorczy bankiera
   * pokazuje wyłącznie bieżący tydzień, a strona spółki oddaje jej pełny harmonogram
   * roczny. Stan trzymamy per slug, dzięki czemu żadna spółka nie jest odpytywana
   * częściej niż raz na dobę, a odświeżenia rozkładają się w czasie.
   */
  async function doRefreshPlSlugs(slugs: string[]): Promise<void> {
    const s = getStore();
    const nowMs = now().getTime();

    const stale = slugs.filter((slug) => {
      const lastAttempt = s.getStateMs(`pl:slug:${slug}:last_attempt`);
      return lastAttempt === null || nowMs - lastAttempt > REFRESH_INTERVAL_MS;
    });
    if (stale.length === 0) return;

    const capped = stale.slice(0, PL_MAX_SLUGS_PER_RUN);
    if (capped.length < stale.length) {
      console.log(
        `[earnings/pl] ${stale.length} spółek do odświeżenia, biorę ${capped.length} — ` +
          'reszta w kolejnym przebiegu',
      );
    }

    let updated = 0;
    for (const [index, slug] of capped.entries()) {
      if (bankierGuard().isBlocked()) {
        console.warn('[earnings/pl] bezpiecznik otwarty — przerywam odświeżanie');
        break;
      }
      if (index > 0) await sleep(PL_POLITENESS_DELAY_MS);

      s.setState(`pl:slug:${slug}:last_attempt`, now().toISOString());
      const { rows, ok } = await fetchBankierCompany(slug, { fetchFn, guard: bankierGuard() });
      if (!ok) continue;

      const fromDate = toIsoDate(now());
      const upcoming = rows.filter((r) => r.reportDate >= fromDate);
      // Pusta lista JEST poprawnym wynikiem (spółka bez ogłoszonych terminów),
      // więc podmieniamy także wtedy — inaczej odwołany termin wisiałby w nieskończoność.
      s.replaceSymbol('bankier', 'PL', slug, upcoming, {
        fromDate,
        fetchedAt: now().toISOString(),
      });
      s.setState(`pl:slug:${slug}:last_success`, now().toISOString());
      updated += 1;
    }

    if (updated > 0) {
      s.setState('pl:last_success', now().toISOString());
      console.log(`[earnings/pl] odświeżono terminarz ${updated} spółek GPW/NC`);
    }
  }

  /** Slugi, które już kiedyś rozwiązaliśmy — wejście dla odświeżania z timera. */
  function knownPlSlugs(): string[] {
    return getStore().getMappedSymbolKeys('PL');
  }

  /**
   * Giełdy spoza kalendarza Nasdaq (XETRA, TSX). Yahoo to jedyne darmowe źródło
   * o takim zasięgu, ale nie podaje pory sesji i często oddaje WIDEŁKI dat zamiast
   * konkretnego dnia — stąd `tentative`/`estimated` zamiast `confirmed`.
   */
  async function doRefreshForeign(tickers: string[]): Promise<void> {
    const s = getStore();
    const nowMs = now().getTime();
    const fetchEarnings = options.fetchForeignEarnings ?? fetchEarningsCalendar;

    const stale = tickers.filter((t) => {
      const lastAttempt = s.getStateMs(`foreign:${t}:last_attempt`);
      return lastAttempt === null || nowMs - lastAttempt > REFRESH_INTERVAL_MS;
    });

    for (const ticker of stale.slice(0, FOREIGN_MAX_PER_RUN)) {
      s.setState(`foreign:${ticker}:last_attempt`, now().toISOString());
      const result = await fetchEarnings(ticker);
      if (!result) continue;

      const fromDate = toIsoDate(now());
      const rows =
        result.date >= fromDate
          ? [
              {
                market: 'FOREIGN' as const,
                symbolKey: ticker,
                reportDate: result.date,
                confidence: result.isEstimate ? ('estimated' as const) : ('tentative' as const),
                session: null,
                fiscalLabel: null,
                reportKind: null,
                source: 'yahoo' as const,
                epsForecast: null,
              },
            ]
          : [];
      s.replaceSymbol('yahoo', 'FOREIGN', ticker, rows, {
        fromDate,
        fetchedAt: now().toISOString(),
      });
    }
  }

  /** Kandydaci wzbogaceni o rynek i klucz symbolu; mapowania PL są cache'owane w bazie. */
  function withSymbols(
    candidates: EarningsCandidate[],
  ): Array<EarningsCandidate & { market: EarningsMarket; symbolKey: string }> {
    const s = getStore();
    const out: Array<EarningsCandidate & { market: EarningsMarket; symbolKey: string }> = [];
    const verifiedAt = now().toISOString();

    for (const candidate of candidates) {
      const market = resolveEarningsMarket({
        exchange: candidate.exchange,
        country: candidate.country,
        currency: candidate.currency,
        ticker: candidate.ticker,
      });
      if (!market) continue;

      if (market !== 'PL') {
        out.push({ ...candidate, market, symbolKey: candidate.ticker.toUpperCase() });
        continue;
      }

      const cached = s.getSymbolMapping('PL', candidate.ticker);
      if (cached) {
        out.push({ ...candidate, market, symbolKey: cached.symbolKey });
        continue;
      }
      const resolved = resolveEarningsSymbol('PL', candidate.ticker, candidate.name, {
        dividendBridge: (base) => s.lookupDividendShortName(base),
      });
      if (!resolved) continue;
      s.putSymbolMapping('PL', candidate.ticker, resolved, verifiedAt);
      out.push({ ...candidate, market, symbolKey: resolved.symbolKey });
    }
    return out;
  }

  return {
    getUpcomingForPositions(positions, todayIso) {
      try {
        const today = todayIso ?? toIsoDate(now());
        const candidates = withSymbols(selectEarningsCandidates(positions));
        if (candidates.length === 0) return [];

        const s = getStore();
        const byMarket = new Map<EarningsMarket, Set<string>>();
        for (const c of candidates) {
          const set = byMarket.get(c.market) ?? new Set<string>();
          set.add(c.symbolKey);
          byMarket.set(c.market, set);
        }

        const rows = [...byMarket.entries()].flatMap(([market, keys]) =>
          s.getForSymbols(market, [...keys], today),
        );

        // Terminarz PL jest odpytywany per spółka, więc nowa polska pozycja wymaga
        // dociągnięcia. Odpalamy w tle (fire-and-forget) — odpowiedź leci od razu
        // z tym, co już jest, a ikona pojawi się przy kolejnym odświeżeniu widoku.
        const plSlugs = byMarket.get('PL');
        if (plSlugs?.size) {
          const nowMs = now().getTime();
          const missing = [...plSlugs].filter((slug) => {
            const lastAttempt = s.getStateMs(`pl:slug:${slug}:last_attempt`);
            return lastAttempt === null || nowMs - lastAttempt > REFRESH_INTERVAL_MS;
          });
          if (missing.length > 0) {
            void this.refreshPl(missing).catch(() => {});
          }
        }

        const foreignTickers = byMarket.get('FOREIGN');
        if (foreignTickers?.size) {
          const nowMs = now().getTime();
          const missing = [...foreignTickers].filter((t) => {
            const lastAttempt = s.getStateMs(`foreign:${t}:last_attempt`);
            return lastAttempt === null || nowMs - lastAttempt > REFRESH_INTERVAL_MS;
          });
          if (missing.length > 0) {
            void this.refreshForeign(missing).catch(() => {});
          }
        }

        return buildUpcomingEarnings(candidates, rows, today);
      } catch (err) {
        console.warn('[earnings] odczyt terminarza nie powiódł się — pomijam:', err);
        return [];
      }
    },

    refreshUs(opts = {}) {
      const nearWindowOnly = opts.nearWindowOnly ?? false;
      const prefix = nearWindowOnly ? 'us-near' : 'us';
      return once(prefix, async () => {
        try {
          if (!shouldAttempt(prefix)) return;
          await doRefreshUs(nearWindowOnly);
        } catch (err) {
          console.warn(`[earnings/${prefix}] odświeżanie nie powiodło się:`, err);
        }
      });
    },

    refreshPl(slugs) {
      return once('pl', async () => {
        try {
          const targets = slugs ?? knownPlSlugs();
          if (targets.length === 0) return;
          await doRefreshPlSlugs(targets);
        } catch (err) {
          console.warn('[earnings/pl] odświeżanie nie powiodło się:', err);
        }
      });
    },

    refreshForeign(tickers) {
      return once('foreign', async () => {
        try {
          const targets = tickers ?? getStore().getMappedSymbolKeys('FOREIGN');
          if (targets.length === 0) return;
          await doRefreshForeign(targets);
        } catch (err) {
          console.warn('[earnings/foreign] odświeżanie nie powiodło się:', err);
        }
      });
    },

    async refreshAll() {
      await this.refreshUs();
      await this.refreshPl();
      await this.refreshForeign();
    },

    close() {
      store?.close();
      store = null;
    },
  };
}

let singleton: EarningsCalendarService | null = null;

export function getEarningsCalendarService(): EarningsCalendarService {
  if (!singleton) singleton = createEarningsCalendarService();
  return singleton;
}

/** Testy podmieniają instancję; null przywraca default. */
export function setEarningsCalendarServiceForTests(service: EarningsCalendarService | null): void {
  singleton = service;
}
