import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseBrCatalog, createBrCatalogService, searchNcStatic } from '../biznesradar-catalog.js';

// ── Payload testowy ─────────────────────────────────────────────────────────
// Realne kształty wpisów z service-data-short-js/1 (2026-07-16). MIN_PLAUSIBLE
// wymaga ≥500 wpisów BDM — dopełniamy syntetycznymi spółkami.

const INTERESTING = [
  // NC (jest w NC_TICKER_MAP)
  {
    i: 5716,
    s: 'AIT',
    f: 'AITON CALDWELL SPÓŁKA AKCYJNA',
    m: 'AITON',
    d: 'AIT (AITON)',
    u: 'AITON-CALDWELL',
    c: 0.234,
    o: 'BDM',
    r: null,
    q: 3,
  },
  // GPW (brak w NC_TICKER_MAP)
  {
    i: 133,
    s: 'KGH',
    f: 'KGHM POLSKA MIEDŹ SPÓŁKA AKCYJNA',
    m: 'KGHM',
    d: 'KGH (KGHM)',
    u: 'KGHM',
    c: 303,
    o: 'BDM',
    r: 'PLN',
    q: 2,
  },
  // GPW delistowana — celowo zostaje w katalogu
  {
    i: 125,
    s: 'GTN',
    f: 'GETIN HOLDING SPÓŁKA AKCYJNA',
    m: 'GETIN',
    d: 'GTN (GETIN)',
    u: 'GETIN-HOLDING',
    c: 0.368,
    o: 'BDM',
    r: 'PLN',
    q: 4,
  },
  // Śmieci do odfiltrowania:
  {
    i: 63700,
    s: 'TBSP.Index',
    f: null,
    m: 'TBSP.Index',
    d: 'TBSP.Index',
    u: 'TBSP.Index',
    c: 2260.6,
    o: 'BDM',
    r: null,
    q: 2,
  }, // indeks, f=null + kropka
  {
    i: 113628,
    s: 'BOS0735-K',
    f: 'BOS SA',
    m: 'BOS0735-K',
    d: 'BOS0735-K',
    u: 'BOS0735-K',
    c: 0,
    o: 'BDM',
    r: null,
    q: 2,
  }, // seria z myślnikiem
  {
    i: 78200,
    s: 'DS0432',
    f: 'SP',
    m: 'DS0432',
    d: 'DS0432',
    u: 'DS0432',
    c: 68.3,
    o: 'BDM',
    r: null,
    q: 2,
  }, // 6-znakowa seria skarbowa
  {
    i: 78201,
    s: 'ABE0227',
    f: 'ABE SA',
    m: 'ABE0227',
    d: 'ABE0227',
    u: 'ABE0227',
    c: 99,
    o: 'BDM',
    r: null,
    q: 2,
  }, // 7-znakowa seria Catalyst
  {
    i: 4336,
    s: '^DAX',
    f: 'DAX (Frankfurt Stock Exchange)',
    m: 'Niemcy',
    d: '^DAX (Niemcy)',
    u: 'DAX',
    c: 24866,
    o: 'INDICES',
    r: null,
    q: 2,
  }, // inny rynek
  {
    i: 63037,
    s: '2B76-GY.DE',
    f: 'iShares Automation & Robotics UCITS ETF',
    m: null,
    d: '2B76-GY.DE',
    u: '2B76-GY.DE',
    c: 17.52,
    o: 'IEX',
    r: 'EUR',
    q: 2,
  }, // zagranica
];

function makePayload(fillerCount = 600): string {
  const filler = Array.from({ length: fillerCount }, (_, i) => ({
    i: 100000 + i,
    s: `Z${String(i).padStart(3, '0')}`,
    f: `SYNTETYCZNA SPÓŁKA ${i} SPÓŁKA AKCYJNA`,
    m: `SYN${i}`,
    d: `Z${i}`,
    u: `Z${i}`,
    c: 1,
    o: 'BDM',
    r: null,
    q: 2,
  }));
  // Exact-match NA KOŃCU katalogu, za setkami prefiksowych dopasowań "Z0…" —
  // test capu MAX_MATCHES musi łapać regresję "slice bez sortowania".
  const trailingExact = {
    i: 999999,
    s: 'Z0',
    f: 'ZET ZERO SPÓŁKA AKCYJNA',
    m: 'ZETZERO',
    d: 'Z0',
    u: 'Z0',
    c: 1,
    o: 'BDM',
    r: null,
    q: 2,
  };
  return `var symbols = ${JSON.stringify([...INTERESTING, ...filler, trailingExact])};`;
}

