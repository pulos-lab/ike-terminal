import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseStockwatch,
  parseBiznesradar,
  parsePolishDate,
  nextTradingDayApprox,
  mergeCalendars,
  upcomingFromCalendarEntry,
  createGpwDividendCalendarService,
  type GpwCalendarEntry,
} from '../gpw-dividend-calendar.js';
import { createSourceGuard, createMemoryGuardStore } from '../source-guard.js';

/** Świeży guard per serwis — bez wstrzyknięcia default singleton otwierałby realną bazę. */
function makeGuard() {
  return createSourceGuard({
    name: 'biznesradar',
    store: createMemoryGuardStore(),
    notify: () => {},
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const stockwatchHtml = readFileSync(
  path.join(__dirname, 'fixtures', 'stockwatch-dywidendy.html'),
  'utf-8',
);
const biznesradarHtml = readFileSync(
  path.join(__dirname, 'fixtures', 'biznesradar-dywidendy.html'),
  'utf-8',
);

/** Data "dziś" zamrożona na dzień pobrania fixture'ów. */
const NOW = new Date('2026-06-10T12:00:00Z');

function entry(overrides: Partial<GpwCalendarEntry>): GpwCalendarEntry {
  return {
    ticker: 'TST',
    shortName: 'TEST',
    amountPln: 1,
    exDate: null,
    payDate: null,
    status: null,
    yieldPct: null,
    source: 'merged',
    ...overrides,
  };
}

const POS = { ticker: 'TST.WA', paperName: 'Testowa SA', shares: 100 };

// ── parsePolishDate ─────────────────────────────────────────────────────────

describe('parsePolishDate', () => {
  it('parsuje ISO YYYY-MM-DD', () => {
    expect(parsePolishDate('2026-08-18', NOW)).toBe('2026-08-18');
  });

  it('parsuje polski skrót DD mmm YY (wszystkie miesiące)', () => {
    expect(parsePolishDate('24 cze 26', NOW)).toBe('2026-06-24');
    expect(parsePolishDate('01 paź 26', NOW)).toBe('2026-10-01');
    expect(parsePolishDate('9 sty 27', NOW)).toBe('2027-01-09');
  });

  it('bd. i pusty tekst → null', () => {
    expect(parsePolishDate('bd.', NOW)).toBeNull();
    expect(parsePolishDate('', NOW)).toBeNull();
    expect(parsePolishDate('   ', NOW)).toBeNull();
  });

  it('odrzuca daty spoza okna wiarygodności [now−2 lata, now+3 lata]', () => {
    expect(parsePolishDate('2062-08-10', NOW)).toBeNull();
    expect(parsePolishDate('2020-01-01', NOW)).toBeNull();
    expect(parsePolishDate('2024-06-10', NOW)).toBe('2024-06-10');
    expect(parsePolishDate('2029-12-31', NOW)).toBe('2029-12-31');
  });

  it('śmieci → null', () => {
    expect(parsePolishDate('wkrótce', NOW)).toBeNull();
    expect(parsePolishDate('12 xyz 26', NOW)).toBeNull();
  });
});

// ── nextTradingDayApprox ────────────────────────────────────────────────────

describe('nextTradingDayApprox', () => {
  it('dzień powszedni → następny dzień', () => {
    expect(nextTradingDayApprox('2026-08-17')).toBe('2026-08-18'); // pon → wt
  });

  it('piątek → poniedziałek (przeskok weekendu)', () => {
    expect(nextTradingDayApprox('2026-06-26')).toBe('2026-06-29');
  });

  it('sobota → poniedziałek', () => {
    expect(nextTradingDayApprox('2026-06-27')).toBe('2026-06-29');
  });
});

// ── parseStockwatch ─────────────────────────────────────────────────────────

describe('parseStockwatch', () => {
  const entries = parseStockwatch(stockwatchHtml, NOW);
  const byName = new Map(entries.map((e) => [e.shortName, e]));

  it('parsuje wszystkie poprawne wiersze, pomija uszkodzony', () => {
    expect(entries).toHaveLength(4);
    expect(byName.has('USZKODZONY')).toBe(false);
  });

  it('skrót spółki, kwota z przecinkiem, stopa, brak tickera', () => {
    const stal = byName.get('STALPROFI')!;
    expect(stal.ticker).toBeNull();
    expect(stal.amountPln).toBe(0.3);
    expect(stal.yieldPct).toBe(3.21);
    expect(stal.source).toBe('stockwatch');
  });

  it('ex-date = "notowanie bez dyw.", payDate z div.stcm', () => {
    const stal = byName.get('STALPROFI')!;
    expect(stal.exDate).toBe('2026-08-18');
    expect(stal.payDate).toBe('2026-09-09');
    expect(stal.status).toBe('uchwalona');
  });

  it('status mimo tooltipa .bubbly + odrzucenie bogus dat 2062 (ATREM)', () => {
    const atrem = byName.get('ATREM')!;
    expect(atrem.status).toBe('proponowana');
    expect(atrem.exDate).toBeNull(); // 2062-08-09 poza oknem wiarygodności
    expect(atrem.payDate).toBe('2026-09-22'); // stcm jest wiarygodny
    expect(atrem.amountPln).toBe(0.72);
    expect(atrem.yieldPct).toBe(1.21);
  });

  it('status wypłacona + pusta data WZA nie psują parsowania', () => {
    expect(byName.get('SNIEZKA')!.status).toBe('wypłacona');
    expect(byName.get('VOXEL')!.status).toBe('proponowana');
    expect(byName.get('VOXEL')!.exDate).toBe('2026-09-29');
  });
});

// ── parseBiznesradar ────────────────────────────────────────────────────────

describe('parseBiznesradar', () => {
  const entries = parseBiznesradar(biznesradarHtml, NOW);
  const byTicker = new Map(entries.map((e) => [e.ticker, e]));

  it('parsuje wszystkie wiersze (GPW + NC)', () => {
    expect(entries).toHaveLength(7);
  });

  it('ticker i skrót z linku "TICKER (SKRÓT)"', () => {
    const atal = byTicker.get('1AT')!;
    expect(atal.shortName).toBe('ATAL');
    expect(atal.amountPln).toBe(4.5);
    expect(atal.source).toBe('biznesradar');
  });

  it('link bez nawiasów (MOL): ticker = skrót = tekst linku', () => {
    const mol = byTicker.get('MOL')!;
    expect(mol.shortName).toBe('MOL');
  });

  it('ex-date = "z prawem" + 1 dzień roboczy (pon → wt)', () => {
    expect(byTicker.get('STF')!.exDate).toBe('2026-08-18'); // 17 sie 26 (pon) + 1
    expect(byTicker.get('1AT')!.exDate).toBe('2026-07-14'); // 13 lip 26 (pon) + 1
  });

  it('ex-date przeskakuje weekend (VOXEL: piątek → poniedziałek)', () => {
    expect(byTicker.get('VOX')!.exDate).toBe('2026-06-29'); // 26 cze 26 (pt) + 1
  });

  it('bd. w datach → null (ABK)', () => {
    const abk = byTicker.get('ABK')!;
    expect(abk.exDate).toBeNull();
    expect(abk.payDate).toBeNull();
  });

  it('normalizacja statusów: rekomendowana → proponowana, pusty → null', () => {
    expect(byTicker.get('1AT')!.status).toBe('proponowana');
    expect(byTicker.get('STF')!.status).toBe('uchwalona');
    expect(byTicker.get('3RG')!.status).toBe('wypłacona');
    expect(byTicker.get('MOL')!.status).toBeNull();
  });

  it('dzień wypłaty z polskiego skrótu', () => {
    expect(byTicker.get('1AT')!.payDate).toBe('2026-10-01');
    expect(byTicker.get('STF')!.payDate).toBe('2026-09-09');
  });

  it('wiersze NewConnect mają identyczny markup (7FT)', () => {
    const fit = byTicker.get('7FT')!;
    expect(fit.shortName).toBe('7FIT');
    expect(fit.amountPln).toBe(0.31);
  });
});

// ── mergeCalendars ──────────────────────────────────────────────────────────

describe('mergeCalendars', () => {
  afterEach(() => vi.restoreAllMocks());

  const sw = parseStockwatch(stockwatchHtml, NOW);
  const br = parseBiznesradar(biznesradarHtml, NOW);

  it('STALPROFI: ticker z biznesradar, reszta ze stockwatch, payDate zgodny', () => {
    const merged = mergeCalendars(sw, br);
    const stal = merged.find((e) => e.shortName === 'STALPROFI')!;
    expect(stal.ticker).toBe('STF');
    expect(stal.amountPln).toBe(0.3);
    expect(stal.exDate).toBe('2026-08-18');
    expect(stal.status).toBe('uchwalona');
    expect(stal.payDate).toBe('2026-09-09');
    expect(stal.yieldPct).toBe(3.21);
    expect(stal.source).toBe('merged');
  });

  it('konflikt ex-date (VOXEL): wygrywa stockwatch', () => {
    const merged = mergeCalendars(sw, br);
    const voxel = merged.find((e) => e.shortName === 'VOXEL')!;
    expect(voxel.exDate).toBe('2026-09-29'); // nie 2026-06-29 z biznesradar
    expect(voxel.ticker).toBe('VOX');
    expect(voxel.payDate).toBe('2026-12-04');
  });

  it('wpisy jednoźródłowe przechodzą bez zmian', () => {
    const merged = mergeCalendars(sw, br);
    const sniezka = merged.find((e) => e.shortName === 'SNIEZKA')!;
    expect(sniezka.source).toBe('stockwatch');
    expect(sniezka.ticker).toBeNull();
    const mol = merged.find((e) => e.shortName === 'MOL')!;
    expect(mol.source).toBe('biznesradar');
    const fit = merged.find((e) => e.shortName === '7FIT')!;
    expect(fit.source).toBe('biznesradar');
    // 4 sw + 7 br − 2 wspólne (STALPROFI, VOXEL)
    expect(merged).toHaveLength(9);
  });

  it('payDate ze stockwatch ?? biznesradar', () => {
    const merged = mergeCalendars(
      [entry({ shortName: 'X', source: 'stockwatch', payDate: null, ticker: null })],
      [entry({ shortName: 'X', source: 'biznesradar', payDate: '2026-07-01' })],
    );
    expect(merged[0].payDate).toBe('2026-07-01');
  });

  it('zerowa kwota stockwatch NIE wygrywa z dodatnią biznesradar (przypadek MOL)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const merged = mergeCalendars(
      [entry({ shortName: 'MOLX', source: 'stockwatch', amountPln: 0, ticker: null })],
      [entry({ shortName: 'MOLX', source: 'biznesradar', amountPln: 3.27 })],
    );
    expect(merged[0].amountPln).toBe(3.27);
    expect(warn).not.toHaveBeenCalled(); // zero = brak danych, nie konflikt
  });

  it('rozbieżność kwot: zostaje stockwatch + console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const merged = mergeCalendars(
      [entry({ shortName: 'X', source: 'stockwatch', amountPln: 1.0, ticker: null })],
      [entry({ shortName: 'X', source: 'biznesradar', amountPln: 2.0 })],
    );
    expect(merged[0].amountPln).toBe(1.0);
    expect(warn).toHaveBeenCalledOnce();
  });
});

