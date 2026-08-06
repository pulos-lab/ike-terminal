/**
 * Czysta selekcja: które pozycje w ogóle mają terminarz i który wiersz kalendarza
 * dotyczy danej pozycji. Zero I/O — cała logika progów i filtrów jest tu, żeby
 * dała się przetestować bez bazy i bez sieci.
 */
import type { Position, UpcomingEarnings } from 'shared';
import { parseOccTicker, findBondByIsin } from 'shared';
import type { EarningsMarket, EarningsRow } from './earnings-store.js';

/** Ile dni przed publikacją UI zapala ikonę. */
export const EARNINGS_ALERT_DAYS = 7;

/** Jak daleko w przód w ogóle zbieramy dane (zapas pod przyszłą kartę „Kalendarz wyników"). */
export const EARNINGS_HORIZON_DAYS = 45;

/** Pozycja zakwalifikowana do szukania terminarza. */
export interface EarningsCandidate {
  /** ISIN pozycji — dla opcji pseudo-ISIN `OPT:{OCC}`. */
  isin: string;
  /** Ticker spółki RAPORTUJĄCEJ (dla opcji: bazowej). */
  ticker: string;
  /** Nazwa papieru — wejście do mapowania po nazwie dla spółek PL. */
  name: string | null;
  exchange: string | undefined;
  /** Kraj siedziby i waluta notowania — awaryjne rozpoznanie rynku, gdy giełda to `OTHER`. */
  country: string | null;
  currency: string | null;
  viaUnderlying: boolean;
}

/** Różnica w dniach kalendarzowych; arytmetyka na UTC-północy, bez stref lokalnych. */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.NaN;
  return Math.round((to - from) / 86_400_000);
}

/**
 * Które pozycje mają sens dla kalendarza wyników.
 *
 * Whitelist, nie blacklist: raport okresowy publikuje EMITENT AKCJI. ETF-y, obligacje
 * i CFD odpadają. Opcje zostają, bo publikacja spółki bazowej podbija zmienność i jest
 * kluczową informacją o ryzyku pozycji.
 *
 * UWAGA — celowa różnica względem `/dividends/upcoming`, które pomija `shares <= 0`:
 * tutaj pozycja KRÓTKA (wystawiona opcja, short) jest najbardziej wrażliwa na wyniki,
 * więc filtrujemy tylko pozycje zerowe.
 */
export function selectEarningsCandidates(positions: Position[]): EarningsCandidate[] {
  // Podpowiedzi rynku dla opcji — z pozycji akcyjnej o tym samym tickerze.
  const hintsByTicker = new Map<
    string,
    { exchange?: string; country: string | null; currency: string | null }
  >();
  for (const pos of positions) {
    if (pos.category === 'option') continue;
    hintsByTicker.set(pos.ticker.toUpperCase(), {
      exchange: pos.exchange,
      country: pos.country ?? null,
      currency: pos.currency ?? null,
    });
  }

  const out: EarningsCandidate[] = [];
  for (const pos of positions) {
    if (pos.shares === 0) continue;
    if (pos.exchange === 'CATALYST') continue;

    if (pos.category === 'option') {
      const underlying = pos.optionMeta?.underlying ?? parseOccTicker(pos.ticker)?.underlying;
      if (!underlying) continue;
      const key = underlying.toUpperCase();
      const hint = hintsByTicker.get(key);
      out.push({
        isin: pos.isin,
        ticker: key,
        name: null,
        // Kontrakty OCC są amerykańskie; nogi Eurex bez pozycji bazowej w portfelu
        // nie trafią w kalendarz Nasdaq i po prostu nie dostaną ikony.
        exchange: hint?.exchange ?? 'NASDAQ',
        country: hint?.country ?? null,
        currency: hint?.currency ?? 'USD',
        viaUnderlying: true,
      });
      continue;
    }

    const category = pos.category;
    if (category && category !== 'stock') continue;
    // `category` jest opcjonalne (starsze wpisy) — odrzucamy tylko to, co umiemy
    // rozpoznać jako obligację. Reszty NIE zawężamy po giełdzie: realnym filtrem
    // jest rozpoznanie rynku (`resolveEarningsMarket`), a lista dozwolonych giełd
    // gubiła zwykłe akcje z `exchange='OTHER'` — patrz komentarz tamże.
    if (!category && findBondByIsin(pos.isin)) continue;

    out.push({
      isin: pos.isin,
      ticker: pos.ticker.toUpperCase(),
      name: pos.paperName ?? null,
      exchange: pos.exchange,
      country: pos.country ?? null,
      currency: pos.currency ?? null,
      viaUnderlying: false,
    });
  }
  return out;
}

const CONFIDENCE_RANK: Record<string, number> = { confirmed: 3, tentative: 2, estimated: 1 };

/**
 * Najbliższa publikacja dla każdego kandydata. Przy dwóch wierszach na tę samą datę
 * (np. Nasdaq i Yahoo) wygrywa pewniejszy — inaczej gorsze źródło mogłoby zdegradować
 * potwierdzony termin do „szacowanego".
 */
export function buildUpcomingEarnings(
  candidates: Array<EarningsCandidate & { market: EarningsMarket; symbolKey: string }>,
  rows: EarningsRow[],
  todayIso: string,
): UpcomingEarnings[] {
  const byKey = new Map<string, EarningsRow[]>();
  for (const row of rows) {
    const key = `${row.market}|${row.symbolKey}`;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }

  const out: UpcomingEarnings[] = [];
  for (const candidate of candidates) {
    const list = byKey.get(`${candidate.market}|${candidate.symbolKey}`);
    if (!list?.length) continue;

    let best: EarningsRow | null = null;
    for (const row of list) {
      if (row.reportDate < todayIso) continue;
      if (
        !best ||
        row.reportDate < best.reportDate ||
        (row.reportDate === best.reportDate &&
          (CONFIDENCE_RANK[row.confidence] ?? 0) > (CONFIDENCE_RANK[best.confidence] ?? 0))
      ) {
        best = row;
      }
    }
    if (!best) continue;

    const daysUntil = daysBetweenIso(todayIso, best.reportDate);
    if (!Number.isFinite(daysUntil) || daysUntil > EARNINGS_HORIZON_DAYS) continue;

    out.push({
      isin: candidate.isin,
      ticker: candidate.ticker,
      reportDate: best.reportDate,
      daysUntil,
      confidence: best.confidence,
      session: best.session,
      fiscalLabel: best.fiscalLabel,
      reportKind: best.reportKind,
      source: best.source,
      ...(candidate.viaUnderlying ? { viaUnderlying: true } : {}),
    });
  }

  out.sort((a, b) => a.reportDate.localeCompare(b.reportDate) || a.ticker.localeCompare(b.ticker));
  return out;
}
