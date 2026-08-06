import type { Transaction, TickerMapEntry, DetectedSplit } from 'shared';

/** Maximum tolerance when matching a raw ratio to a known split ratio (5%) */
const RATIO_TOLERANCE = 0.05;

/**
 * Tolerancja korroboracji ceną dla splitu wykrytego z niedopasowania ilości: cena
 * sprzedaży (post-split) × ratio ≤ średnia cena kupna (pre-split) × ta stała. 2× dopuszcza
 * ruch rynku między splitem a sprzedażą; wyklucza krótkie sprzedaże (cena ≈ rynkowa, bez zawału).
 */
const SPLIT_PRICE_TOLERANCE = 2;

/**
 * Known real-world stock split ratios (forward and reverse).
 * The smallest possible split is 2:1 (forward) or 1:2 (reverse),
 * so any ratio between 0.53 and 1.9 is definitely NOT a split.
 */
const KNOWN_SPLIT_RATIOS = [
  // Forward splits (ratio >= 2)
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  10,
  15,
  20,
  25,
  50,
  100,
  // Reverse splits (ratio <= 0.5)
  1 / 2,
  1 / 3,
  1 / 4,
  1 / 5,
  1 / 6,
  1 / 8,
  1 / 10,
  1 / 15,
  1 / 20,
  1 / 25,
  1 / 30,
  // 1/40 — reverse split EZRA (Reliance Global Group) z 2026-05-18. Bez tego
  // wpisu split był NIEWYKRYWALNY: przy RATIO_TOLERANCE = 0.05 najbliższe znane
  // 1/50 leży 20% obok, więc heurystyka nie odpalała, a skoro nie odpalała, to
  // `resolveSplitEventDates` w ogóle nie pytało Yahoo o eventy.
  1 / 40,
  1 / 50,
  1 / 100,
];

/**
 * Check if a detected ratio is close to a known stock split ratio.
 *
 * The minimum real split is 2:1 (forward) or 1:2 (reverse), so any price
 * discrepancy under 2x is guaranteed to be a normal price movement, not a split.
 * This eliminates false positives from crashes (-40%, -60%) and rallies (+80%, +150%).
 */
export function isPlausibleSplitRatio(ratio: number): boolean {
  // Quick reject: anything between 0.53 and 1.9 can't be a split
  // (smallest split is 2:1 forward or 1:2 reverse, with 5% tolerance)
  if (ratio > 0.5 * (1 + RATIO_TOLERANCE) && ratio < 2 * (1 - RATIO_TOLERANCE)) {
    return false;
  }
  return KNOWN_SPLIT_RATIOS.some((known) => Math.abs(ratio / known - 1) < RATIO_TOLERANCE);
}

/**
 * Snap a raw ratio to the nearest known split ratio.
 * E.g. 9.85 → 10, 0.198 → 0.2 (1/5)
 */
export function snapToKnownRatio(ratio: number): number {
  let best = ratio;
  let bestDist = Infinity;
  for (const known of KNOWN_SPLIT_RATIOS) {
    const dist = Math.abs(ratio / known - 1);
    if (dist < bestDist) {
      bestDist = dist;
      best = known;
    }
  }
  return best;
}

/**
 * Detect stock splits by comparing transaction prices with provider (Yahoo/Stooq) prices.
 *
 * Providers return split-adjusted prices, so a pre-split transaction at 1070 will show
 * a provider price of 107 after a 10:1 split. We detect the ratio per transaction date
 * and can handle multiple splits over time for the same ticker.
 *
 * Only compares when tx currency matches ticker currency (avoids FX false positives).
 */
