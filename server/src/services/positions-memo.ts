/**
 * Memo dla buildPositionsView (widok Portfel + kafle metryk).
 *
 * `/positions` był jedynym ciężkim endpointem BEZ memoizacji: każde odpytanie
 * przeliczało pozycje od zera (FIFO po całej historii + wycena + salda), a
 * klient odpytywał co 15 min z każdej otwartej karty i przy każdym powrocie
 * focusa. Ceny i tak siedziały w cache'u, więc płaciliśmy głównie CPU za wynik
 * identyczny z poprzednim.
 *
 * RÓŻNICA WOBEC history-memo: klucz NIE zawiera dnia kalendarzowego. Pozycje
 * niosą cenę live, więc klucz dzienny zamroziłby kurs na dobę. Zamiast tego
 * wpis ma własne `expiresAt`, wyliczone z TTL notowań (stan rynku) — portfel
 * z pozycją w sesji odświeża się co 15 min, portfel czysto GPW po 17:00 co
 * kilka godzin.
 *
 * Unieważnienie natychmiastowe idzie przez `dataVersion` w kluczu: każdy zapis
 * transakcji/operacji/ticker_map bumpuje wersję, więc import i ręczna edycja są
 * widoczne od razu, bez czekania na TTL.
 */

import type { PortfolioPositionsResponse } from 'shared';
import { buildPositionsView } from './portfolio-views.js';
import { getPortfolioDataVersion } from '../db/data-version.js';
import { config } from '../config.js';

type BuildFn = typeof buildPositionsView;

interface MemoEntry {
  promise: Promise<PortfolioPositionsResponse>;
  expiresAt: number;
}

/**
 * Wpis to pojedynczy portfel (bez wariantów typu benchmark), więc limit może
 * być niższy niż w history-memo — a same wpisy są lekkie (lista pozycji).
 */
const MAX_MEMO_ENTRIES = 32;

const memo = new Map<string, MemoEntry>();

/** Wyczyść cały cache (testy / diagnostyka). */
export function clearPositionsMemo(): void {
  memo.clear();
}

/** Liczba wpisów — do diagnostyki adminowej. */
export function getPositionsMemoSize(): number {
  return memo.size;
}

function pruneExpired(nowMs: number): void {
  for (const [key, entry] of memo) {
    if (entry.expiresAt <= nowMs) memo.delete(key);
  }
}

/**
 * Zmemoizowany buildPositionsView.
 *
 * `buildFn` jest wstrzykiwalne wyłącznie dla testów (licznik wywołań) —
 * produkcyjne call sites nie przekazują tego parametru.
 */
export function buildPositionsViewMemoized(
  pid: string,
  buildFn: BuildFn = buildPositionsView,
): Promise<PortfolioPositionsResponse> {
  const nowMs = Date.now();
  const key = `v1|${pid}|${getPortfolioDataVersion(pid)}`;

  const cached = memo.get(key);
  if (cached && cached.expiresAt > nowMs) {
    // LRU touch — delete + set przenosi wpis na koniec iteracji Mapy
    memo.delete(key);
    memo.set(key, cached);
    return cached.promise;
  }

  const promise = buildFn(pid).catch((err) => {
    // Błędów nie cache'ujemy — kolejny request próbuje od nowa
    memo.delete(key);
    throw err;
  });

  // Wstępny TTL na czas liczenia: dopóki nie znamy stanu rynku, trzymamy krótko.
  // Równoległe requesty z jednego page-loadu i tak współdzielą ten Promise.
  memo.set(key, { promise, expiresAt: nowMs + config.cache.quoteTtl.regular * 1000 });

  // Po policzeniu ustawiamy realny TTL z odpowiedzi (min po stanach rynku
  // tickerów portfela) — serwer i klient dostają wtedy to samo tempo.
  void promise
    .then((result) => {
      const entry = memo.get(key);
      if (!entry || entry.promise !== promise) return;
      const next = result.quotes?.nextRefreshAt ? Date.parse(result.quotes.nextRefreshAt) : NaN;
      // Także gdy termin już minął — to znaczy „dane mogą się zmienić teraz",
      // więc wpis ma wygasnąć, a nie dożywać wstępnego TTL na nieświeżej cenie.
      if (Number.isFinite(next)) entry.expiresAt = next;
    })
    .catch(() => {
      /* obsłużone wyżej */
    });

  pruneExpired(nowMs);
  while (memo.size > MAX_MEMO_ENTRIES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined) break;
    memo.delete(oldest);
  }

  return promise;
}
