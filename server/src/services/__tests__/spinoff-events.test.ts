import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseUsDate,
  parseStockanalysisSpinoffs,
  createSpinoffEventsService,
} from '../spinoff-events.js';

// Fixture = PRZYCIĘTY FRAGMENT REALNEGO HTML-a strony stockanalysis.com
// (Recent Stock Spinoffs, dostarczony przez użytkownika 2026-07): kolumny
// [Date | Parent | New Stock | Parent Company | New Company], markup SvelteKit
// SSR z szumem komentarzy <!--[!--> i tickerami jako linki lub goły tekst.
const FIXTURE_HTML = fs.readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '__fixtures__',
    'stockanalysis-spinoffs.html',
  ),
  'utf-8',
);

const NOW = new Date('2026-07-03T12:00:00Z');

describe('parseUsDate', () => {
  it('parsuje format US i ISO, odrzuca śmieci', () => {
    expect(parseUsDate('Jul 1, 2026')).toBe('2026-07-01');
    expect(parseUsDate('December 15, 2025')).toBe('2025-12-15');
    expect(parseUsDate('2026-07-01')).toBe('2026-07-01');
    expect(parseUsDate('bd.')).toBeNull();
    expect(parseUsDate('')).toBeNull();
  });
});

describe('parseStockanalysisSpinoffs — realny markup', () => {
  it('wyciąga zdarzenia z realnej tabeli (tickery z linków i gołego tekstu), ratio=null', () => {
    const { events, skipped } = parseStockanalysisSpinoffs(FIXTURE_HTML, NOW);

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      parentTicker: 'SPGI',
      childTicker: 'MBGL',
      parentName: 'S&p Global Inc',
      childName: 'Mobility Global Inc',
      exDate: '2026-07-01',
      ratio: null,
    });
    expect(events[1]).toMatchObject({
      parentTicker: 'HON',
      childTicker: 'HONA',
      exDate: '2026-06-29',
    });
    expect(events[2]).toMatchObject({ parentTicker: 'FDX', childTicker: 'FDXF' });
    // ENVI — ticker rodzica jako goły tekst (bez linku), dziecko jako link
    expect(events[3]).toMatchObject({
      parentTicker: 'ENVI',
      childTicker: 'NVRI',
      childName: 'Enviri Corp',
    });
    expect(skipped).toBe(0);
  });

  it('brak tabeli / pusty HTML → zero zdarzeń, zero wyjątków', () => {
    expect(parseStockanalysisSpinoffs('<html><body></body></html>', NOW)).toEqual({
      events: [],
      skipped: 0,
    });
  });

  it('wiersz z datą poza oknem wiarygodności jest pomijany', () => {
    const html = FIXTURE_HTML.replace('Jul 1, 2026', 'Jul 1, 1999');
    const { events, skipped } = parseStockanalysisSpinoffs(html, NOW);
    expect(events).toHaveLength(3);
    expect(skipped).toBe(1);
  });
});

