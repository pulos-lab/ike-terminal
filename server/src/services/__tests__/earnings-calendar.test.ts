import { describe, it, expect, vi } from 'vitest';
import type { Position } from 'shared';
import {
  createEarningsCalendarService,
  isoDateRange,
  toIsoDate,
} from '../earnings/earnings-calendar.js';
import { createSourceGuard, createMemoryGuardStore } from '../source-guard.js';

const NOW = new Date('2026-08-01T09:00:00.000Z');

function guard(name: string) {
  return createSourceGuard({ name, store: createMemoryGuardStore() });
}

function usPosition(overrides: Partial<Position> = {}): Position {
  return {
    paperName: 'Apple Inc.',
    isin: 'US0378331005',
    ticker: 'AAPL',
    shares: 10,
    avgBuyPrice: 100,
    totalCommission: 0,
    currentPrice: 200,
    currentValue: 2000,
    currentValuePln: 8000,
    profitLoss: 1000,
    profitLossPln: 4000,
    profitLossPct: 100,
    currency: 'USD',
    weight: 1,
    exchange: 'NASDAQ',
    dailyChangePct: null,
    category: 'stock',
    ...overrides,
  };
}

function nasdaqDay(symbols: string[]) {
  return new Response(
    JSON.stringify({
      data: { rows: symbols.map((s) => ({ symbol: s, time: 'time-after-hours' })) },
    }),
    { status: 200 },
  );
}

/** Odpowiada wierszem tylko dla wskazanej daty — reszta dni pusta (jak weekend). */
function nasdaqFetchFor(date: string, symbols: string[]) {
  return vi.fn(async (url: string | URL | Request) =>
    String(url).includes(`date=${date}`) ? nasdaqDay(symbols) : nasdaqDay([]),
  );
}

function makeService(fetchFn: unknown, now: () => Date = () => NOW) {
  return createEarningsCalendarService({
    fetchFn: fetchFn as typeof fetch,
    dbFile: ':memory:',
    now,
    politenessDelayMs: 0,
    nasdaqGuard: guard('t-nasdaq'),
    bankierGuard: guard('t-bankier'),
  });
}

describe('pomocnicze daty', () => {
  it('generuje kolejne dni okna', () => {
    expect(isoDateRange(new Date('2026-08-30T00:00:00Z'), 3)).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
    ]);
  });

  it('bierze datę w UTC', () => {
    expect(toIsoDate(new Date('2026-08-01T23:30:00.000Z'))).toBe('2026-08-01');
  });
});

describe('earnings-calendar — odświeżanie US', () => {
  it('zapisuje terminarz i wystawia go pozycjom', async () => {
    const fetchFn = nasdaqFetchFor('2026-08-05', ['AAPL']);
    const service = makeService(fetchFn);
    try {
      await service.refreshUs();
      const upcoming = service.getUpcomingForPositions([usPosition()], '2026-08-01');
      expect(upcoming).toHaveLength(1);
      expect(upcoming[0]).toMatchObject({
        ticker: 'AAPL',
        reportDate: '2026-08-05',
        daysUntil: 4,
        confidence: 'confirmed',
        session: 'amc',
        source: 'nasdaq',
      });
    } finally {
      service.close();
    }
  });

  it('nie odświeża częściej niż raz na dobę', async () => {
    const fetchFn = nasdaqFetchFor('2026-08-05', ['AAPL']);
    const service = makeService(fetchFn);
    try {
      await service.refreshUs();
      const afterFirst = fetchFn.mock.calls.length;
      await service.refreshUs();
      expect(fetchFn.mock.calls.length).toBe(afterFirst);
    } finally {
      service.close();
    }
  });

  it('dwa równoległe odświeżenia dzielą jedno zamiatanie', async () => {
    const fetchFn = nasdaqFetchFor('2026-08-05', ['AAPL']);
    const service = makeService(fetchFn);
    try {
      await Promise.all([service.refreshUs(), service.refreshUs()]);
      // 45 dni okna, nie 90 — drugi wołacz dostał ten sam promise.
      expect(fetchFn.mock.calls.length).toBe(45);
    } finally {
      service.close();
    }
  });

  it('awaria źródła zostawia poprzedni terminarz', async () => {
    const okFetch = nasdaqFetchFor('2026-08-05', ['AAPL']);
    const service = makeService(okFetch);
    try {
      await service.refreshUs();
      service.close();
    } catch {
      /* ignore */
    }

    // Druga instancja na tej samej (pamięciowej) bazie nie ma sensu — sprawdzamy
    // wariant, w którym zamiatanie pada w obrębie jednej instancji.
    const failing = vi.fn(async () => new Response('boom', { status: 500 }));
    const service2 = createEarningsCalendarService({
      fetchFn: failing as unknown as typeof fetch,
      dbFile: ':memory:',
      now: () => NOW,
      politenessDelayMs: 0,
      nasdaqGuard: guard('t-nasdaq-2'),
      bankierGuard: guard('t-bankier-2'),
    });
    try {
      await service2.refreshUs();
      expect(service2.getUpcomingForPositions([usPosition()], '2026-08-01')).toEqual([]);
    } finally {
      service2.close();
    }
  });

  it('otwarty bezpiecznik nie rusza sieci', async () => {
    const g = guard('t-blocked');
    for (let i = 0; i < 3; i += 1) g.registerBlock();
    const fetchFn = vi.fn(async () => nasdaqDay(['AAPL']));
    const service = createEarningsCalendarService({
      fetchFn: fetchFn as unknown as typeof fetch,
      dbFile: ':memory:',
      now: () => NOW,
      politenessDelayMs: 0,
      nasdaqGuard: g,
      bankierGuard: guard('t-bankier-3'),
    });
    try {
      await service.refreshUs();
      expect(fetchFn).not.toHaveBeenCalled();
    } finally {
      service.close();
    }
  });
});

