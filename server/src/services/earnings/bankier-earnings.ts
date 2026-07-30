/**
 * Terminarz raportów okresowych spółek GPW i NewConnect z bankier.pl.
 *
 * Dlaczego akurat to źródło: polski emitent ma USTAWOWY obowiązek (§84 ust. 1
 * rozporządzenia MF z 6.06.2025) ogłosić raportem bieżącym daty wszystkich raportów
 * okresowych na cały rok z góry — i każdą zmianę terminu osobnym raportem. bankier
 * agreguje te komunikaty w gotowy terminarz renderowany SERVER-SIDE, w jednej
 * przestrzeni URL dla GPW i NewConnectu. To mocniejsze niż cokolwiek dostępnego
 * dla rynku amerykańskiego, gdzie zapowiedź terminu jest dobrowolna.
 *
 * Odpytujemy STRONĘ SPÓŁKI, nie kalendarz zbiorczy: zbiorczy pokazuje wyłącznie
 * bieżący tydzień (nawigacja jest JS-owa, parametry URL są ignorowane), a strona
 * spółki oddaje jej pełny harmonogram roczny w jednym żądaniu.
 */
import * as cheerio from 'cheerio';
import type { SourceGuard } from '../source-guard.js';
import { detectEarningsSourceBlock } from './earnings-guards.js';
import type { EarningsRow } from './earnings-store.js';
import type { EarningsReportKind } from 'shared';

const FETCH_TIMEOUT_MS = 15_000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export function bankierCompanyUrl(slug: string): string {
  return `https://www.bankier.pl/gielda/notowania/akcje/${encodeURIComponent(slug)}/kalendarium`;
}

/** Miesiące w dopełniaczu — bankier renderuje „19 Marca 2026 ● Czwartek". */
const POLISH_MONTHS_GENITIVE: Record<string, string> = {
  stycznia: '01',
  lutego: '02',
  marca: '03',
  kwietnia: '04',
  maja: '05',
  czerwca: '06',
  lipca: '07',
  sierpnia: '08',
  września: '09',
  wrzesnia: '09',
  października: '10',
  pazdziernika: '10',
  listopada: '11',
  grudnia: '12',
};

/**
 * `data-timestamp` to północ czasu warszawskiego, więc surowe `toISOString()`
 * cofnęłoby datę o dzień (CET = UTC+1, CEST = UTC+2). Dodanie 12 h przed
 * odczytem daty UTC jest odporne na obie strefy i na zmianę czasu.
 */
export function isoFromBankierTimestamp(timestamp: string | undefined): string | null {
  if (!timestamp) return null;
  const seconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date((seconds + 12 * 3600) * 1000).toISOString().slice(0, 10);
}

/** „19 Marca 2026 ● Czwartek" → „2026-03-19". Zapas, gdy zabraknie timestampu. */
export function parseBankierLongDate(text: string): string | null {
  const match = text
    .replace(/\s+/g, ' ')
    .trim()
    .match(/^(\d{1,2})\s+(\p{L}+)\s+(\d{4})/u);
  if (!match) return null;
  const month = POLISH_MONTHS_GENITIVE[match[2].toLowerCase()];
  if (!month) return null;
  return `${match[3]}-${month}-${match[1].padStart(2, '0')}`;
}

/**
 * Rodzaj raportu z opisu zdarzenia. Etykietę okresu zostawiamy w formie, w jakiej
 * podała ją spółka („I kwartał 2026", „I półrocze 2026") — własna interpretacja
 * roku obrotowego byłaby zgadywaniem (część spółek ma rok przesunięty).
 */
export function classifyBankierReport(info: string): {
  fiscalLabel: string | null;
  reportKind: EarningsReportKind | null;
} {
  const text = info.replace(/\s+/g, ' ').trim();

  const quarter = text.match(/za\s+(I{1,3}V?|IV)\s+kwartał\s+(\d{4})/i);
  if (quarter) {
    return {
      fiscalLabel: `${quarter[1].toUpperCase()} kwartał ${quarter[2]}`,
      reportKind: 'quarterly',
    };
  }
  const half = text.match(/za\s+(I{1,2})\s+półrocze\s+(\d{4})/i);
  if (half) {
    return {
      fiscalLabel: `${half[1].toUpperCase()} półrocze ${half[2]}`,
      reportKind: 'semiannual',
    };
  }
  const annual = text.match(/za\s+(\d{4})\s+rok/i);
  if (annual) {
    return { fiscalLabel: `rok ${annual[1]}`, reportKind: 'annual' };
  }
  return { fiscalLabel: null, reportKind: null };
}

