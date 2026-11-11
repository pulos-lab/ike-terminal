import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  lookupOpenFigi,
  findOpenFigiCandidates,
  parseFigiMappingResponse,
  selectFigiCandidates,
  setOpenFigiDepsForTests,
  createOpenFigiGuard,
  type FigiListing,
} from '../openfigi.js';
import type { SourceGuard } from '../source-guard.js';
import * as adminNotifications from '../admin-notifications.js';

// Gdyby guard OpenFIGI miał `notify`, alarm szedłby tędy (dynamiczny import jak w biznesradar-guard).
vi.mock('../admin-notifications.js', () => ({ notifySourceGuardAlert: vi.fn() }));

/**
 * Fixture'y to ZAPIS ŻYWYCH ODPOWIEDZI `POST https://api.openfigi.com/v3/mapping`
 * (bez klucza, 2026-11-06). Treść 1:1 z odpowiedzią (sprawdzone równością JSON);
 * różni się wyłącznie wcięciami, bo lint-staged przepuszcza `*.json` przez prettiera:
 *  - tsm-mbgl:           [US8740391003, US60744M1062]
 *  - sap-brkb-unknown:   [DE0007164600, US0846707026, XS0000000009]
 *    (ostatni = {"warning":"No identifier found."})
 */
const dir = path.join(__dirname, 'fixtures');
const TSM_MBGL = fs.readFileSync(path.join(dir, 'openfigi-mapping-tsm-mbgl.json'), 'utf-8');
const SAP_BRKB_UNKNOWN = fs.readFileSync(
  path.join(dir, 'openfigi-mapping-sap-brkb-unknown.json'),
  'utf-8',
);

function listingsFrom(raw: string, isins: string[], isin: string): FigiListing[] {
  const parsed = parseFigiMappingResponse(JSON.parse(raw), isins);
  if (!parsed) throw new Error('fixture nie sparsował się');
  return parsed.get(isin) ?? [];
}

const TSM = listingsFrom(TSM_MBGL, ['US8740391003', 'US60744M1062'], 'US8740391003');
const MBGL = listingsFrom(TSM_MBGL, ['US8740391003', 'US60744M1062'], 'US60744M1062');
const SAP_JOBS = ['DE0007164600', 'US0846707026', 'XS0000000009'];
const SAP = listingsFrom(SAP_BRKB_UNKNOWN, SAP_JOBS, 'DE0007164600');
const BRKB = listingsFrom(SAP_BRKB_UNKNOWN, SAP_JOBS, 'US0846707026');

describe('parseFigiMappingResponse — żywa koperta', () => {
  it('rozkłada odpowiedź po zadaniach, „No identifier found" = pusta lista', () => {
    const parsed = parseFigiMappingResponse(JSON.parse(SAP_BRKB_UNKNOWN), SAP_JOBS)!;
    expect(parsed.get('DE0007164600')!.length).toBeGreaterThan(100);
    expect(parsed.get('XS0000000009')).toEqual([]);
    expect(TSM.find((l) => l.exchCode === 'US')).toMatchObject({
      ticker: 'TSM',
      name: 'TAIWAN SEMICONDUCTOR-SP ADR',
    });
  });

  it('nierozpoznana koperta → null (nie pusta lista)', () => {
    expect(parseFigiMappingResponse({ data: [] }, ['US8740391003'])).toBeNull();
    expect(parseFigiMappingResponse([{ foo: 1 }], ['US8740391003'])).toBeNull();
    // Liczba wyników ≠ liczba zadań — nie zgadujemy, który jest który.
    expect(parseFigiMappingResponse([], ['US8740391003'])).toBeNull();
  });
});

describe('selectFigiCandidates', () => {
  it.each(['USD', 'PLN'])('ADR TSMC (transakcja w %s) → TSM z giełdy US', (cur) => {
    expect(selectFigiCandidates('US8740391003', TSM, cur).map((c) => c.symbol)).toEqual(['TSM']);
  });

  it('MBGL (spin-off S&P Global) → MBGL', () => {
    expect(selectFigiCandidates('US60744M1062', MBGL, 'USD').map((c) => c.symbol)).toEqual([
      'MBGL',
    ]);
  });

  it('klasa akcji: Bloomberg BRK/B → Yahoo BRK-B', () => {
    expect(selectFigiCandidates('US0846707026', BRKB, 'USD')[0]?.symbol).toBe('BRK-B');
  });

  it('SAP w EUR → SAP.DE; obca linia w obcej walucie (SAPGF, OTC USD) odpada', () => {
    expect(selectFigiCandidates('DE0007164600', SAP, 'EUR').map((c) => c.symbol)).toEqual([
      'SAP.DE',
    ]);
  });

  it('SAP w USD → najpierw giełda macierzysta, potem linia US', () => {
    expect(selectFigiCandidates('DE0007164600', SAP, 'USD').map((c) => c.symbol)).toEqual([
      'SAP.DE',
      'SAPGF',
    ]);
  });

  it('kod giełdy z kilkoma tickerami (SW: SAP + SAPEUR) jest niejednoznaczny', () => {
    // CH-prefiks robi z SW giełdę macierzystą — mimo to SW odpada w całości.
    const fakeHomeSw = SAP.filter((l) => l.exchCode === 'SW');
    expect(new Set(fakeHomeSw.map((l) => l.ticker)).size).toBeGreaterThan(1);
    expect(selectFigiCandidates('CH0000000000', fakeHomeSw, 'CHF')).toEqual([]);
  });

  it('kraj spoza mapy (np. IE) bez listingu w walucie transakcji → brak kandydatów', () => {
    // Te same listingi SAP-a pod ISIN-em irlandzkim: brak giełdy macierzystej,
    // a GBP nie ma żadna z giełd w mapie.
    expect(selectFigiCandidates('IE0000000000', SAP, 'GBP')).toEqual([]);
  });
});