describe('createSpinoffEventsService', () => {
  const mockPageFetch = (html: string) =>
    vi.fn().mockResolvedValue(new Response(html, { status: 200 })) as unknown as typeof fetch;

  /** Jak mockPageFetch, ale świeży Response per wywołanie — scenariusze
   *  wieloprzebiegowe czytają body przy każdym refreshu. */
  const freshPageFetch = (html: string) =>
    vi
      .fn()
      .mockImplementation(
        async () => new Response(html, { status: 200 }),
      ) as unknown as typeof fetch;

  /** Minimalna tabela w kształcie źródła — do scenariuszy z liczbą zdarzeń
   *  spoza fixture'a (rotacja lookupów, bramki wieku/prób). */
  const makeSpinoffsHtml = (rows: string[][]) => `
    <table>
      <thead><tr><th>Date</th><th>Parent</th><th>New Stock</th></tr></thead>
      <tbody>
        ${rows
          .map(
            ([date, parent, child]) =>
              `<tr><td>${date}</td><td>${parent}</td><td>${child}</td></tr>`,
          )
          .join('')}
      </tbody>
    </table>`;

  it('refresh zapisuje zdarzenia bez ratio; getEvents zwraca tylko kompletne; pending widoczne', async () => {
    const fetchFn = mockPageFetch(FIXTURE_HTML);
    // Resolver zna ratio tylko dla SPGI→MBGL
    const ratioResolver = vi
      .fn()
      .mockImplementation(async (e: { parentTicker: string }) =>
        e.parentTicker === 'SPGI'
          ? { ratio: 1, sourceUrl: 'https://www.sec.gov/Archives/edgar/data/x/8k.htm' }
          : null,
      );
    const service = createSpinoffEventsService({
      fetchFn,
      dbFile: ':memory:',
      now: () => NOW,
      ratioResolver,
    });

    const events = await service.getEvents();
    // Tylko SPGI→MBGL ma ratio → jedyny kandydat appliera
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ parentTicker: 'SPGI', childTicker: 'MBGL', ratio: 1 });
    expect(events[0].source).toContain('sec.gov');

    // Pozostałe zdarzenia czekają na ratio — widoczne dla UI
    const pending = service.getPendingRatioEvents();
    expect(pending.map((p) => p.parentTicker).sort()).toEqual(['ENVI', 'FDX', 'HON']);

    // Świeże dane (last_success < 24h) → bez kolejnego strzału do strony
    await service.getEvents();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    service.close();
  });

  it('kolejny refresh NIE nadpisuje rozwiązanego ratio NULL-em', async () => {
    let clock = NOW.getTime();
    const fetchFn = mockPageFetch(FIXTURE_HTML);
    let resolverKnows = true;
    const ratioResolver = vi
      .fn()
      .mockImplementation(async (e: { parentTicker: string }) =>
        resolverKnows && e.parentTicker === 'SPGI' ? { ratio: 1, sourceUrl: 'sec' } : null,
      );
    const service = createSpinoffEventsService({
      fetchFn,
      dbFile: ':memory:',
      now: () => new Date(clock),
      ratioResolver,
    });

    await service.getEvents(); // SPGI dostaje ratio=1
    resolverKnows = false; // SEC "przestaje odpowiadać"
    clock += 25 * 60 * 60 * 1000; // wymuś kolejny refresh (upsert wierszy)

    const events = await service.getEvents();
    expect(events).toHaveLength(1); // ratio SPGI przeżyło upsert
    expect(events[0].ratio).toBe(1);
    service.close();
  });

  it('awaria źródła: stare wiersze zostają, retry dopiero po godzinie', async () => {
    let fail = false;
    const fetchFn = vi.fn().mockImplementation(async () => {
      if (fail) throw new Error('network down');
      return new Response(FIXTURE_HTML, { status: 200 });
    }) as unknown as typeof fetch;
    const ratioResolver = vi.fn().mockResolvedValue({ ratio: 1, sourceUrl: 'sec' });

    let clock = NOW.getTime();
    const service = createSpinoffEventsService({
      fetchFn,
      dbFile: ':memory:',
      now: () => new Date(clock),
      ratioResolver,
    });

    await service.getEvents(); // sukces → 4 zdarzenia z ratio
    fail = true;
    clock += 25 * 60 * 60 * 1000; // dane stały się stale (>24h)

    const events = await service.getEvents(); // refresh pada → stare wiersze
    expect(events).toHaveLength(4);
    const callsAfterFail = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length;

    await service.getEvents(); // <1h od porażki → bez kolejnej próby
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFail);

    clock += 2 * 60 * 60 * 1000; // >1h → wolno spróbować ponownie
    fail = false;
    await service.getEvents();
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFail + 1);
    service.close();
  });

  it('lookupy ratio rotują — przy nadmiarze zaległych każdy dostaje swoją kolej', async () => {
    // 7 zdarzeń, limit 5 na refresh. Stara kolejność (ex_date DESC) odpytywała
    // w kółko te same 5 najnowszych — 2 najstarsze nie dostawały już nigdy próby.
    const rows = [
      ['Jul 1, 2026', 'AAA', 'AAX'],
      ['Jun 28, 2026', 'BBB', 'BBX'],
      ['Jun 25, 2026', 'CCC', 'CCX'],
      ['Jun 22, 2026', 'DDD', 'DDX'],
      ['Jun 19, 2026', 'EEE', 'EEX'],
      ['Jun 16, 2026', 'FFF', 'FFX'],
      ['Jun 13, 2026', 'GGG', 'GGX'],
    ];
    let clock = NOW.getTime();
    const ratioResolver = vi.fn().mockResolvedValue(null);
    const service = createSpinoffEventsService({
      fetchFn: freshPageFetch(makeSpinoffsHtml(rows)),
      dbFile: ':memory:',
      now: () => new Date(clock),
      ratioResolver,
    });

    await service.getEvents();
    const firstRound = ratioResolver.mock.calls.map((c) => c[0].parentTicker);
    expect(firstRound).toHaveLength(5);

    clock += 25 * 60 * 60 * 1000;
    ratioResolver.mockClear();
    await service.getEvents();
    const secondRound = ratioResolver.mock.calls.map((c) => c[0].parentTicker);

    // Nigdy nieproszone (last_ratio_attempt NULL) idą pierwsze
    expect(secondRound.slice(0, 2).sort()).toEqual(['FFF', 'GGG']);
    // Po dwóch rundach każde zdarzenie było odpytane przynajmniej raz
    expect(new Set([...firstRound, ...secondRound]).size).toBe(7);
    service.close();
  });

  it('odpuszcza ratio po wyczerpaniu prób (nie odpytuje EDGAR-a w nieskończoność)', async () => {
    let clock = NOW.getTime();
    const ratioResolver = vi.fn().mockResolvedValue(null);
    const service = createSpinoffEventsService({
      fetchFn: freshPageFetch(makeSpinoffsHtml([['Jul 1, 2026', 'AAA', 'AAX']])),
      dbFile: ':memory:',
      now: () => new Date(clock),
      ratioResolver,
    });

    for (let i = 0; i < 25; i++) {
      await service.getEvents();
      clock += 25 * 60 * 60 * 1000;
    }
    expect(ratioResolver).toHaveBeenCalledTimes(20); // MAX_RATIO_ATTEMPTS
    service.close();
  });

  it('nie odpytuje SEC o zdarzenia sprzed ponad 90 dni', async () => {
    const ratioResolver = vi.fn().mockResolvedValue(null);
    const service = createSpinoffEventsService({
      fetchFn: mockPageFetch(
        makeSpinoffsHtml([
          ['Jul 1, 2026', 'AAA', 'AAX'],
          ['Jan 5, 2026', 'OLD', 'OLX'], // ~180 dni przed NOW
        ]),
      ),
      dbFile: ':memory:',
      now: () => NOW,
      ratioResolver,
    });

    await service.getEvents();
    expect(ratioResolver.mock.calls.map((c) => c[0].parentTicker)).toEqual(['AAA']);
    // Zdarzenie zostaje w tabeli (sygnalizację wygasza dopiero warstwa widoku)
    expect(service.getPendingRatioEvents()).toHaveLength(2);
    service.close();
  });

  it('przebudowuje tabelę ze starego kształtu (ratio NOT NULL) bez wyjątku', async () => {
    // Symulacja dev-bazy sprzed kalibracji: plik tymczasowy z legacy schematem
    const os = await import('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-spinoff-legacy-'));
    const dbFile = path.join(tmp, 'price_history.db');
    const Database = (await import('better-sqlite3')).default;
    const legacy = new Database(dbFile);
    legacy.exec(`
      CREATE TABLE spinoff_events (
        parent_ticker TEXT NOT NULL,
        child_ticker TEXT NOT NULL,
        child_name TEXT,
        ex_date TEXT NOT NULL,
        ratio REAL NOT NULL,
        source_url TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (parent_ticker, ex_date)
      );
    `);
    legacy.close();

    const service = createSpinoffEventsService({
      fetchFn: mockPageFetch(FIXTURE_HTML),
      dbFile,
      now: () => NOW,
      ratioResolver: vi.fn().mockResolvedValue(null),
    });
    const events = await service.getEvents(); // nie rzuca; nowy kształt działa
    expect(events).toHaveLength(0); // resolver nic nie zna → wszystko pending
    expect(service.getPendingRatioEvents()).toHaveLength(4);
    service.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
