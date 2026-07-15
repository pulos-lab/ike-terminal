import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Izolowany cache w pamięci — realny price-cache to współdzielony NodeCache,
// który przeciekałby stanem między testami (i plikami).
const testCache = new Map<string, unknown>();
vi.mock('../price-cache.js', () => ({
  getCached: (key: string) => testCache.get(key),
  setCached: (key: string, value: unknown) => {
    testCache.set(key, value);
  },
}));

import {
  parseStockwatchBondsTable,
  detectStockwatchBlock,
  fetchStockwatchBondQuotes,
  fetchStockwatchBondPrice,
  resetStockwatchBondsStateForTests,
} from '../stockwatch-bonds.js';

/** Struktura wiersza 1:1 ze strony /obligacje/notowania/sektor/… (2026-07). */
const SECTOR_HTML = `<html><body><table>
<tr><th>Nazwa</th><th>Emitent</th><th>Segment</th><th>Data</th><th>Kurs ostatni</th><th>Kurs odniesienia</th></tr>
<tr> <td><strong><a href="/obligacje/emitent-prywatny/ghelamco/ghe0728">GHE0728</a></strong></td> <td><strong><a href="/obligacje/emitent-prywatny/ghelamco">Ghelamco Invest Sp. z o.o.</a></strong></td> <td class="c"><a href="/obligacje/notowania/segment/gpw-aso/">GPW ASO</a></td> <td class="c">2026-07-15</td> <td class="r">80,00</td> <td class="r">79,89</td> </tr>
<tr> <td><strong><a href="/obligacje/emitent/abpl/abe0227">ABE0227</a></strong></td> <td><strong><a href="/obligacje/emitent/abpl">AB SA</a></strong></td> <td class="c"><a href="/obligacje/notowania/segment/gpw-aso/">GPW ASO</a></td> <td class="c">brak</td> <td class="r">-</td> <td class="r">100,00</td> </tr>
<tr> <td>Nie-obligacja bez linku</td> <td>x</td> <td>x</td> <td>x</td> <td>x</td> <td>x</td> </tr>
</table></body></html>`;

const CHALLENGE_HTML = '<noscript>This site requires JavaScript to verify your browser.</noscript>';

function htmlResponse(html: string, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => html } as Response;
}

describe('parseStockwatchBondsTable', () => {
  it('parsuje wiersz z transakcją i wiersz bez transakcji; pomija nie-obligacje', () => {
    const quotes = parseStockwatchBondsTable(SECTOR_HTML);
    expect(quotes.size).toBe(2);
    expect(quotes.get('GHE0728')).toEqual({
      price: 80.0,
      referencePrice: 79.89,
      lastTradeDate: '2026-07-15',
    });
    // Seria bez transakcji: kurs null (silnik decyduje o fallbacku), odniesienie zostaje
    expect(quotes.get('ABE0227')).toEqual({
      price: null,
      referencePrice: 100.0,
      lastTradeDate: null,
    });
  });
});

describe('detectStockwatchBlock', () => {
  it('403/429/captcha/challenge → blokada; zwykła strona → nie', () => {
    expect(detectStockwatchBlock(403, '')).toBe(true);
    expect(detectStockwatchBlock(429, '')).toBe(true);
    expect(detectStockwatchBlock(200, CHALLENGE_HTML)).toBe(true);
    expect(detectStockwatchBlock(200, 'captcha please')).toBe(true);
    expect(detectStockwatchBlock(200, SECTOR_HTML)).toBe(false);
  });
});

describe('fetchStockwatchBondQuotes / fetchStockwatchBondPrice', () => {
  beforeEach(() => {
    testCache.clear();
    resetStockwatchBondsStateForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('scala sektory, cache po pierwszym przebiegu, lookup zdejmuje sufiks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(SECTOR_HTML));
    vi.stubGlobal('fetch', fetchMock);

    const quote = await fetchStockwatchBondPrice('GHE0728.WA');
    expect(quote).toEqual({ price: 80.0, referencePrice: 79.89, lastTradeDate: '2026-07-15' });
    expect(fetchMock).toHaveBeenCalledTimes(5); // 5 stron sektorowych

    // Drugi lookup — z cache, bez sieci
    await fetchStockwatchBondPrice('ABE0227');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('seria spoza tabel (wykupiona) → null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(htmlResponse(SECTOR_HTML)));
    expect(await fetchStockwatchBondPrice('BST0728')).toBeNull();
  });

  it('równoległe wywołania dzielą jeden przebieg fetchy (in-flight dedup)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(SECTOR_HTML));
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([
      fetchStockwatchBondPrice('GHE0728'),
      fetchStockwatchBondPrice('ABE0227'),
    ]);
    expect(a?.price).toBe(80.0);
    expect(b?.referencePrice).toBe(100.0);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('3 rundy blokad → bezpiecznik otwarty, brak sieci do wygaśnięcia backoffu', async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlResponse(CHALLENGE_HTML, 403));
    vi.stubGlobal('fetch', fetchMock);

    // Blokada przerywa rundę po pierwszej stronie — 3 rundy = 3 fetche = próg
    await fetchStockwatchBondQuotes();
    await fetchStockwatchBondQuotes();
    await fetchStockwatchBondQuotes();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // Bezpiecznik otwarty — kolejne wywołanie nie rusza sieci
    const quotes = await fetchStockwatchBondQuotes();
    expect(quotes.size).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('awaria sieci na jednym sektorze nie unieważnia pozostałych', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue(htmlResponse(SECTOR_HTML));
    vi.stubGlobal('fetch', fetchMock);

    const quotes = await fetchStockwatchBondQuotes();
    expect(quotes.get('GHE0728')?.price).toBe(80.0);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
