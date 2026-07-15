import { describe, it, expect, beforeEach } from 'vitest';
import { clearExtraBonds, isBondInstrument, findBondByTicker } from 'shared';
import { createBondCatalog, extractBondCandidates } from '../bond-catalog.js';

// Fikcyjny kod spoza statycznego BOND_MAP/overrides — warstwa on-demand ma sens tylko dla
// obligacji, których mapa NIE zna (BST0728 jest już statycznym override z Etapu 1, więc
// isBondInstrument('BST0728') = true i nigdy nie byłby kandydatem on-demand).
const FICT_TICKER = 'XYZ0728';
const FICT_ISIN = 'PLXYZ0000017';
const FICT_HTML = `
<tr><th>Emitent:</th><td><a href="/pl/emitent/x">Fikcyjny Emitent S.A.</a></td></tr>
<tr><th>ISIN:</th><td>${FICT_ISIN}</td></tr>
<tr><th>Wartość nominalna:</th><td>1 000.00 PLN</td></tr>
<tr><th>Typ oprocentowania:</th><td>zmienne WIBOR 3M + 4%</td></tr>
<h4>Dzień wykupu</h4><div><ul><li>2028-07-15</li></ul></div>
`;

/** Mock fetch obligacje.pl z licznikiem wywołań; brak strony → 404. */
function makeFetch(pages: Record<string, string>) {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    const u = String(url);
    const ticker = u.split('/').pop()!.toUpperCase();
    calls.push(ticker);
    const html = pages[ticker];
    if (html == null) return { ok: false, status: 404, text: async () => '' } as Response;
    return { ok: true, status: 200, text: async () => html } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('bond-catalog — resolve on-demand', () => {
  beforeEach(() => clearExtraBonds());

  it('pobiera detal, zapisuje do DB i rejestruje w runtime; DB-cache bez ponownego fetchu', async () => {
    const { fn, calls } = makeFetch({ [FICT_TICKER]: FICT_HTML });
    const catalog = createBondCatalog({ dbFile: ':memory:', fetchFn: fn });

    expect(isBondInstrument(FICT_TICKER, FICT_ISIN)).toBe(false); // nieznana na starcie

    const entry = await catalog.resolveBondOnDemand(FICT_TICKER);
    expect(entry?.nominal).toBe(1000);
    expect(entry?.isin).toBe(FICT_ISIN);
    expect(calls.length).toBe(1);
    // Zarejestrowana → klasyfikacja ją teraz widzi (ticker i ISIN)
    expect(isBondInstrument(FICT_TICKER)).toBe(true);
    expect(isBondInstrument('cokolwiek', FICT_ISIN)).toBe(true);
    expect(findBondByTicker(FICT_TICKER)?.nominal).toBe(1000);
    // Zapisana w DB
    expect(catalog.getStoredBonds().map((b) => b.ticker)).toContain(FICT_TICKER);

    // Usuń z rejestru runtime → kolejny resolve idzie z DB, BEZ nowego fetchu
    clearExtraBonds();
    expect(isBondInstrument(FICT_TICKER)).toBe(false);
    const again = await catalog.resolveBondOnDemand(FICT_TICKER);
    expect(again?.nominal).toBe(1000);
    expect(calls.length).toBe(1); // nadal jeden fetch
    expect(isBondInstrument(FICT_TICKER)).toBe(true); // ponownie zarejestrowana
  });

  it('miss (nie-obligacja) jest zapisany i nie re-fetchowany', async () => {
    const { fn, calls } = makeFetch({}); // wszystko 404
    const catalog = createBondCatalog({ dbFile: ':memory:', fetchFn: fn });

    expect(await catalog.resolveBondOnDemand('ZZZ9999')).toBeNull();
    expect(calls.length).toBe(1);
    // Drugi raz — miss-cache, brak kolejnego fetchu
    expect(await catalog.resolveBondOnDemand('ZZZ9999')).toBeNull();
    expect(calls.length).toBe(1);
  });

  it('ignoruje tokeny w złym kształcie (nie fetchuje)', async () => {
    const { fn, calls } = makeFetch({ [FICT_TICKER]: FICT_HTML });
    const catalog = createBondCatalog({ dbFile: ':memory:', fetchFn: fn });
    expect(await catalog.resolveBondOnDemand('KGHM')).toBeNull(); // brak 4 cyfr
    expect(await catalog.resolveBondOnDemand(FICT_ISIN)).toBeNull(); // ISIN, nie ticker
    expect(calls.length).toBe(0);
  });

  it('nie fetchuje obligacji już znanej statycznie (override/BOND_MAP)', async () => {
    const { fn, calls } = makeFetch({}); // gdyby fetchnął, dostałby 404
    const catalog = createBondCatalog({ dbFile: ':memory:', fetchFn: fn });
    // BST0728 = override z Etapu 1 → od razu zwrócone z mapy, bez sieci
    const entry = await catalog.resolveBondOnDemand('BST0728');
    expect(entry?.ticker).toBe('BST0728');
    expect(calls.length).toBe(0);
  });
});

describe('extractBondCandidates', () => {
  beforeEach(() => clearExtraBonds());

  it('wyłuskuje kody Catalyst spoza mapy, pomija znane i nie-obligacje', () => {
    const content = [
      'Data;Papier;ISIN;Ilosc',
      `2026-01-02;${FICT_TICKER};${FICT_ISIN};100`, // nieznana obligacja → kandydat
      '2026-01-03;DS1030;PL0000112736;10', // skarbowa (znana regexem) → pomiń
      '2026-01-04;BST0728;PLBEST000390;5', // override z Etapu 1 → pomiń
      '2026-01-05;CDR;PLOPTTC00011;5', // akcja → pomiń
    ].join('\n');
    const candidates = extractBondCandidates(content);
    expect(candidates).toContain(FICT_TICKER);
    expect(candidates).not.toContain('DS1030');
    expect(candidates).not.toContain('BST0728');
    expect(candidates).not.toContain('CDR');
  });

  it('rozwiązuje kandydatów z treści importu (pre-pass) i rejestruje', async () => {
    const { fn, calls } = makeFetch({ [FICT_TICKER]: FICT_HTML });
    const catalog = createBondCatalog({ dbFile: ':memory:', fetchFn: fn });
    const content = `2026-01-02;Wykup obligacji ${FICT_TICKER};${FICT_ISIN};kwota 10000`;
    const n = await catalog.resolveBondCandidatesFromContent([content]);
    expect(n).toBe(1);
    expect(calls).toEqual([FICT_TICKER]);
    expect(isBondInstrument(FICT_TICKER)).toBe(true);
  });
});