describe('lookupOpenFigi — transport, guard, budżet', () => {
  let nowMs = Date.UTC(2026, 10, 6, 9, 0, 0);
  let guard: SourceGuard;
  const notify = adminNotifications.notifySourceGuardAlert as unknown as ReturnType<typeof vi.fn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  const ok = (raw: string) => new Response(raw, { status: 200 });

  beforeEach(() => {
    process.env.OPENFIGI = 'on';
    delete process.env.OPENFIGI_API_KEY;
    nowMs = Date.UTC(2026, 10, 6, 9, 0, 0);
    notify.mockClear();
    // Ta sama fabryka co w produkcji (bez `notify`) — inaczej test „bez maila" sprawdzałby własnego szpiega.
    guard = createOpenFigiGuard({ now: () => nowMs });
    fetchMock = vi.fn();
    setOpenFigiDepsForTests({
      fetch: fetchMock as unknown as typeof fetch,
      now: () => nowMs,
      guard,
    });
  });

  afterAll(() => {
    setOpenFigiDepsForTests(null);
    process.env.OPENFIGI = 'off';
  });

  it('wysyła WYŁĄCZNIE ISIN-y (ID_ISIN), bez nazw ani kwot', async () => {
    fetchMock.mockResolvedValue(ok(TSM_MBGL));
    const res = await lookupOpenFigi(['US8740391003', 'US60744M1062']);
    expect(res.get('US8740391003')!.length).toBe(TSM.length);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openfigi.com/v3/mapping');
    expect(JSON.parse(init.body)).toEqual([
      { idType: 'ID_ISIN', idValue: 'US8740391003' },
      { idType: 'ID_ISIN', idValue: 'US60744M1062' },
    ]);
  });

  it('batch po 10 zadań', async () => {
    const isins = Array.from({ length: 11 }, (_, i) => `US00000000${String(i).padStart(2, '0')}`);
    fetchMock.mockImplementation(async (_u: string, init: RequestInit) => {
      const jobs = JSON.parse(init.body as string) as unknown[];
      return ok(JSON.stringify(jobs.map(() => ({ warning: 'No identifier found.' }))));
    });
    await lookupOpenFigi(isins);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toHaveLength(10);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toHaveLength(1);
  });

  it('cache: drugi lookup tego samego ISIN-u nie idzie do sieci', async () => {
    fetchMock.mockResolvedValue(ok(TSM_MBGL));
    await lookupOpenFigi(['US8740391003', 'US60744M1062']);
    const again = await findOpenFigiCandidates('US8740391003', 'USD');
    expect(again.map((c) => c.symbol)).toEqual(['TSM']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 → miękki miss bez maila; po 3 pod rząd bezpiecznik wstrzymuje fetch', async () => {
    fetchMock.mockResolvedValue(new Response('Too Many Requests', { status: 429 }));
    for (let i = 0; i < 3; i++) {
      expect((await lookupOpenFigi(['US8740391003'])).size).toBe(0);
    }
    expect(guard.getState().blocked).toBe(true);
    expect(notify).not.toHaveBeenCalled();

    await lookupOpenFigi(['US8740391003']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('miss NIE trafia do cache — po backoffie ten sam ISIN jest odpytywany ponownie', async () => {
    const jobs = ['US8740391003', 'US60744M1062'];
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 }));
    expect((await lookupOpenFigi(jobs)).size).toBe(0);
    fetchMock.mockResolvedValueOnce(ok(TSM_MBGL));
    const res = await lookupOpenFigi(jobs);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.get('US60744M1062')!.some((l) => l.ticker === 'MBGL')).toBe(true);
  });

  it('timeout → miękki miss, bezpiecznik nietknięty', async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    );
    const res = await lookupOpenFigi(['US8740391003']);
    expect(res.size).toBe(0);
    expect(guard.getState().consecutiveBlocks).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('budżet 20 zapytań / 60 s; po upływie okna znów wolno', async () => {
    fetchMock.mockImplementation(async () =>
      ok(JSON.stringify([{ warning: 'No identifier found.' }])),
    );
    for (let i = 0; i < 21; i++) {
      await lookupOpenFigi([`US99999999${String(i).padStart(2, '0')}`]);
    }
    expect(fetchMock).toHaveBeenCalledTimes(20);

    nowMs += 60_000;
    await lookupOpenFigi(['US9999999999']);
    expect(fetchMock).toHaveBeenCalledTimes(21);
  });

  it('nierozpoznana koperta przy 200 → podejrzenie zmiany API w stanie guarda', async () => {
    fetchMock.mockImplementation(async () => ok(JSON.stringify({ unexpected: true })));
    await lookupOpenFigi(['US8740391003']);
    await lookupOpenFigi(['US60744M1062']);
    expect(guard.getState().suspectedMarkupChange).toBe(true);
  });

  it('wyłącznik OPENFIGI=off → zero ruchu sieciowego', async () => {
    process.env.OPENFIGI = 'off';
    expect((await lookupOpenFigi(['US8740391003'])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