export function detectSplits(
  transactions: Transaction[],
  historicalPrices: Map<string, Map<string, number>>,
  tickerMap: Map<string, TickerMapEntry>,
): DetectedSplit[] {
  const splits: DetectedSplit[] = [];
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));

  // Instrumenty, na których NIGDY nie było pozycji długiej (czysty trading krótki) —
  // split ich nie dotyczy. Bez tego realny split spółki (np. SMCI 10:1), wykryty z ceny
  // providera (skorygowanej) vs cena transakcji short, był datowany na transakcję short
  // i mnożył ją N-krotnie → widmowa pozycja i gigantyczny skok wyceny na wykresie.
  const everLong = new Set<string>();
  {
    const net = new Map<string, number>();
    for (const tx of sorted) {
      const n = (net.get(tx.isin) ?? 0) + (tx.side === 'K' ? tx.quantity : -tx.quantity);
      net.set(tx.isin, n);
      if (n > 1e-9) everLong.add(tx.isin);
    }
  }

  // Track cumulative scaling already applied per ticker so we can detect subsequent splits
  const cumulativeRatio = new Map<string, number>();

  for (const tx of sorted) {
    const entry = tickerMap.get(tx.isin);
    if (!entry) continue;
    // Pomijamy instrumenty tradowane wyłącznie krótko (patrz everLong wyżej).
    if (!everLong.has(tx.isin)) continue;

    // Obligacje nie mają splitów (kursy tx i providera są w tej samej skali % nominału,
    // więc ratio ≈ 1 — guard jest defensywny, bez ryzyka fałszywych wykryć).
    // Opcje: od kiedy wyceniamy je wartością wewnętrzną, mapa cen OCC jest wypełniona
    // (intrinsic vs premia tx dałoby fałszywe ratio) — pomijamy.
    if (tx.category === 'bond' || tx.category === 'option') continue;

    // Skip if currencies don't match (FX difference, not split)
    // Normalize: GBX/GBp/GBP are all equivalent for comparison
    const txCurNorm = tx.currency.toUpperCase() === 'GBX' ? 'GBP' : tx.currency.toUpperCase();
    const entryCurNorm =
      entry.currency.toUpperCase() === 'GBX' ? 'GBP' : entry.currency.toUpperCase();
    if (txCurNorm !== entryCurNorm) continue;

    const dateKey = tx.date.split('T')[0];
    const priceMap = historicalPrices.get(entry.ticker);
    if (!priceMap) continue;

    let providerPrice = priceMap.get(dateKey);
    if (!providerPrice || providerPrice <= 0) continue;

    // Yahoo returns London-listed prices in GBX (pence) — convert to GBP for comparison
    if (txCurNorm === 'GBP' && entry.ticker.endsWith('.L')) {
      providerPrice = providerPrice / 100;
    }

    const currentRatio = cumulativeRatio.get(entry.ticker) ?? 1;

    // Transakcja zgodna z surową (nieskalowaną) ceną providera = obserwacja
    // PO splicie. Bez tego resetu porównanie ze skalowaną ceną dawałoby
    // rawRatio ≈ 1/currentRatio i fałszywy "reverse split" dla każdego
    // zakupu zrobionego już po splicie.
    if (currentRatio !== 1 && !isPlausibleSplitRatio(tx.price / providerPrice)) {
      cumulativeRatio.set(entry.ticker, 1);
      continue;
    }

    // Apply any already-detected scaling for this ticker to compare fairly
    const scaledProviderPrice = providerPrice * currentRatio;
    const rawRatio = tx.price / scaledProviderPrice;

    // Only accept ratios matching known splits (>=2x or <=0.5x).
    // Any discrepancy under 2x is a normal price movement, not a split.
    if (isPlausibleSplitRatio(rawRatio)) {
      const snappedRatio = snapToKnownRatio(rawRatio);
      splits.push({
        ticker: entry.ticker,
        isin: tx.isin,
        // Data transakcji = dolne ograniczenie daty splitu (split zaszedł PO niej,
        // bo provider pokazuje już skorygowaną cenę). Realną datę nadaje
        // resolveSplitEventDates (Yahoo split events) w portfolio-engine.
        date: dateKey,
        ratio: snappedRatio,
        txPrice: tx.price,
        providerPrice: scaledProviderPrice,
        source: 'auto',
      });
      cumulativeRatio.set(entry.ticker, currentRatio * snappedRatio);
    } else if (rawRatio >= 3 || (rawRatio > 0 && rawRatio <= 1 / 3)) {
      // Ratio spoza listy „znanych", ale skala ≥3× (nietypowy split, np. 1:12 Paysafe,
      // 12:1, 1:7). Próg 3× wyklucza typowe rajdy/krachy (+130% = 0.43, −60% = 2.5).
      // Nie ufamy na słowo — zgłaszamy jako KANDYDATA do potwierdzenia zdarzeniem split
      // z Yahoo; bez potwierdzenia zostanie odrzucony w resolveSplitEventDates.
      splits.push({
        ticker: entry.ticker,
        isin: tx.isin,
        date: dateKey,
        ratio: rawRatio,
        txPrice: tx.price,
        providerPrice: scaledProviderPrice,
        source: 'auto',
        needsConfirmation: true,
      });
      cumulativeRatio.set(entry.ticker, currentRatio * rawRatio);
    }
  }

  return splits;
}