// ── upcomingFromCalendarEntry ───────────────────────────────────────────────

describe('upcomingFromCalendarEntry', () => {
  const today = '2026-06-10';

  it('przyszły ex-date → uwzględniony, kwota × akcje, PLN, passthrough statusu/źródła', () => {
    const u = upcomingFromCalendarEntry(
      entry({ amountPln: 0.72, exDate: '2026-08-18', payDate: '2026-09-09', status: 'uchwalona' }),
      POS,
      today,
    )!;
    expect(u).not.toBeNull();
    expect(u.ticker).toBe('TST.WA');
    expect(u.name).toBe('Testowa SA');
    expect(u.exDividendDate).toBe('2026-08-18');
    expect(u.paymentDate).toBe('2026-09-09');
    expect(u.estimatedAmount).toBe(72); // 0.72 × 100
    expect(u.currency).toBe('PLN');
    expect(u.dividendPerShare).toBe(0.72);
    expect(u.status).toBe('uchwalona');
    expect(u.source).toBe('gpw-calendar');
  });

  it('miniony ex-date, przyszła wypłata → uwzględniony', () => {
    const u = upcomingFromCalendarEntry(
      entry({ exDate: '2026-06-01', payDate: '2026-06-20' }),
      POS,
      today,
    );
    expect(u).not.toBeNull();
    expect(u!.exDividendDate).toBe('2026-06-01');
  });

  it('wypłacona z minionymi datami → null', () => {
    const u = upcomingFromCalendarEntry(
      entry({ exDate: '2026-06-01', payDate: '2026-06-08', status: 'wypłacona' }),
      POS,
      today,
    );
    expect(u).toBeNull();
  });

  it('brak jakiejkolwiek przyszłej daty → null', () => {
    expect(upcomingFromCalendarEntry(entry({}), POS, today)).toBeNull();
    expect(upcomingFromCalendarEntry(entry({ exDate: '2026-01-01' }), POS, today)).toBeNull();
  });

  it('ex-date nieznany, przyszła wypłata → exDividendDate = payDate', () => {
    const u = upcomingFromCalendarEntry(entry({ exDate: null, payDate: '2026-09-22' }), POS, today);
    expect(u).not.toBeNull();
    expect(u!.exDividendDate).toBe('2026-09-22');
  });

  it('zaokrąglenie kwoty do grosza', () => {
    const u = upcomingFromCalendarEntry(
      entry({ amountPln: 0.333, exDate: '2026-08-18' }),
      { ...POS, shares: 7 },
      today,
    )!;
    expect(u.estimatedAmount).toBe(2.33); // 0.333 × 7 = 2.331
  });
});