function makeFetch(responses: Array<string | Error>) {
  let call = 0;
  const fn = (async () => {
    const resp = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (resp instanceof Error) throw resp;
    return { ok: true, status: 200, text: async () => resp } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls: () => call };
}

// ── parseBrCatalog ──────────────────────────────────────────────────────────

describe('parseBrCatalog', () => {
  const entries = parseBrCatalog(makePayload(600));

  it('zostawia wyłącznie akcje BDM z pełną nazwą i czystym tickerem', () => {
    const tickers = entries.map((e) => e.ticker);
    expect(tickers).toContain('AIT');
    expect(tickers).toContain('KGH');
    expect(tickers).toContain('GTN'); // delistowana zostaje
    expect(tickers).not.toContain('TBSP.INDEX'); // f=null + kropka
    expect(tickers).not.toContain('BOS0735-K'); // myślnik
    expect(tickers).not.toContain('^DAX'); // INDICES
    expect(tickers).not.toContain('2B76-GY.DE'); // IEX (zagranica)
    expect(tickers).not.toContain('DS0432'); // seria skarbowa (wzorzec serii)
    expect(tickers).not.toContain('ABE0227'); // seria Catalyst (długość)
    expect(entries.length).toBe(3 + 600 + 1); // interesting + filler + trailing Z0
  });

  it('mapuje pola: ticker uppercase, pełna nazwa, skrót', () => {
    const ait = entries.find((e) => e.ticker === 'AIT')!;
    expect(ait.name).toBe('AITON CALDWELL SPÓŁKA AKCYJNA');
    expect(ait.shortName).toBe('AITON');
  });

  it('rzuca na payloadzie niebędącym katalogiem (HTML)', () => {
    expect(() => parseBrCatalog('<!doctype html><html>...')).toThrow();
  });
});

// ── searchNcStatic (fallback offline) ───────────────────────────────────────

describe('searchNcStatic', () => {
  it('znajduje spółkę NC po tickerze i nazwie, z .WA/NC/PLN', () => {
    for (const q of ['AIT', 'aiton']) {
      const hit = searchNcStatic(q).find((r) => r.symbol === 'AIT.WA');
      expect(hit, `query=${q}`).toBeDefined();
      expect(hit!.exchange).toBe('NC');
      expect(hit!.currency).toBe('PLN');
    }
  });

  it('pusty query → pusto', () => {
    expect(searchNcStatic('  ')).toEqual([]);
  });
});

// ── createBrCatalogService ──────────────────────────────────────────────────

describe('createBrCatalogService', () => {
  it('NC po tickerze/nazwie → .WA/NC/PLN; GPW → GPW/PLN; jeden fetch na wiele wyszukiwań', async () => {
    const { fn, calls } = makeFetch([makePayload()]);
    const svc = createBrCatalogService({ dbFile: ':memory:', fetchFn: fn });

    for (const q of ['AIT', 'AITON', 'aiton caldwell']) {
      const hit = (await svc.search(q)).find((r) => r.symbol === 'AIT.WA');
      expect(hit, `query=${q}`).toBeDefined();
      expect(hit!.exchange).toBe('NC');
      expect(hit!.currency).toBe('PLN');
      expect(hit!.name).toBe('AITON CALDWELL SPÓŁKA AKCYJNA');
    }

    const kgh = (await svc.search('KGHM')).find((r) => r.symbol === 'KGH.WA');
    expect(kgh!.exchange).toBe('GPW');
    expect(kgh!.currency).toBe('PLN');

    // Delistowana spółka nadal podpowiadana (ręczne wpisy historyczne)
    const gtn = (await svc.search('GETIN')).find((r) => r.symbol === 'GTN.WA');
    expect(gtn).toBeDefined();

    expect(calls()).toBe(1); // katalog w pamięci — zero fetchy per query
    svc.close();
  });

  it('dokładne trafienie tickera nie ginie pod capem dopasowań', async () => {
    const { fn } = makeFetch([makePayload(600)]);
    const svc = createBrCatalogService({ dbFile: ':memory:', fetchFn: fn });
    // "Z0" prefiksowo łapie Z000–Z099 (100 wpisów przed Z0 w katalogu);
    // exact ticker Z0 siedzi na KOŃCU — bez pre-sortu wypadłby za capem.
    const results = await svc.search('Z0');
    expect(results[0]!.symbol).toBe('Z0.WA');
    expect(results.length).toBeLessThanOrEqual(50);
    svc.close();
  });

  it('awaria fetchu → fallback statyczna mapa NC (search nigdy nie rzuca)', async () => {
    const { fn } = makeFetch([new Error('network down')]);
    const svc = createBrCatalogService({ dbFile: ':memory:', fetchFn: fn, coldStartWaitMs: 10 });

    const results = await svc.search('AITON');
    const hit = results.find((r) => r.symbol === 'AIT.WA');
    expect(hit).toBeDefined();
    expect(hit!.exchange).toBe('NC');
    svc.close();
  });

  it('podejrzanie mały payload nie nadpisuje dobrego katalogu (sanity guard)', async () => {
    const truncated = `var symbols = ${JSON.stringify(INTERESTING.slice(0, 2))};`;
    const { fn, calls } = makeFetch([makePayload(), truncated]);
    const nowRef = { value: new Date('2026-07-16T10:00:00Z') };
    const svc = createBrCatalogService({
      dbFile: ':memory:',
      fetchFn: fn,
      now: () => nowRef.value,
    });

    expect((await svc.search('GETIN')).length).toBeGreaterThan(0);
    expect(calls()).toBe(1);

    // Po TTL 24h katalog jest stale → refresh dostaje ucięty payload → stary index zostaje
    nowRef.value = new Date('2026-07-18T10:00:00Z');
    const gtn = (await svc.search('GETIN')).find((r) => r.symbol === 'GTN.WA');
    expect(calls()).toBe(2);
    expect(gtn).toBeDefined(); // GTN nie ma w uciętym payloadzie — przeżył dzięki guardowi
    svc.close();
  });

  it('persystencja: restart w obrębie 24h czyta z bazy bez fetchu', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-catalog-test-'));
    const dbFile = path.join(dir, 'price_history.db');
    try {
      const first = makeFetch([makePayload()]);
      const svc1 = createBrCatalogService({ dbFile, fetchFn: first.fn });
      expect((await svc1.search('KGHM')).length).toBeGreaterThan(0);
      expect(first.calls()).toBe(1);
      svc1.close();

      // „Restart": nowa instancja, ta sama baza — index z DB, zero fetchy
      const second = makeFetch([makePayload()]);
      const svc2 = createBrCatalogService({ dbFile, fetchFn: second.fn });
      const kgh = (await svc2.search('KGHM')).find((r) => r.symbol === 'KGH.WA');
      expect(kgh).toBeDefined();
      expect(second.calls()).toBe(0);
      svc2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('po awarii retry najwcześniej po godzinie (bez retry-storm)', async () => {
    const { fn, calls } = makeFetch([new Error('down'), new Error('down'), makePayload()]);
    const nowRef = { value: new Date('2026-07-16T10:00:00Z') };
    const svc = createBrCatalogService({
      dbFile: ':memory:',
      fetchFn: fn,
      now: () => nowRef.value,
      coldStartWaitMs: 10,
    });

    await svc.search('AITON');
    await svc.search('KGHM');
    await svc.search('CDR');
    expect(calls()).toBe(1); // kolejne wyszukiwania w oknie backoffu NIE fetchują

    nowRef.value = new Date('2026-07-16T11:30:00Z'); // >1h — wolno ponowić
    await svc.search('AITON');
    expect(calls()).toBe(2);
    svc.close();
  });
});