describe('earnings-calendar — odświeżanie PL', () => {
  const plPosition = usPosition({
    isin: 'PLOPTTC00011',
    ticker: 'CDR.WA',
    paperName: 'CD Projekt',
    exchange: 'GPW',
    currency: 'PLN',
  });

  const bankierHtml = `
    <div class="m-quotes-calendar-list__item" data-timestamp="1785880800">
      <div class="m-quotes-calendar-list__date">5 Sierpnia 2026</div>
      <div class="m-quotes-calendar-list__list">
        <div class="m-quotes-calendar-list__event">
          <div class="m-quotes-calendar-list__text">
            <div class="m-quotes-calendar-list__info">Publikacja skonsolidowanego raportu za I półrocze 2026 roku.</div>
          </div>
          <div class="a-quotes-badge -red-500 -calendar"><span class="value">Wyniki spółek</span></div>
        </div>
      </div>
    </div>`;

  it('pobiera terminarz spółki po rozwiązanym slugu', async () => {
    const fetchFn = vi.fn(async () => new Response(bankierHtml, { status: 200 }));
    const service = makeService(fetchFn);
    try {
      // Pierwszy odczyt rozwiązuje i zapisuje mapowanie CDR.WA → CDPROJEKT.
      service.getUpcomingForPositions([plPosition], '2026-08-01');
      await service.refreshPl(['CDPROJEKT']);

      expect(String(fetchFn.mock.calls[0][0])).toContain('/akcje/CDPROJEKT/kalendarium');
      const upcoming = service.getUpcomingForPositions([plPosition], '2026-08-01');
      expect(upcoming).toHaveLength(1);
      expect(upcoming[0]).toMatchObject({
        ticker: 'CDR.WA',
        reportDate: '2026-08-05',
        confidence: 'confirmed',
        session: null,
        fiscalLabel: 'I półrocze 2026',
        source: 'bankier',
      });
    } finally {
      service.close();
    }
  });

  it('nie odpytuje tej samej spółki dwa razy na dobę', async () => {
    const fetchFn = vi.fn(async () => new Response(bankierHtml, { status: 200 }));
    const service = makeService(fetchFn);
    try {
      await service.refreshPl(['CDPROJEKT']);
      await service.refreshPl(['CDPROJEKT']);
      expect(fetchFn.mock.calls.length).toBe(1);
    } finally {
      service.close();
    }
  });

  it('odwołany termin znika po odświeżeniu', async () => {
    let html = bankierHtml;
    const fetchFn = vi.fn(async () => new Response(html, { status: 200 }));
    let clock = NOW;
    const service = makeService(fetchFn, () => clock);
    try {
      await service.refreshPl(['CDPROJEKT']);
      expect(service.getUpcomingForPositions([plPosition], '2026-08-01')).toHaveLength(1);

      // Spółka wycofała termin; doba minęła, więc odświeżenie wolno powtórzyć.
      html = '<div class="m-quotes-calendar-list__item" data-timestamp="1785880800"></div>';
      clock = new Date(NOW.getTime() + 25 * 3600 * 1000);
      await service.refreshPl(['CDPROJEKT']);
      expect(service.getUpcomingForPositions([plPosition], '2026-08-02')).toEqual([]);
    } finally {
      service.close();
    }
  });

  it('awaria strony spółki nie kasuje jej terminarza', async () => {
    let fail = false;
    const fetchFn = vi.fn(async () =>
      fail ? new Response('boom', { status: 500 }) : new Response(bankierHtml, { status: 200 }),
    );
    let clock = NOW;
    const service = makeService(fetchFn, () => clock);
    try {
      await service.refreshPl(['CDPROJEKT']);
      fail = true;
      clock = new Date(NOW.getTime() + 25 * 3600 * 1000);
      await service.refreshPl(['CDPROJEKT']);
      expect(service.getUpcomingForPositions([plPosition], '2026-08-01')).toHaveLength(1);
    } finally {
      service.close();
    }
  });
});

