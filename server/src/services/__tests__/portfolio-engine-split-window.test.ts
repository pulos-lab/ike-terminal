/**
 * Reverse-split trzymanej spółki, której WSZYSTKIE transakcje są sprzed startu historii
 * cen providera, nie da się wykryć detekcją cenową (brak ceny providera na dacie tx).
 * Yahoo zwraca wtedy ceny SKORYGOWANE o (późniejszy) split → pozycja wyceniana N-krotnie
 * za wysoko od momentu pojawienia się notowań i skok na wykresie na granicy okna
 * (realny przypadek: import DEGIRO — Churchill/Lucid 1:10, Virgin Galactic 1:20).
 *
 * fetchSplitsForHeldTickers dociąga zdarzenia split z Yahoo WPROST dla trzymanych pozycji,
 * niezależnie od tego, czy detekcja cenowa cokolwiek zauważyła. Podwójne naliczenie wyklucza
 * `skipTickers` (papiery złapane heurystyką) i `skipIsins` (zapisane splity).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Transaction, TickerMapEntry } from 'shared';

vi.mock('../stooq.js', () => ({
  fetchStooqPrice: vi.fn().mockResolvedValue(null),
  fetchStooqPreviousClose: vi.fn().mockResolvedValue(null),
  fetchStooqHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../yahoo-finance.js', () => ({
  fetchYahooPrice: vi.fn().mockResolvedValue(null),
  fetchFxRate: vi.fn().mockResolvedValue(null),
  fetchYahooHistory: vi.fn().mockResolvedValue([]),
  fetchYahooHistoryDirect: vi.fn().mockResolvedValue(null),
  fetchYahooSplitEvents: vi.fn().mockResolvedValue([]),
}));
vi.mock('../biznesradar.js', () => ({
  fetchBiznesradarPrice: vi.fn().mockResolvedValue(null),
  fetchBiznesradarHistory: vi.fn().mockResolvedValue([]),
}));
vi.mock('../stockwatch-bonds.js', () => ({
  fetchStockwatchBondPrice: vi.fn().mockResolvedValue(null),
}));

import { fetchSplitsForHeldTickers, computePortfolioHistory } from '../portfolio-engine.js';
import * as yahoo from '../yahoo-finance.js';

function series(from: string, to: string, close: number): Array<{ date: string; close: number }> {
  const out: Array<{ date: string; close: number }> = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    out.push({ date: cur.toISOString().slice(0, 10), close });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function entry(over: Partial<TickerMapEntry> & { isin: string; ticker: string }): TickerMapEntry {
  return {
    name: over.ticker,
    exchange: 'NYSE',
    currency: 'USD',
    priceSource: 'yahoo',
    ...over,
  };
}

function buy(isin: string, date: string, qty = 10, price = 20): Transaction {
  return {
    date: date + 'T10:00:00',
    paperName: isin,
    isin,
    quantity: qty,
    side: 'K',
    price,
    value: qty * price,
    commission: 0,
    total: qty * price,
    currency: 'USD',
    category: 'stock',
  } as Transaction;
}

/** priceMap providera zaczynający się od `start` (jedna cena wystarczy do testu). */
function providerFrom(start: string, close = 227.9): Map<string, number> {
  return new Map([[start, close]]);
}

const LCID = entry({ isin: 'US1714391026', ticker: 'LCID' });
const REV_SPLIT = [{ date: '2025-09-02', ratio: 0.1 }]; // reverse 1:10