// ── Splity z NIESKORYGOWANEJ serii providera ────────────────────────────────
//
// GENEZA (zgłoszenie użytkownika 2026-08-06): Invesco S&P 500 UCITS ETF (P500.DE)
// zrobił split 100:1 dnia 2025-12-15. Yahoo tego splitu NIE MA — ani jako zdarzenia
// (`events` puste na całym oknie), ani w postaci korekty historii (`adjclose == close`,
// w serii siedzi surowy skok 1157,40 → 11,57). Cała dotychczasowa detekcja zakłada
// serię SKORYGOWANĄ: porównuje cenę transakcji z ceną providera z DNIA transakcji.
// Przy serii surowej obie strony są w tej samej (starej) skali, więc ratio ≈ 1 i nic
// się nie wykrywa — a pozycja jest wyceniana 100× za nisko.
//
// Detekcja idzie więc z samej serii: split zostawia w niej skok z dnia na dzień.
// Progi są ostrzejsze niż w detekcji transakcyjnej, bo tu NIE MA czym potwierdzić
// wykrycia — Yahoo nie zna zdarzenia z definicji (gdyby znał, seria byłaby skorygowana).

/** Minimalna skala skoku w serii. 10× w jedną sesję to nie jest ruch rynku — a przy
 *  progu 2× (jak w detekcji transakcyjnej) każdy krach −50% stałby się „splitem 2:1". */
const SERIES_MIN_RATIO = 10;

/** Snap do znanego ratio musi być ciasny (2% zamiast 5%): realny split daje niemal
 *  dokładną wielokrotność (100,03 dla P500.DE), krach — dowolną liczbę. */
const SERIES_SNAP_TOLERANCE = 0.02;

/** Maksymalna przerwa między sąsiednimi punktami serii. Skok przez trzymiesięczną
 *  dziurę w danych to nie jest zdarzenie jednodniowe i nie wolno go tak czytać. */
const SERIES_MAX_GAP_DAYS = 7;

/** Ile punktów PO KAŻDEJ STRONIE skoku musi trzymać swój poziom, żeby wykluczyć
 *  błędny print. Symetria jest konieczna: przy sprawdzaniu tylko „w przód" zła cena
 *  10,1 wstawiona w serię ~1000 daje wprawdzie odrzucenie skoku w dół (poziom się nie
 *  utrzymuje), ale POWRÓT do 1000 wygląda jak stabilny reverse split 1:100. */
const SERIES_PERSISTENCE_POINTS = 2;

/** Ile razy cena po skoku może się różnić od poziomu tuż po nim, żeby uznać poziom
 *  za utrzymany. Luźno (2×), bo chodzi o wykluczenie powrotu do STAREJ skali (10×+). */
const SERIES_PERSISTENCE_FACTOR = 2;

/** Skok w serii wyglądający na split: `date` = pierwszy dzień w nowej skali (ex-date). */
export interface SeriesSplitJump {
  date: string;
  ratio: number;
  /** Surowy iloraz przed zaokrągleniem do znanego ratio — do diagnostyki. */
  rawRatio: number;
  priceBefore: number;
  priceAfter: number;
}

/** Czy wszystkie punkty trzymają się poziomu `level` (z luzem SERIES_PERSISTENCE_FACTOR)? */
function levelHolds(points: Array<[string, number]>, level: number): boolean {
  return points.every(
    ([, p]) => p <= level * SERIES_PERSISTENCE_FACTOR && p >= level / SERIES_PERSISTENCE_FACTOR,
  );
}

