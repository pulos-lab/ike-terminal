import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Izolowany cache historii w pamięci (realny to SQLite price_history.db).
const store = new Map<string, Array<{ date: string; close: number }>>();
vi.mock('../history-cache.js', () => ({
  loadHistoricalPrices: (t: string, start?: string) =>
    (store.get(t) ?? [])
      .filter((d) => !start || d.date >= start)
      .sort((a, b) => a.date.localeCompare(b.date)),
  storeHistoricalPrices: (t: string, data: Array<{ date: string; close: number }>) => {
    const merged = new Map((store.get(t) ?? []).map((d) => [d.date, d.close] as const));
    for (const d of data) merged.set(d.date, d.close);
    store.set(
      t,
      [...merged.entries()].map(([date, close]) => ({ date, close })),
    );
  },
  getLastCachedDate: (t: string) => {
    const a = store.get(t) ?? [];
    return a.length
      ? a
          .map((d) => d.date)
          .sort()
          .at(-1)!
      : null;
  },
  getFirstCachedDate: (t: string) => {
    const a = store.get(t) ?? [];
    return a.length ? a.map((d) => d.date).sort()[0] : null;
  },
}));

import { parseBiznesradarHistoryTable, fetchBiznesradarHistory } from '../biznesradar.js';

// ── Fixtury tabeli qTableFull ───────────────────────────────────────────────
const HEADER =
  '<tr><th>Data</th><th>Otwarcie</th><th>Max</th><th>Min</th><th>Zamknięcie</th><th>Wolumen</th><th>Obrót</th></tr>';
function tablePage(rows: string[][]): string {
  const body = rows.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('');
  return `<html><body><table class="qTableFull">${HEADER}${body}</table></body></html>`;
}
function makeResp(url: string, html: string, status = 200): Response {
  return { status, ok: status >= 200 && status < 300, url, text: async () => html } as Response;
}

describe('parseBiznesradarHistoryTable', () => {
  it('parsuje NC (PLN) i obligację (% nominału); data DD.MM.YYYY → ISO, kolumna Zamknięcie', () => {
    const html = tablePage([
      ['14.07.2026', '0.515', '0.580', '0.515', '0.565', '235 256', '132 000'],
      ['13.07.2026', '0.500', '0.520', '0.495', '0.510', '100 000', '51 000'],
    ]);
    expect(parseBiznesradarHistoryTable(html)).toEqual([
      { date: '2026-07-14', close: 0.565 },
      { date: '2026-07-13', close: 0.51 },
    ]);
  });

  it('obligacja Catalyst — kurs w % nominału zachowany', () => {
    const html = tablePage([['14.07.2026', '78.95', '79.89', '78.90', '79.89', '1', '79 890']]);
    expect(parseBiznesradarHistoryTable(html)).toEqual([{ date: '2026-07-14', close: 79.89 }]);
  });

  it('pomija nagłówek (th) i wiersze bez poprawnej daty', () => {
    const html = tablePage([
      ['brak daty', '1', '2', '3', '4', '5', '6'],
      ['10.07.2026', '1', '2', '3', '4.5', '5', '6'],
    ]);
    expect(parseBiznesradarHistoryTable(html)).toEqual([{ date: '2026-07-10', close: 4.5 }]);
  });

  it('brak tabeli → pusta lista', () => {
    expect(parseBiznesradarHistoryTable('<html>nic</html>')).toEqual([]);
  });
});