describe('fetchSplitsForHeldTickers', () => {
  it('dociąga split gdy transakcje są sprzed startu historii providera', async () => {
    const fetchEvents = vi.fn().mockResolvedValue(REV_SPLIT);
    const out = await fetchSplitsForHeldTickers(
      [buy('US1714391026', '2021-02-01', 85, 22)],
      new Map([['US1714391026', LCID]]),
      new Map([['LCID', providerFrom('2021-07-16')]]),
      { fetchEvents },
    );
    expect(fetchEvents).toHaveBeenCalledWith('LCID', '2021-02-01');
    expect(out).toEqual([
      expect.objectContaining({
        ticker: 'LCID',
        isin: 'US1714391026',
        date: '2025-09-02',
        ratio: 0.1,
      }),
    ]);
  });

  // ZMIANA ZACHOWANIA (2026-07-20): wcześniej ten test wymagał, żeby dla transakcji
  // W OKNIE providera NIE pytać Yahoo — przy założeniu „detekcja cenowa i tak zadziała".
  // Założenie okazało się fałszywe: detekcja porównuje cenę transakcji z kursem
  // ZAMKNIĘCIA przy tolerancji 5%, więc kupno śróddzienne odbiegające od zamknięcia
  // nie wykrywa niczego (realny przypadek EZRA — patrz test niżej). Yahoo jest
  // autorytatywne i cache'owane 12h, więc pytamy też dla pozycji w oknie.
  it('odpytuje TAKŻE gdy pierwsza transakcja jest w oknie providera', async () => {
    const fetchEvents = vi.fn().mockResolvedValue(REV_SPLIT);
    const out = await fetchSplitsForHeldTickers(
      [buy('US1714391026', '2021-08-01')],
      new Map([['US1714391026', LCID]]),
      new Map([['LCID', providerFrom('2021-07-16')]]),
      { fetchEvents },
    );
    expect(fetchEvents).toHaveBeenCalledWith('LCID', '2021-08-01');
    expect(out).toEqual([
      expect.objectContaining({ ticker: 'LCID', date: '2025-09-02', ratio: 0.1 }),
    ]);
  });

  // Regresja zgłoszenia 2026-07-20 (Reliance Global Group → EZRA, reverse split 1:40).
  // Kupno 0,2719 przy zamknięciu 0,252 (Yahoo oddaje 10,08 = skorygowane o split)
  // daje rawRatio 0,02697 — 7,9% od 1/40, czyli POZA tolerancją 5%. Heurystyka
  // milczy, więc jedyną drogą do zastosowania splitu jest ten proaktywny pass.
  it('łapie split, którego detekcja cenowa nie widzi (cena śróddzienna poza tolerancją)', async () => {
    const fetchEvents = vi.fn().mockResolvedValue([{ date: '2026-05-18', ratio: 1 / 40 }]);
    const EZRA = entry({ isin: 'RELI', ticker: 'EZRA', exchange: 'NASDAQ' });
    const out = await fetchSplitsForHeldTickers(
      [buy('RELI', '2026-02-09', 5.1, 0.2719)],
      new Map([['RELI', EZRA]]),
      new Map([['EZRA', new Map([['2026-02-09', 10.08]])]]),
      { fetchEvents },
    );
    expect(fetchEvents).toHaveBeenCalledWith('EZRA', '2026-02-09');
    expect(out).toEqual([
      expect.objectContaining({ ticker: 'EZRA', isin: 'RELI', date: '2026-05-18', ratio: 1 / 40 }),
    ]);
  });

  it('pomija ISIN z zapisanym splitem (skipIsins) i ticker już wykryty (skipTickers)', async () => {
    const fetchEvents = vi.fn().mockResolvedValue(REV_SPLIT);
    const args = [
      [buy('US1714391026', '2021-02-01')],
      new Map([['US1714391026', LCID]]),
      new Map([['LCID', providerFrom('2021-07-16')]]),
    ] as const;
    expect(
      await fetchSplitsForHeldTickers(...args, {
        fetchEvents,
        skipIsins: new Set(['US1714391026']),
      }),
    ).toEqual([]);
    expect(
      await fetchSplitsForHeldTickers(...args, { fetchEvents, skipTickers: new Set(['LCID']) }),
    ).toEqual([]);
    expect(fetchEvents).not.toHaveBeenCalled();
  });

  it('odrzuca ratio spoza skali splitu (np. 1,05 = dywidenda akcyjna)', async () => {
    const fetchEvents = vi.fn().mockResolvedValue([{ date: '2023-01-01', ratio: 1.05 }]);
    const out = await fetchSplitsForHeldTickers(
      [buy('US1714391026', '2021-02-01')],
      new Map([['US1714391026', LCID]]),
      new Map([['LCID', providerFrom('2021-07-16')]]),
      { fetchEvents },
    );
    expect(out).toEqual([]);
  });

  it('pomija gdy brak historii providera (pozycja i tak forward-fill po cenie tx)', async () => {
    const fetchEvents = vi.fn().mockResolvedValue(REV_SPLIT);
    const out = await fetchSplitsForHeldTickers(
      [buy('US1714391026', '2021-02-01')],
      new Map([['US1714391026', LCID]]),
      new Map(), // brak priceMap dla LCID
      { fetchEvents },
    );
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it('pomija NewConnect/Catalyst (nie ma ich na Yahoo)', async () => {
    const fetchEvents = vi.fn().mockResolvedValue(REV_SPLIT);
    const nc = entry({ isin: 'PLNC00000001', ticker: 'NCX', exchange: 'NC', currency: 'PLN' });
    const out = await fetchSplitsForHeldTickers(
      [buy('PLNC00000001', '2019-02-01')],
      new Map([['PLNC00000001', nc]]),
      new Map([['NCX', providerFrom('2021-07-16', 5)]]),
      { fetchEvents },
    );
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });
});

/**
 * End-to-end przez computePortfolioHistory — odtworzenie realnego skoku DEGIRO:
 * 85 szt. Churchill/Lucid kupione 2021-02-01 (sprzed startu serii LCID), Yahoo oddaje
 * serię SKORYGOWANĄ o reverse-split 1:10 (cena ~227,9 zamiast realnych ~22) startującą
 * 2021-07-16 oraz zdarzenie split 2025-09-02. Bez fixu wycena skacze na granicy okna
 * ~10× (85×227,9). Z fixem split zostaje zaaplikowany (85→8,5 szt.) → wartość poprawna.
 */
describe('computePortfolioHistory — skok DEGIRO na granicy okna (reverse-split sprzed okna)', () => {
  it('aplikuje reverse-split trzymanej spółki mimo transakcji sprzed startu historii', async () => {
    (yahoo.fetchYahooHistory as any).mockImplementation(async (ticker: string) => {
      if (ticker === 'LCID') return series('2021-07-16', '2026-12-31', 227.9); // skorygowana o split
      if (ticker === 'USDPLN=X') return series('2019-01-01', '2026-12-31', 4.0); // płaski kurs
      return [];
    });
    (yahoo.fetchYahooSplitEvents as any).mockImplementation(async (ticker: string) =>
      ticker === 'LCID' ? [{ date: '2025-09-02', ratio: 0.1 }] : [],
    );

    const tx: Transaction = {
      date: '2021-02-01T10:00:00',
      paperName: 'CHURCHILL CAPITAL CORP IV',
      isin: 'US1714391026',
      quantity: 85,
      side: 'K',
      price: 22,
      value: 85 * 22,
      commission: 0,
      total: 85 * 22,
      currency: 'USD',
      paymentCurrency: 'USD',
      category: 'stock',
      source: 'degiro',
    } as Transaction;

    const { history, detectedSplits } = await computePortfolioHistory(
      [tx],
      [],
      new Map([['US1714391026', LCID]]),
      '',
      'none',
      undefined,
      undefined,
      [],
      'PLN',
      [],
      undefined,
    );

    // Split z Yahoo został przeprowadzony przez cały łańcuch (wykryty mimo braku ceny na dacie tx).
    expect(detectedSplits).toContainEqual(
      expect.objectContaining({ isin: 'US1714391026', ratio: 0.1 }),
    );

    // Sedno: żaden punkt wykresu nie eksploduje. Bez fixu wartość akcji na granicy okna
    // to 85×227,9×4 ≈ 77 500 PLN; z fixem 8,5×227,9×4 ≈ 7 750 PLN, a że gotówka (−7 480)
    // równoważy koszt, |portfolioValue| trzyma się poniżej ~2 000 PLN przez całą serię.
    const maxAbs = Math.max(...history.map((h) => Math.abs(h.portfolioValue)));
    expect(maxAbs).toBeLessThan(3000);

    // Kontrola pozytywna: seria faktycznie obejmuje granicę okna (dane od 2021).
    expect(history.some((h) => h.date === '2021-07-16')).toBe(true);
  });

  it('NIE dubluje splitu, gdy detektor cenowy TEŻ go łapie (dokupienie w oknie)', async () => {
    (yahoo.fetchYahooHistory as any).mockImplementation(async (ticker: string) => {
      if (ticker === 'LCID') return series('2021-07-16', '2026-12-31', 227.9);
      if (ticker === 'USDPLN=X') return series('2019-01-01', '2026-12-31', 4.0);
      return [];
    });
    (yahoo.fetchYahooSplitEvents as any).mockImplementation(async (ticker: string) =>
      ticker === 'LCID' ? [{ date: '2025-09-02', ratio: 0.1 }] : [],
    );

    // Zakup sprzed okna (2021-02) + DOKUPIENIE w oknie (2022-01, cena 23 vs skorygowane 227,9
    // ≈ ratio 0,1) — to drugie odpala detektor cenowy. Proaktywny pass NIE może dorzucić
    // drugiej kopii tego samego splitu.
    const mk = (date: string, qty: number, price: number): Transaction =>
      ({
        date: date + 'T10:00:00',
        paperName: 'CHURCHILL/LUCID',
        isin: 'US1714391026',
        quantity: qty,
        side: 'K',
        price,
        value: qty * price,
        commission: 0,
        total: qty * price,
        currency: 'USD',
        paymentCurrency: 'USD',
        category: 'stock',
        source: 'degiro',
      }) as Transaction;

    const { history, detectedSplits } = await computePortfolioHistory(
      [mk('2021-02-01', 85, 22), mk('2022-01-03', 10, 23)],
      [],
      new Map([['US1714391026', LCID]]),
      '',
      'none',
      undefined,
      undefined,
      [],
      'PLN',
      [],
      undefined,
    );

    // DOKŁADNIE jeden split dla tej pozycji — merge dedupuje po isin|date, a skipTickers
    // w ogóle nie odpala proaktywnego passa dla tickera już rozwiązanego heurystyką.
    const lcidSplits = detectedSplits.filter((s) => s.isin === 'US1714391026');
    expect(lcidSplits).toHaveLength(1);
    expect(lcidSplits[0]).toEqual(expect.objectContaining({ date: '2025-09-02', ratio: 0.1 }));

    // Brak podwójnej korekty → wartość nadal poprawna (nie 0,85 szt. ani 950 szt.).
    const maxAbs = Math.max(...history.map((h) => Math.abs(h.portfolioValue)));
    expect(maxAbs).toBeLessThan(3000);
  });
});
