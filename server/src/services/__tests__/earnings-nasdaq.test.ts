import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  parseNasdaqEarningsDay,
  parseNasdaqEps,
  formatFiscalLabel,
  mapNasdaqTime,
  fetchNasdaqWindow,
} from '../earnings/nasdaq-earnings.js';
import { createSourceGuard, createMemoryGuardStore } from '../source-guard.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(dir, 'fixtures', 'nasdaq-earnings-day.json'), 'utf-8'),
);

function guard() {
  return createSourceGuard({ name: 'test-nasdaq', store: createMemoryGuardStore() });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('mapNasdaqTime', () => {
  it('podana pora sesji oznacza termin potwierdzony przez spółkę', () => {
    expect(mapNasdaqTime('time-pre-market')).toEqual({ session: 'bmo', confidence: 'confirmed' });
    expect(mapNasdaqTime('time-after-hours')).toEqual({ session: 'amc', confidence: 'confirmed' });
  });

  it('brak pory degraduje termin do zapowiedzianego', () => {
    expect(mapNasdaqTime('time-not-supplied')).toEqual({
      session: 'unknown',
      confidence: 'tentative',
    });
    expect(mapNasdaqTime(undefined)).toEqual({ session: 'unknown', confidence: 'tentative' });
  });
});

describe('parseNasdaqEps', () => {
  it('czyta prognozę EPS w zapisie walutowym i księgowym', () => {
    expect(parseNasdaqEps('$6.71')).toBe(6.71);
    expect(parseNasdaqEps('($0.12)')).toBe(-0.12);
    expect(parseNasdaqEps('$1,234.50')).toBe(1234.5);
  });

  it('brak prognozy to null, nie zero', () => {
    expect(parseNasdaqEps('')).toBeNull();
    expect(parseNasdaqEps('N/A')).toBeNull();
    expect(parseNasdaqEps(undefined)).toBeNull();
  });
});

describe('formatFiscalLabel', () => {
  it('numeruje kwartał po miesiącu jego zakończenia', () => {
    expect(formatFiscalLabel('Mar/2026')).toBe('Q1 26');
    expect(formatFiscalLabel('Jun/2026')).toBe('Q2 26');
    expect(formatFiscalLabel('Sep/2026')).toBe('Q3 26');
    expect(formatFiscalLabel('Dec/2025')).toBe('Q4 25');
  });

  it('miesiąc spoza końca kwartału trafia do swojego kwartału kalendarzowego', () => {
    // Spółki z przesuniętym rokiem obrotowym kończą kwartał w środku kwartału
    // kalendarzowego — numerujemy po kalendarzu, nie po ich własnej numeracji.
    expect(formatFiscalLabel('Jan/2026')).toBe('Q1 26');
    expect(formatFiscalLabel('Aug/2026')).toBe('Q3 26');
  });

  it('nieznany format oddaje surowo, pusty jako null', () => {
    expect(formatFiscalLabel('FY2026')).toBe('FY2026');
    expect(formatFiscalLabel('')).toBeNull();
    expect(formatFiscalLabel(null)).toBeNull();
  });
});

describe('parseNasdaqEarningsDay', () => {
  it('mapuje realną odpowiedź na wiersze terminarza', () => {
    const rows = parseNasdaqEarningsDay(fixture, '2026-08-05');
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      market: 'US',
      symbolKey: 'LLY',
      reportDate: '2026-08-05',
      session: 'bmo',
      confidence: 'confirmed',
      source: 'nasdaq',
      epsForecast: 6.71,
    });
    // ADR spółki zagranicznej bez podanej pory.
    expect(rows.find((r) => r.symbolKey === 'NVO')).toMatchObject({
      session: 'unknown',
      confidence: 'tentative',
    });
    expect(rows.find((r) => r.symbolKey === 'WDC')).toMatchObject({ session: 'amc' });
  });

  it('weekend/święto (rows: null) to pusta lista, nie błąd', () => {
    expect(parseNasdaqEarningsDay({ data: { rows: null } }, '2026-08-08')).toEqual([]);
    expect(parseNasdaqEarningsDay({}, '2026-08-08')).toEqual([]);
    expect(parseNasdaqEarningsDay(null, '2026-08-08')).toEqual([]);
  });

  it('pomija wiersze bez symbolu i duplikaty', () => {
    const rows = parseNasdaqEarningsDay(
      { data: { rows: [{ symbol: 'AAPL' }, { symbol: 'AAPL' }, { symbol: '' }, {}] } },
      '2026-08-05',
    );
    expect(rows.map((r) => r.symbolKey)).toEqual(['AAPL']);
  });
});

describe('fetchNasdaqWindow', () => {
  it('zamiata kolejne dni i scala wyniki', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const date = String(url).split('date=')[1];
      return jsonResponse({
        data: { rows: [{ symbol: `SYM${date.slice(-2)}`, time: 'time-pre-market' }] },
      });
    });
    const result = await fetchNasdaqWindow(['2026-08-05', '2026-08-06'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      politenessDelayMs: 0,
    });
    expect(result.complete).toBe(true);
    expect(result.fetchedDays).toBe(2);
    expect(result.rows.map((r) => r.symbolKey)).toEqual(['SYM05', 'SYM06']);
  });

  it('padnięty dzień oznacza zamiatanie jako niekompletne', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('2026-08-06')
        ? jsonResponse({}, 500)
        : jsonResponse({ data: { rows: [{ symbol: 'AAPL', time: 'time-after-hours' }] } }),
    );
    const result = await fetchNasdaqWindow(['2026-08-05', '2026-08-06'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      politenessDelayMs: 0,
    });
    expect(result.complete).toBe(false);
    expect(result.rows).toHaveLength(1);
  });

  it('blokada anti-bot otwiera bezpiecznik i przerywa zamiatanie', async () => {
    const g = guard();
    const fetchFn = vi.fn(async () => new Response('Access Denied', { status: 403 }));
    const result = await fetchNasdaqWindow(
      ['2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08'],
      { fetchFn: fetchFn as unknown as typeof fetch, guard: g, politenessDelayMs: 0 },
    );
    expect(result.complete).toBe(false);
    expect(g.getState().blocked).toBe(true);
    // Po otwarciu bezpiecznika (3 blokady) dalsze dni nie ruszają sieci.
    expect(fetchFn.mock.calls.length).toBeLessThan(4);
  });

  it('otwarty bezpiecznik oznacza zero requestów', async () => {
    const g = guard();
    for (let i = 0; i < 3; i += 1) g.registerBlock();
    const fetchFn = vi.fn(async () => jsonResponse({ data: { rows: [] } }));
    const result = await fetchNasdaqWindow(['2026-08-05'], {
      fetchFn: fetchFn as unknown as typeof fetch,
      guard: g,
      politenessDelayMs: 0,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.complete).toBe(false);
  });
});