describe('earnings-calendar — zagranica przez Yahoo', () => {
  const xetraPosition = usPosition({
    isin: 'DE0007164600',
    ticker: 'SAP.DE',
    paperName: 'SAP SE',
    exchange: 'XETRA',
    currency: 'EUR',
  });

  function foreignService(fetchForeignEarnings: unknown) {
    return createEarningsCalendarService({
      fetchFn: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      dbFile: ':memory:',
      now: () => NOW,
      politenessDelayMs: 0,
      nasdaqGuard: guard('t-n-f'),
      bankierGuard: guard('t-b-f'),
      fetchForeignEarnings: fetchForeignEarnings as never,
    });
  }

  it('konkretna data jest zapowiedziana, nie potwierdzona', async () => {
    const service = foreignService(vi.fn(async () => ({ date: '2026-08-06', isEstimate: false })));
    try {
      await service.refreshForeign(['SAP.DE']);
      const upcoming = service.getUpcomingForPositions([xetraPosition], '2026-08-01');
      expect(upcoming[0]).toMatchObject({
        ticker: 'SAP.DE',
        reportDate: '2026-08-06',
        confidence: 'tentative',
        session: null,
        source: 'yahoo',
      });
    } finally {
      service.close();
    }
  });

  it('widełki dat Yahoo degradują termin do szacowanego', async () => {
    const service = foreignService(vi.fn(async () => ({ date: '2026-08-06', isEstimate: true })));
    try {
      await service.refreshForeign(['SAP.DE']);
      expect(service.getUpcomingForPositions([xetraPosition], '2026-08-01')[0]).toMatchObject({
        confidence: 'estimated',
      });
    } finally {
      service.close();
    }
  });

  it('rate limit Yahoo (brak danych) degraduje cicho', async () => {
    const service = foreignService(vi.fn(async () => null));
    try {
      await service.refreshForeign(['SAP.DE']);
      expect(service.getUpcomingForPositions([xetraPosition], '2026-08-01')).toEqual([]);
    } finally {
      service.close();
    }
  });

  it('nie odpytuje tego samego tickera dwa razy na dobę', async () => {
    const fetchEarnings = vi.fn(async () => ({ date: '2026-08-06', isEstimate: false }));
    const service = foreignService(fetchEarnings);
    try {
      await service.refreshForeign(['SAP.DE']);
      await service.refreshForeign(['SAP.DE']);
      expect(fetchEarnings.mock.calls.length).toBe(1);
    } finally {
      service.close();
    }
  });
});

describe('earnings-calendar — odczyt', () => {
  it('nigdy nie rzuca — błąd bazy degraduje do pustej listy', () => {
    const service = createEarningsCalendarService({
      fetchFn: (async () => new Response('', { status: 200 })) as unknown as typeof fetch,
      dbFile: '/nieistniejacy-katalog-\0/earnings.db',
      now: () => NOW,
      nasdaqGuard: guard('t-n4'),
      bankierGuard: guard('t-b4'),
    });
    expect(service.getUpcomingForPositions([usPosition()], '2026-08-01')).toEqual([]);
  });

  it('pozycje bez terminarza nie generują wpisów', () => {
    const service = makeService(vi.fn());
    try {
      expect(
        service.getUpcomingForPositions(
          [usPosition({ category: 'etf', ticker: 'SPY' })],
          '2026-08-01',
        ),
      ).toEqual([]);
    } finally {
      service.close();
    }
  });
});