function daysBetweenIso(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/**
 * Znajdź w serii skoki, które wyglądają na split (a nie na ruch rynku).
 *
 * Seria SKORYGOWANA przez providera takich skoków nie ma z definicji — więc ta
 * funkcja z natury odpala się tylko na danych, których provider nie poprawił.
 */
export function findSeriesSplitJumps(priceMap: Map<string, number>): SeriesSplitJump[] {
  const points = [...priceMap.entries()]
    .filter(([, price]) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const jumps: SeriesSplitJump[] = [];
  for (let i = 1; i < points.length; i++) {
    const [prevDate, prevPrice] = points[i - 1];
    const [date, price] = points[i];

    if (daysBetweenIso(prevDate, date) > SERIES_MAX_GAP_DAYS) continue;

    const rawRatio = prevPrice / price;
    if (rawRatio < SERIES_MIN_RATIO && rawRatio > 1 / SERIES_MIN_RATIO) continue;

    const ratio = snapToKnownRatio(rawRatio);
    if (Math.abs(rawRatio / ratio - 1) >= SERIES_SNAP_TOLERANCE) continue;

    // Oba poziomy — stary i nowy — muszą się utrzymać. Inaczej to był błędny print.
    const before = points.slice(Math.max(0, i - 1 - SERIES_PERSISTENCE_POINTS), i);
    const after = points.slice(i, i + 1 + SERIES_PERSISTENCE_POINTS);
    if (before.length < 1 + SERIES_PERSISTENCE_POINTS) continue;
    if (after.length < 1 + SERIES_PERSISTENCE_POINTS) continue;
    if (!levelHolds(before, prevPrice) || !levelHolds(after, price)) continue;

    jumps.push({ date, ratio, rawRatio, priceBefore: prevPrice, priceAfter: price });
  }
  return jumps;
}

/**
 * Wykryj splity ze skoków w serii providera — uzupełnienie `detectSplits` dla danych,
 * których provider nie skorygował (patrz nagłówek sekcji, przypadek P500.DE).
 *
 * WAŻNE: zwróconych splitów NIE WOLNO przepuszczać przez `resolveSplitEventDates`.
 * Tamten fallback („brak zdarzenia w Yahoo → data transakcji +1 dzień") istnieje dla
 * detekcji, która zna tylko dolne ograniczenie daty. Tu data jest DOKŁADNA — to
 * pierwszy dzień notowań w nowej skali, odczytany wprost z serii.
 */
export function detectSplitsFromPriceSeries(
  transactions: Transaction[],
  historicalPrices: Map<string, Map<string, number>>,
  tickerMap: Map<string, TickerMapEntry>,
): DetectedSplit[] {
  const splits: DetectedSplit[] = [];
  const seenIsins = new Set<string>();

  for (const tx of transactions) {
    if (seenIsins.has(tx.isin)) continue;
    // Te same wykluczenia co w detekcji cenowej: obligacje kwotowane w % nominału
    // i opcje wyceniane wartością wewnętrzną potrafią skakać bez żadnego splitu.
    if (tx.category === 'bond' || tx.category === 'option') continue;
    seenIsins.add(tx.isin);

    const entry = tickerMap.get(tx.isin);
    if (!entry) continue;
    const priceMap = historicalPrices.get(entry.ticker);
    if (!priceMap) continue;

    for (const jump of findSeriesSplitJumps(priceMap)) {
      splits.push({
        ticker: entry.ticker,
        isin: tx.isin,
        date: jump.date,
        ratio: jump.ratio,
        txPrice: jump.priceBefore,
        providerPrice: jump.priceAfter,
        source: 'auto',
      });
    }
  }

  return splits;
}

/**
 * Dokończ za providera korektę serii, w której split nie został uwzględniony.
 *
 * Dlaczego to jest potrzebne mimo `adjustTransactionsForSplits`: tamta funkcja
 * sprowadza transakcje sprzed splitu do skali PO splicie (ilość ×ratio, cena /ratio).
 * Przy serii skorygowanej to wystarcza — obie strony są wtedy w tej samej skali.
 * Przy serii SUROWEJ odcinek sprzed ex-date zostaje w starej skali, więc wycena
 * historyczna rozjechałaby się o `ratio` w drugą stronę (dla P500.DE: 100× za wysoko).
 *
 * Rozpoznanie „seria jest surowa" liczymy NA ŻYWO z danych, zamiast utrwalać flagę
 * przy splicie: dowodem jest obecność skoku w serii. Gdy provider kiedyś poprawi swoje
 * dane, skok zniknie i normalizacja sama przestanie się stosować — bez migracji.
 *
 * Mutuje mapy w miejsce (jak `rescaleHistoricalPrices`); w silniku są to świeże mapy
 * budowane per wywołanie, więc cache cen nie jest tym dotykany.
 *
 * @returns splity, dla których faktycznie znormalizowano serię (diagnostyka/log)
 */
export function normalizeUnadjustedProviderSeries(
  historicalPrices: Map<string, Map<string, number>>,
  splits: DetectedSplit[],
): DetectedSplit[] {
  const applied: DetectedSplit[] = [];

  const byTicker = new Map<string, DetectedSplit[]>();
  for (const split of splits) {
    const arr = byTicker.get(split.ticker) || [];
    arr.push(split);
    byTicker.set(split.ticker, arr);
  }

  for (const [ticker, tickerSplits] of byTicker) {
    const priceMap = historicalPrices.get(ticker);
    if (!priceMap) continue;

    // Werdykty liczymy PRZED jakąkolwiek mutacją — inaczej normalizacja pierwszego
    // splitu zmieniałaby dane, na których badamy kolejny.
    const jumps = findSeriesSplitJumps(priceMap);
    const unadjusted = tickerSplits.filter((split) =>
      jumps.some(
        (j) => j.date === split.date && Math.abs(j.ratio / split.ratio - 1) < SERIES_SNAP_TOLERANCE,
      ),
    );
    if (unadjusted.length === 0) continue;

    for (const split of unadjusted) {
      for (const [date, price] of priceMap) {
        // Ostre `<` — ex-date to pierwszy dzień w NOWEJ skali, więc jego cena
        // jest już poprawna. Ta sama granica co w `adjustTransactionsForSplits`.
        if (date < split.date) priceMap.set(date, price / split.ratio);
      }
      applied.push(split);
    }
  }

  return applied;
}

/**
 * Rescale all historical provider prices to match the actual transaction price scale.
 *
 * After rescaling, the price history is consistent with original (non-adjusted) transaction
 * prices. This is needed because providers return split-adjusted prices that differ from
 * what the user actually paid.
 *
 * Splits are applied cumulatively: if a ticker had a 10:1 split and then a 2:1 split,
 * prices before the first split get rescaled by 20x total.
 */
export function rescaleHistoricalPrices(
  historicalPrices: Map<string, Map<string, number>>,
  splits: DetectedSplit[],
): void {
  // Group splits by ticker, sorted chronologically
  const splitsByTicker = new Map<string, DetectedSplit[]>();
  for (const split of splits) {
    const arr = splitsByTicker.get(split.ticker) || [];
    arr.push(split);
    splitsByTicker.set(split.ticker, arr);
  }

  for (const [ticker, tickerSplits] of splitsByTicker) {
    const priceMap = historicalPrices.get(ticker);
    if (!priceMap) continue;

    const sortedSplits = [...tickerSplits].sort((a, b) => a.date.localeCompare(b.date));

    // Compute the total cumulative ratio (product of all split ratios)
    const totalRatio = sortedSplits.reduce((acc, s) => acc * s.ratio, 1);

    // Rescale all prices by the total cumulative ratio
    for (const [date, price] of priceMap) {
      priceMap.set(date, price * totalRatio);
    }
  }
}

/**
 * Create adjusted copies of transactions to account for stock splits.
 *
 * For transactions that occurred BEFORE a split date:
 * - quantity is multiplied by the split ratio
 * - price is divided by the split ratio
 * - value remains unchanged (quantity * price = const)
 *
 * This ensures FIFO calculations work correctly with post-split share counts.
 */
export function adjustTransactionsForSplits(
  transactions: Transaction[],
  splits: DetectedSplit[],
): Transaction[] {
  if (splits.length === 0) return transactions;

  // Group splits by ISIN, sorted chronologically
  const splitsByIsin = new Map<string, DetectedSplit[]>();
  for (const split of splits) {
    const arr = splitsByIsin.get(split.isin) || [];
    arr.push(split);
    splitsByIsin.set(split.isin, arr);
  }

  return transactions.map((tx) => {
    const isinSplits = splitsByIsin.get(tx.isin);
    if (!isinSplits) return tx;

    const txDate = tx.date.split('T')[0];

    // Cumulative ratio ze splitów, które zaszły ŚCIŚLE PO dacie transakcji.
    // split.date to ex-date — pierwszy dzień handlu w skali post-split, więc
    // transakcja z tego dnia jest już post-split i NIE podlega korekcie.
    // Inkluzywne >= podwójnie korygowałoby zakupy zrobione po splicie.
    let ratio = 1;
    for (const split of isinSplits) {
      if (split.date > txDate) {
        ratio *= split.ratio;
      }
    }

    if (ratio === 1) return tx;

    return {
      ...tx,
      quantity: tx.quantity * ratio,
      price: tx.price / ratio,
      // value stays the same (quantity * price is unchanged)
    };
  });
}

/**
 * Detect a split by noticing that a sell quantity exceeds accumulated buy quantity.
 * This is a strong signal — if you bought 10 shares and try to sell 50, a split
 * must have happened in between.
 *
 * Only works when there's been a sell after the split.
 */
export function detectSplitFromQuantityMismatch(
  transactions: Transaction[],
): Array<{ isin: string; date: string; ratio: number }> {
  // Group by ISIN
  const byIsin = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const arr = byIsin.get(tx.isin) || [];
    arr.push(tx);
    byIsin.set(tx.isin, arr);
  }

  const results: Array<{ isin: string; date: string; ratio: number }> = [];

  for (const [isin, txs] of byIsin) {
    // Obligacje i opcje nie mają splitów w tym sensie — pomijamy całą grupę.
    if (txs[0]?.category === 'bond' || txs[0]?.category === 'option') continue;
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    let accumulated = 0;
    let accCost = 0; // wartość nabycia posiadanych akcji — do średniej ceny

    for (const tx of sorted) {
      if (tx.side === 'K') {
        accumulated += tx.quantity;
        accCost += tx.quantity * tx.price;
      } else {
        if (accumulated > 0 && tx.quantity > accumulated * 1.5) {
          const rawRatio = tx.quantity / accumulated;
          const avgBuyPrice = accCost / accumulated;
          // Korroboracja ceną: realny split N:1 zawala cenę ~N-krotnie, więc cena
          // sprzedaży powinna być ~avgBuyPrice/ratio. Krótka sprzedaż (sprzedaję więcej
          // niż mam) ma cenę ~rynkową ≈ avgBuyPrice — BEZ zawału. Bez tego warunku
          // short + odkup był błędnie księgowany jako split (sprzedaż 100 SPOT przy 5
          // posiadanych → fałszywy split 20:1). Tolerancja 2× na ruch rynku.
          const looksLikeSplit =
            avgBuyPrice > 0 && tx.price * rawRatio <= avgBuyPrice * SPLIT_PRICE_TOLERANCE;
          if (isPlausibleSplitRatio(rawRatio) && looksLikeSplit) {
            const ratio = snapToKnownRatio(rawRatio);
            results.push({ isin, date: tx.date.split('T')[0], ratio });
            // Adjust accumulated as if split happened (koszt bez zmian → avg /ratio).
            accumulated = accumulated * ratio;
          }
        }
        const avgBuyPrice = accumulated > 0 ? accCost / accumulated : 0;
        accumulated = Math.max(0, accumulated - tx.quantity);
        accCost = avgBuyPrice * accumulated; // proporcjonalna redukcja (avg bez zmian)
      }
    }
  }

  return results;
}
