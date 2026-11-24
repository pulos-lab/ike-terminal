import type { UpcomingDividend, UpcomingEarnings } from 'shared';
import { formatCurrency } from '@/lib/formatters';

/** Jak daleko w przód patrzy lista wydarzeń panelu. */
export const EVENTS_WINDOW_DAYS = 30;

export interface PortfolioEvent {
  key: string;
  kind: 'earnings' | 'ex-dividend' | 'dividend-payment';
  ticker: string;
  /** YYYY-MM-DD — data kalendarzowa rynku emitenta, bez konwersji stref. */
  date: string;
  daysUntil: number;
  /** „wyniki Q3 2026", „odcięcie dywidendy". */
  title: string;
  /** „po sesji", „ok. 410,00 zł" — dopisek do terminu; null gdy nie ma nic do dodania. */
  detail: string | null;
}

/** Różnica dni kalendarzowych między dwiema datami YYYY-MM-DD (UTC-północ, bez DST). */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : Number.NaN;
}

function earningsDetail(e: UpcomingEarnings): string | null {
  const parts: string[] = [];
  // Pora odnosi się do sesji RYNKU EMITENTA — jak `reportDate`.
  if (e.session === 'bmo') parts.push('przed sesją');
  if (e.session === 'amc') parts.push('po sesji');
  if (e.confidence === 'estimated') parts.push('termin szacowany');
  return parts.length > 0 ? parts.join(' · ') : null;
}

function dividendDetail(d: UpcomingDividend): string | null {
  const parts: string[] = [];
  if (d.estimatedAmount > 0) parts.push(`ok. ${formatCurrency(d.estimatedAmount, d.currency)}`);
  if (d.status === 'proponowana') parts.push('propozycja');
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Najbliższe wydarzenia dla posiadanych pozycji: publikacje wyników i dywidendy.
 *
 * - `today` jest wstrzykiwane (test nie czyta zegara; karta otwarta przez noc
 *   liczy dni od nowa przy każdym renderze),
 * - dywidenda daje JEDEN wiersz — najbliższy przyszły termin: odcięcie, a po
 *   odcięciu wypłata. Dwa wiersze na jedną dywidendę wypychałyby inne spółki,
 * - opcja i akcje na tę samą spółkę mają wspólny termin wyników → jeden wiersz.
 */
export function buildPortfolioEvents({
  earnings,
  dividends,
  today,
  windowDays = EVENTS_WINDOW_DAYS,
}: {
  earnings: UpcomingEarnings[];
  dividends: UpcomingDividend[];
  today: string;
  windowDays?: number;
}): PortfolioEvent[] {
  const events = new Map<string, PortfolioEvent>();
  const inWindow = (days: number) => Number.isFinite(days) && days >= 0 && days <= windowDays;

  for (const e of earnings) {
    const daysUntil = daysBetween(today, e.reportDate);
    if (!inWindow(daysUntil)) continue;
    const key = `earnings:${e.ticker}:${e.reportDate}`;
    if (events.has(key)) continue;
    events.set(key, {
      key,
      kind: 'earnings',
      ticker: e.ticker,
      date: e.reportDate,
      daysUntil,
      title: e.fiscalLabel ? `wyniki ${e.fiscalLabel}` : 'wyniki',
      detail: earningsDetail(e),
    });
  }

  for (const d of dividends) {
    const exIn = daysBetween(today, d.exDividendDate);
    const payIn = d.paymentDate ? daysBetween(today, d.paymentDate) : Number.NaN;
    const beforeEx = Number.isFinite(exIn) && exIn >= 0;
    const kind = beforeEx ? 'ex-dividend' : 'dividend-payment';
    const date = beforeEx ? d.exDividendDate : d.paymentDate;
    const daysUntil = beforeEx ? exIn : payIn;
    if (!date || !inWindow(daysUntil)) continue;
    const key = `${kind}:${d.ticker}:${date}`;
    if (events.has(key)) continue;
    events.set(key, {
      key,
      kind,
      ticker: d.ticker,
      date,
      daysUntil,
      title: beforeEx ? 'odcięcie dywidendy' : 'wypłata dywidendy',
      detail: dividendDetail(d),
    });
  }

  return [...events.values()].sort(
    (a, b) => a.daysUntil - b.daysUntil || a.ticker.localeCompare(b.ticker),
  );
}

const WEEKDAYS = ['niedz.', 'pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.'];

/** „dziś" / „jutro" / „czw. 26.11" — dzień tygodnia liczony z daty kalendarzowej (UTC). */
export function formatEventWhen(date: string, daysUntil: number): string {
  if (daysUntil <= 0) return 'dziś';
  if (daysUntil === 1) return 'jutro';
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return `${WEEKDAYS[parsed.getUTCDay()]} ${date.slice(8, 10)}.${date.slice(5, 7)}`;
}
