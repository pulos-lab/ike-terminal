/**
 * Mapa znanych spin-offów (wydzieleń spółek) — statyczna wiedza o rynku rozszerzana
 * ręcznymi PR-ami, analogicznie do `tender-offers-map.ts` i `ipo-subscriptions-map.ts`.
 * W Fazie 3 kandydaci są dodatkowo zasilani z globalnej tabeli `spinoff_events`
 * (scraper stockanalysis.com) — mapa pozostaje źródłem dla rynku polskiego (ESPI to
 * proza bez strukturalnego feedu) oraz sposobem na override'y.
 *
 * Semantyka: akcjonariusz spółki `parentTicker` posiadający akcje na koniec sesji
 * przed `exDate` otrzymuje `ratio` akcji `childTicker` za każdą akcję rodzica.
 * Akcje rodzica NIE są unicestwiane (klasyczny spin-off, nie podział przez wymianę).
 *
 * Zastosowanie zdarzenia do portfela wykonuje `spin-offs-applier.ts` automatycznie
 * przy liczeniu pozycji: tworzy pozycję dziecka i proporcjonalnie obniża koszt
 * nabycia rodzica (udział = wartość rynkowa dziecka / (rodzic + dziecko) w dniu ex,
 * zgodnie z zasadą proporcjonalnego rozdziału kosztu — art. 24 ust. 8 ustawy o PIT).
 * Zamrożony wynik ląduje w per-portfelowej tabeli `spin_offs`.
 */

export interface SpinOffMapEntry {
  /** Ticker Yahoo rodzica — jak w ticker_map (np. 'SPGI', 'SNT.WA'). */
  parentTicker: string;
  /** Opcjonalny ISIN rodzica — preferowany klucz dopasowania gdy znany. */
  parentIsin?: string;
  /** Ticker Yahoo spółki wydzielonej (np. 'MBGL'). */
  childTicker: string;
  /** ISIN dziecka jeśli znany; brak → applier użyje konwencji AUTO_<ticker>. */
  childIsin?: string;
  childName?: string;
  /** ISO YYYY-MM-DD — ex/distribution date (pierwsza sesja rodzica bez prawa). */
  exDate: string;
  /** Liczba akcji dziecka za 1 akcję rodzica (1 dla 1:1). */
  ratio: number;
  /**
   * Jawny udział kosztu przenoszony na dziecko (0..1). Gdy brak, applier liczy
   * udział z cen rynkowych w dniu ex. Ustaw gdy ceny są niedostępne/zwodnicze.
   */
  costAllocPct?: number;
  /** Link do komunikatu emitenta / ESPI dla weryfikacji. */
  source?: string;
  note?: string;
}

export const SPIN_OFF_MAP: SpinOffMapEntry[] = [
  // S&P Global — wydzielenie segmentu Mobility (Mobility Global Inc.), 1:1,
  // record date 2026-06-15, dystrybucja/pierwsza sesja MBGL 2026-07-01 (NYSE).
  {
    parentTicker: 'SPGI',
    parentIsin: 'US78409V1044',
    childTicker: 'MBGL',
    childName: 'Mobility Global Inc. (spin-off S&P Global)',
    exDate: '2026-07-01',
    ratio: 1,
    source:
      'https://www.stocktitan.net/news/MBGL/s-p-global-inc-completes-separation-of-mobility-global-5afoiq33kysk.html',
    note: 'S&P Global wydzielenie segmentu Mobility, dystrybucja 1:1',
  },
];

/**
 * Zwraca zdarzenia spin-off dla danego rodzica. Dopasowanie po ISIN (gdy wpis go
 * definiuje) lub po tickerze; ticker porównywany case-insensitive.
 */
export function lookupSpinOffsForParent(ticker: string, isin?: string): SpinOffMapEntry[] {
  const t = ticker.toUpperCase();
  return SPIN_OFF_MAP.filter((e) => {
    if (e.parentIsin && isin) return e.parentIsin === isin;
    return e.parentTicker.toUpperCase() === t;
  });
}