// ── Serwis: gating odświeżania + persystencja ──────────────────────────────

describe('createGpwDividendCalendarService', () => {
  afterEach(() => vi.restoreAllMocks());

  function makeService(opts: {
    failing?: () => boolean;
    clock: { now: Date };
    guard?: ReturnType<typeof makeGuard>;
  }) {
    const fetchCalls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      fetchCalls.push(url);
      if (opts.failing?.()) throw new Error('network down');
      const html = url.includes('stockwatch') ? stockwatchHtml : biznesradarHtml;
      return new Response(html, { status: 200 });
    }) as unknown as typeof fetch;

    const service = createGpwDividendCalendarService({
      fetchFn,
      dbFile: ':memory:',
      now: () => opts.clock.now,
      politenessDelayMs: 0,
      guard: opts.guard ?? makeGuard(),
    });
    return { service, fetchCalls };
  }

  it('pierwsze wywołanie: 3 sekwencyjne fetche (stockwatch, BR GPW, BR NC) i zapis do bazy', async () => {
    const clock = { now: new Date(NOW) };
    const { service, fetchCalls } = makeService({ clock });

    const cal = await service.getCalendar();
    expect(fetchCalls).toEqual([
      'https://www.stockwatch.pl/dywidendy',
      'https://www.biznesradar.pl/dywidendy/',
      'https://www.biznesradar.pl/dywidendy/newconnect',
    ]);
    expect(cal.byTicker.get('STF')?.exDate).toBe('2026-08-18');
    expect(cal.byShortName.get('SNIEZKA')?.ticker).toBeNull();
    service.close();
  });

  it('kolejne wywołania w oknie 24h: 0 fetchy; po 24h — odświeżenie', async () => {
    const clock = { now: new Date(NOW) };
    const { service, fetchCalls } = makeService({ clock });

    await service.getCalendar();
    expect(fetchCalls).toHaveLength(3);

    clock.now = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);
    const cal = await service.getCalendar();
    expect(fetchCalls).toHaveLength(3); // brak nowych fetchy
    expect(cal.byTicker.size).toBeGreaterThan(0);

    clock.now = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    await service.getCalendar();
    expect(fetchCalls).toHaveLength(6);
    service.close();
  });

  it('równoległe wywołania dzielą jeden in-flight refresh', async () => {
    const clock = { now: new Date(NOW) };
    const { service, fetchCalls } = makeService({ clock });

    await Promise.all([service.getCalendar(), service.getCalendar(), service.getCalendar()]);
    expect(fetchCalls).toHaveLength(3);
    service.close();
  });

  it('totalna awaria: stare dane zostają, retry dopiero po ≥1h', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failing = false;
    const clock = { now: new Date(NOW) };
    const { service, fetchCalls } = makeService({ failing: () => failing, clock });

    await service.getCalendar(); // sukces → 3 fetche
    failing = true;

    clock.now = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    const stale = await service.getCalendar(); // próba (3 fetche, wszystkie padają)
    expect(fetchCalls).toHaveLength(6);
    expect(stale.byTicker.get('STF')?.exDate).toBe('2026-08-18'); // stare dane serwowane

    clock.now = new Date(NOW.getTime() + 25.5 * 60 * 60 * 1000);
    await service.getCalendar(); // < 1h od ostatniej próby → bez fetchy
    expect(fetchCalls).toHaveLength(6);

    clock.now = new Date(NOW.getTime() + 26.5 * 60 * 60 * 1000);
    await service.getCalendar(); // > 1h od ostatniej próby → retry
    expect(fetchCalls).toHaveLength(9);
    expect(warn).toHaveBeenCalled();
    service.close();
  });

  it('awaria jednego źródła: partial-merge z pozostałych', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('stockwatch')) throw new Error('stockwatch down');
      return new Response(biznesradarHtml, { status: 200 });
    }) as unknown as typeof fetch;
    const service = createGpwDividendCalendarService({
      fetchFn,
      dbFile: ':memory:',
      now: () => NOW,
      politenessDelayMs: 0,
      guard: makeGuard(),
    });

    const cal = await service.getCalendar();
    expect(cal.byTicker.get('STF')?.source).toBe('biznesradar');
    // biznesradarowe przybliżenie ex-date (z prawem + 1 dzień roboczy)
    expect(cal.byTicker.get('STF')?.exDate).toBe('2026-08-18');
    expect(cal.byShortName.has('SNIEZKA')).toBe(false); // stockwatch-only nieobecne
    service.close();
  });

  it('strony biznesradar 200-puste → parse-miss calendar:gpw/nc; stockwatch dalej zapisany', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = makeGuard();
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('stockwatch')) return new Response(stockwatchHtml, { status: 200 });
      return new Response('<html><body>nowy layout bez tabeli</body></html>', { status: 200 });
    }) as unknown as typeof fetch;
    const service = createGpwDividendCalendarService({
      fetchFn,
      dbFile: ':memory:',
      now: () => NOW,
      politenessDelayMs: 0,
      guard,
    });

    const cal = await service.getCalendar();
    expect(cal.byShortName.has('SNIEZKA')).toBe(true); // partial-merge ze stockwatch
    expect(guard.getState().parseMissKeys).toEqual(['calendar:gpw', 'calendar:nc']);
    service.close();
    vi.restoreAllMocks();
  });

  it('blokada anti-bot (403) na stronach BR → registerBlock, bez wyjątku', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = makeGuard();
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('stockwatch')) return new Response(stockwatchHtml, { status: 200 });
      return new Response('Access denied', { status: 403 });
    }) as unknown as typeof fetch;
    const service = createGpwDividendCalendarService({
      fetchFn,
      dbFile: ':memory:',
      now: () => NOW,
      politenessDelayMs: 0,
      guard,
    });

    const cal = await service.getCalendar();
    expect(cal.byShortName.has('SNIEZKA')).toBe(true);
    expect(guard.getState().consecutiveBlocks).toBe(2); // obie strony BR
    expect(guard.getState().parseMissKeys).toEqual([]); // blokada ≠ parse-miss
    service.close();
    vi.restoreAllMocks();
  });

  it('bezpiecznik otwarty → fetch tylko stockwatch (1 wywołanie zamiast 3)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const guard = makeGuard();
    for (let i = 0; i < 3; i++) guard.registerBlock();
    const clock = { now: new Date(NOW) };
    const { service, fetchCalls } = makeService({ clock, guard });

    const cal = await service.getCalendar();
    expect(fetchCalls).toEqual(['https://www.stockwatch.pl/dywidendy']);
    expect(cal.byShortName.has('SNIEZKA')).toBe(true);
    service.close();
    vi.restoreAllMocks();
  });

  it('udane strony BR rejestrują sukces (lastSuccessAt) i czyszczą missy', async () => {
    const guard = makeGuard();
    guard.registerParseMiss('calendar:gpw', { structural: true });
    const clock = { now: new Date(NOW) };
    const { service } = makeService({ clock, guard });

    await service.getCalendar();
    expect(guard.getState().parseMissKeys).toEqual([]);
    expect(guard.getState().lastSuccessAt).not.toBeNull();
    service.close();
  });
});