describe('fetchBiznesradarHistory', () => {
  // 3 strony historii NC „EXC" (slug EXCELLENCE), po 3 sesje na stronę
  const PAGES: Record<number, string[][]> = {
    1: [
      ['14.07.2026', '0.5', '0.5', '0.5', '0.565', '1', '1'],
      ['11.07.2026', '0.5', '0.5', '0.5', '0.55', '1', '1'],
      ['10.07.2026', '0.5', '0.5', '0.5', '0.54', '1', '1'],
    ],
    2: [
      ['09.07.2026', '0.5', '0.5', '0.5', '0.53', '1', '1'],
      ['08.07.2026', '0.5', '0.5', '0.5', '0.52', '1', '1'],
      ['07.07.2026', '0.5', '0.5', '0.5', '0.51', '1', '1'],
    ],
    3: [
      ['04.07.2026', '0.5', '0.5', '0.5', '0.50', '1', '1'],
      ['03.07.2026', '0.5', '0.5', '0.5', '0.49', '1', '1'],
      ['02.07.2026', '0.5', '0.5', '0.5', '0.48', '1', '1'],
    ],
  };
  const SLUG = 'EXCELLENCE';
  function serve(url: string): Response {
    // strona 1: żądanie tickerem EXC → redirect na slug EXCELLENCE
    const pageMatch = url.match(/notowania-historyczne\/([^,]+)(?:,(\d+))?/);
    const page = pageMatch?.[2] ? Number(pageMatch[2]) : 1;
    const finalUrl = `https://www.biznesradar.pl/notowania-historyczne/${SLUG}${page > 1 ? ',' + page : ''}`;
    return makeResp(finalUrl, tablePage(PAGES[page] ?? []));
  }

  beforeEach(() => {
    store.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pusty cache: backfill do startDate, zatrzymuje paginację po osiągnięciu granicy', async () => {
    const fetchMock = vi.fn(async (url: string) => serve(url));
    vi.stubGlobal('fetch', fetchMock);

    const data = await fetchBiznesradarHistory('EXC', '2026-07-08');

    // str.1 (oldest 07-10 > 07-08 → dalej), str.2 (oldest 07-07 ≤ 07-08 → stop). Bez str.3.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(data.map((d) => d.date)).toEqual([
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
      '2026-07-14',
    ]);
    expect(data.at(-1)).toEqual({ date: '2026-07-14', close: 0.565 });
  });

  it('paginuje slugiem z finalnego URL (str.1 tickerem, str.2+ slugiem)', async () => {
    const fetchMock = vi.fn(async (url: string) => serve(url));
    vi.stubGlobal('fetch', fetchMock);

    await fetchBiznesradarHistory('EXC', '2026-07-07');

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain('/notowania-historyczne/EXC'); // str.1 tickerem
    expect(urls[1]).toContain('/notowania-historyczne/EXCELLENCE,2'); // str.2 slugiem
  });

  it('świeży cache pokrywający start → zwraca cache, ZERO ruchu sieciowego', async () => {
    const today = new Date().toISOString().split('T')[0];
    // >10 punktów, lastCached=dziś (daysDiff=0), firstCached=2026-01-01 → pokrywa start
    for (let i = 0; i < 12; i++) {
      const d = i === 0 ? today : `2026-01-${String(i).padStart(2, '0')}`;
      store.set('exc', [...(store.get('exc') ?? []), { date: d, close: 0.5 + i / 100 }]);
    }
    const fetchMock = vi.fn(async (url: string) => serve(url));
    vi.stubGlobal('fetch', fetchMock);

    const data = await fetchBiznesradarHistory('EXC', '2026-01-01');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(data.length).toBe(12);
  });

  it('zapisuje pobrane dane do cache pod kluczem = ticker lowercase', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => serve(url)),
    );
    await fetchBiznesradarHistory('EXC', '2026-07-10');
    expect((store.get('exc') ?? []).length).toBeGreaterThan(0);
  });

  it('blokada (429) → break + bezpiecznik; oddaje to, co w cache', async () => {
    store.set('exc', [{ date: '2026-06-01', close: 0.4 }]);
    const fetchMock = vi.fn(async () => makeResp('https://x', 'rate limited', 429));
    vi.stubGlobal('fetch', fetchMock);

    const data = await fetchBiznesradarHistory('EXC', '2026-01-01');

    expect(fetchMock).toHaveBeenCalledTimes(1); // break po pierwszej blokadzie
    expect(data).toEqual([{ date: '2026-06-01', close: 0.4 }]); // cache
  });
});
