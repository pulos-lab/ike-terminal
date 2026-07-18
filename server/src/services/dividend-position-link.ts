/**
 * Łączenie rekordów dywidend z instrumentami (ISIN) + anotacja równowartości PLN.
 *
 * Ticker w rekordzie dywidendy pochodzi z różnych światów: skaner auto-yahoo
 * zapisuje ticker pozycji (SPGI, CSU.TO), a importy Bossa skrót GPW
 * (CREEPYJAR, GAMEOPS). Skrót GPW nie występuje w ticker_map, ale Bossa używa
 * IDENTYCZNEGO skrótu jako paper_name w transakcjach — stąd trzy mapy
 * dopasowania: ticker z ticker_map → paper_name z transakcji → nazwa z
 * ticker_map. Klucz niejednoznaczny (dwa ISIN-y po normalizacji) jest usuwany —
 * lepiej brak dopasowania niż błędne.
 */
import type { DividendRecord, TickerMapEntry, Transaction } from 'shared';
import type { FxToPlnLookup } from './fx-history.js';

/** Wspólna normalizacja kluczy: wielkie litery, tylko [A-Z0-9]. */
export function normalizeInstrumentKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Buduje mapę klucz→isin, usuwając klucze wskazujące na >1 ISIN. */
function unambiguousMap(pairs: Array<[string, string]>): Map<string, string> {
  const map = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [key, isin] of pairs) {
    if (!key) continue;
    const existing = map.get(key);
    if (existing && existing !== isin) {
      ambiguous.add(key);
      continue;
    }
    map.set(key, isin);
  }
  for (const key of ambiguous) map.delete(key);
  return map;
}

/** Resolver ticker-dywidendy → ISIN. Czyste lookupy w danych portfela, zero sieci. */
export function buildDividendIsinResolver(
  transactions: Pick<Transaction, 'paperName' | 'isin'>[],
  tickerMap: Map<string, TickerMapEntry>,
): (dividendTicker: string) => string | null {
  const entries = Array.from(tickerMap.values());
  const byTicker = unambiguousMap(
    entries.map((e) => [e.ticker.toUpperCase(), e.isin] as [string, string]),
  );
  const byPaperName = unambiguousMap(
    transactions.map((t) => [normalizeInstrumentKey(t.paperName), t.isin] as [string, string]),
  );
  const byMapName = unambiguousMap(
    entries.map((e) => [normalizeInstrumentKey(e.name), e.isin] as [string, string]),
  );

  return (dividendTicker: string): string | null => {
    const raw = dividendTicker.trim().toUpperCase();
    if (!raw) return null;
    const norm = normalizeInstrumentKey(raw);
    return byTicker.get(raw) ?? byPaperName.get(norm) ?? byMapName.get(norm) ?? null;
  };
}

/**
 * Dopisuje do rekordów `amountPln` (kurs z dnia wypłaty — ta sama konwencja co
 * suma „Suma dywidend") i `isin` (resolver wyżej). Zwraca NOWE obiekty.
 */
export function annotateDividendRecords(
  dividends: DividendRecord[],
  fx: FxToPlnLookup,
  resolveIsin: (dividendTicker: string) => string | null,
): DividendRecord[] {
  return dividends.map((d) => {
    const rate = fx(d.currency, d.date);
    return {
      ...d,
      amountPln: rate != null ? Math.round(d.amount * rate * 100) / 100 : null,
      isin: resolveIsin(d.ticker),
    };
  });
}