/** Czy badge zdarzenia oznacza publikację raportu okresowego (a nie WZA/dywidendy/splitu). */
export function isEarningsBadge(badge: string): boolean {
  return badge.replace(/\s+/g, ' ').trim().toLowerCase() === 'wyniki spółek';
}

/**
 * Czysty parser strony kalendarium spółki. Zwraca WYŁĄCZNIE publikacje raportów.
 *
 * Struktura: `.m-quotes-calendar-list__item[data-timestamp]` → nagłówek z datą +
 * lista `.m-quotes-calendar-list__event`, każde z opisem `__info` i badge'em typu.
 * Na stronie zbiorczej dochodzi `a.m-quotes-calendar-list__symbol` ze slugiem —
 * obsługujemy oba warianty, dzięki czemu ten sam parser czyta obie strony.
 */
export function parseBankierCalendar(html: string, defaultSlug?: string): EarningsRow[] {
  const $ = cheerio.load(html);
  const out: EarningsRow[] = [];

  $('.m-quotes-calendar-list__item').each((_, item) => {
    const $item = $(item);
    const reportDate =
      isoFromBankierTimestamp($item.attr('data-timestamp')) ??
      parseBankierLongDate($item.find('.m-quotes-calendar-list__date').first().text());
    if (!reportDate) return;

    $item.find('.m-quotes-calendar-list__event').each((__, event) => {
      const $event = $(event);
      if (!isEarningsBadge($event.find('.a-quotes-badge .value').first().text())) return;

      const slug =
        $event.find('a.m-quotes-calendar-list__symbol').first().text().trim().toUpperCase() ||
        defaultSlug?.toUpperCase();
      if (!slug) return;

      const info = $event.find('.m-quotes-calendar-list__info').first().text();
      const { fiscalLabel, reportKind } = classifyBankierReport(info);

      out.push({
        market: 'PL',
        symbolKey: slug,
        reportDate,
        // Terminarz pochodzi z obowiązkowego raportu bieżącego spółki — to nie jest
        // szacunek ani konsensus analityków, tylko deklaracja emitenta.
        confidence: 'confirmed',
        // bankier nie podaje pory publikacji; raporty ESPI idą zwykle przed sesją
        // lub po jej zamknięciu — zmyślanie `bmo`/`amc` byłoby wprowadzaniem w błąd.
        session: null,
        fiscalLabel,
        reportKind,
        source: 'bankier',
        epsForecast: null,
      });
    });
  });

  return out;
}

export interface FetchBankierOptions {
  fetchFn?: typeof fetch;
  guard?: SourceGuard;
}

/**
 * Terminarz jednej spółki. `ok:false` oznacza „nie wiemy" (blokada/timeout/HTTP błąd)
 * i MUSI wstrzymać podmianę danych; `ok:true` z pustą listą to legalny stan
 * (spółka bez ogłoszonych przyszłych terminów).
 */
export async function fetchBankierCompany(
  slug: string,
  options: FetchBankierOptions = {},
): Promise<{ rows: EarningsRow[]; ok: boolean }> {
  const fetchFn = options.fetchFn ?? fetch;
  const guard = options.guard;

  if (guard?.isBlocked()) {
    console.warn(`[earnings/bankier] bezpiecznik otwarty — pomijam ${slug}`);
    return { rows: [], ok: false };
  }

  try {
    const resp = await fetchFn(bankierCompanyUrl(slug), {
      headers: { 'User-Agent': USER_AGENT, 'Cache-Control': 'no-cache' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const html = await resp.text().catch(() => '');

    if (detectEarningsSourceBlock(resp.status, html)) {
      guard?.registerBlock();
      console.warn(`[earnings/bankier] blokada anti-bot (HTTP ${resp.status}) dla ${slug}`);
      return { rows: [], ok: false };
    }
    // 404 = nieznany slug (zła nazwa spółki), a nie awaria źródła.
    if (resp.status === 404) return { rows: [], ok: true };
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const rows = parseBankierCalendar(html, slug);
    // Strona spółki ZAWSZE zawiera jakieś wpisy kalendarza (także historyczne),
    // więc zero rozpoznanych elementów listy to sygnał zmiany szablonu.
    if (guard) {
      if (!html.includes('m-quotes-calendar-list__item')) {
        guard.registerParseMiss('calendar:pl', { structural: true });
      } else {
        guard.registerSuccess('calendar:pl');
      }
    }
    return { rows, ok: true };
  } catch (err) {
    console.warn(`[earnings/bankier] nie udało się pobrać terminarza ${slug}:`, err);
    return { rows: [], ok: false };
  }
}
