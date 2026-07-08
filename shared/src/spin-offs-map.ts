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
  // Synektik — wydzielenie działalności kardioznacznika (radiofarmaceutyk) do
  // Syn2bio S.A. Ostatnia sesja Z prawem: 2026-04-01; dzień referencyjny 04-07;
  // rejestracja akcji na rachunkach 04-15; debiut S2B na GPW ~04-16. Parytet 1:1.
  // BEZ parentIsin: portfele XTB mają pseudo-ISIN ('SNT.WA'), a lookup przy
  // zdefiniowanym parentIsin porównuje wyłącznie ISIN-y — dopasowanie po tickerze
  // działa dla wszystkich brokerów (resolver normalizuje do SNT.WA).
  {
    parentTicker: 'SNT.WA',
    childTicker: 'S2B.WA',
    childIsin: 'PLSNBIO00013',
    childName: 'Syn2bio S.A. (spin-off Synektik)',
    exDate: '2026-04-02',
    ratio: 1,
    source:
      'https://www.stockwatch.pl/wiadomosci/synektik-podzial-syn2bio-debiut-gpw-kwiecien-2026,akcje,369199',
    note: 'Podział Synektika: 1 akcja Syn2bio za 1 akcję Synektik; debiut S2B 2026-04-16',
  },
  // Creotech Instruments — wydzielenie segmentu technologii kwantowych do
  // Creotech Quantum S.A. (akcje serii B 1:1). Ostatnia sesja Z prawem:
  // 2026-04-02 (czwartek); 04-03 Wielki Piątek i 04-06 Poniedziałek Wielkanocny
  // to dni bez sesji, więc pierwsza sesja bez prawa = 2026-04-07. Dzień
  // referencyjny 04-08; debiut CRQ na GPW 2026-04-17.
  {
    parentTicker: 'CRI.WA',
    childTicker: 'CRQ.WA',
    childIsin: 'PLCTHQM00018',
    childName: 'Creotech Quantum S.A. (spin-off Creotech Instruments)',
    exDate: '2026-04-07',
    ratio: 1,
    source:
      'https://www.stockwatch.pl/wiadomosci/creotech-quantum-debiut-gpw-2026-podzial-creotech-instruments,akcje,369527',
    note: 'Podział Creotech Instruments: 1 akcja Creotech Quantum serii B za 1 akcję CRI',
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
