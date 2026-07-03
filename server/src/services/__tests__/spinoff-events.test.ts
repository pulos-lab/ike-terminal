import { describe, it, expect, vi } from 'vitest';
import {
  parseUsDate,
  parseSpinoffRatio,
  parseSpinoffParentTicker,
  parseStockanalysisSpinoffs,
  createSpinoffEventsService,
} from '../spinoff-events.js';

// Fixture kontraktujący parser: tabela [Date | Symbol | Company Name] w formacie
// stron akcji stockanalysis.com. Wiersze 3-5 są celowo niejednoznaczne
// (brak tickera rodzica / brak ratio) — muszą zostać POMINIĘTE, nie zgadnięte.
const FIXTURE_HTML = `
<html><body>
<main>
<table>
  <thead>
    <tr><th>Date</th><th>Symbol</th><th>Company Name</th></tr>
  </thead>
  <tbody>
    <tr>
      <td>Jul 1, 2026</td><td>MBGL</td>
      <td>Mobility Global Inc., spun off from S&amp;P Global (SPGI), 1 share of MBGL for every 1 share of SPGI held</td>
    </tr>
    <tr>
      <td>Apr 17, 2026</td><td>CQNT</td>
      <td>Creotech Quantum, spun off from CRI, distribution ratio of 1:4</td>
    </tr>
    <tr>
      <td>Mar 5, 2026</td><td>XYZ</td>
      <td>XYZ Corp, spun off from Some Parent Company, 1 share for every 2 shares</td>
    </tr>
    <tr>
      <td>Feb 2, 2026</td><td>NORAT</td>
      <td>NoRatio Inc., spun off from Parent Co (PRNT)</td>
    </tr>
    <tr>
      <td>Jan 1, 1999</td><td>OLD</td>
      <td>Ancient Corp, spun off from OLDP, 1 share for every 1 share</td>
    </tr>
  </tbody>
</table>
</main>
</body></html>`;

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

describe('parseSpinoffRatio', () => {
  it('wzorce "for every" / "ratio of X:Y" / "X-for-Y"', () => {
    expect(parseSpinoffRatio('1 share of MBGL for every 1 share of SPGI held')).toBe(1);
    expect(parseSpinoffRatio('one share for each share held')).toBe(1);
    expect(parseSpinoffRatio('1 share for every 4 shares')).toBe(0.25);
    expect(parseSpinoffRatio('distribution ratio of 1:4')).toBe(0.25);
    expect(parseSpinoffRatio('2-for-1 distribution')).toBe(2);
  });

  it('brak jednoznacznego wzorca → null (nie zgadujemy)', () => {
    expect(parseSpinoffRatio('will spin off its mobility unit')).toBeNull();
    expect(parseSpinoffRatio('')).toBeNull();
  });
});

describe('parseSpinoffParentTicker', () => {
  it('ticker w nawiasie po nazwie lub goły ticker', () => {
    expect(parseSpinoffParentTicker('spun off from S&P Global (SPGI), 1 share')).toBe('SPGI');
    expect(parseSpinoffParentTicker('spun off from CRI, ratio of 1:4')).toBe('CRI');
  });

  it('sama nazwa spółki (bez tickera) → null', () => {
    expect(parseSpinoffParentTicker('spun off from Some Parent Company, 1 share')).toBeNull();
  });
});

describe('parseStockanalysisSpinoffs', () => {
  it('wyciąga tylko jednoznaczne wiersze; niejednoznaczne i przeterminowane pomija', () => {
    const { events, skipped } = parseStockanalysisSpinoffs(FIXTURE_HTML, NOW);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      parentTicker: 'SPGI',
      childTicker: 'MBGL',
      exDate: '2026-07-01',
      ratio: 1,
    });
    expect(events[1]).toMatchObject({
      parentTicker: 'CRI',
      childTicker: 'CQNT',
      exDate: '2026-04-17',
      ratio: 0.25,
    });
    // XYZ (rodzic bez tickera) + NORAT (bez ratio) + OLD (rok 1999 poza oknem)
    expect(skipped).toBe(3);
  });

  it('brak tabeli / pusty HTML → zero zdarzeń, zero wyjątków', () => {
    expect(parseStockanalysisSpinoffs('<html><body></body></html>', NOW)).toEqual({
      events: [],
      skipped: 0,
    });
  });
});

describe('createSpinoffEventsService', () => {
  it('refresh zapisuje zdarzenia, getEvents zwraca kandydatów; kolejne wywołanie bez sieci', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(FIXTURE_HTML, { status: 200 })) as unknown as typeof fetch;
    const service = createSpinoffEventsService({ fetchFn, dbFile: ':memory:', now: () => NOW });

    const events = await service.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0].parentTicker).toBe('SPGI');
    expect(events[0].childTicker).toBe('MBGL');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Świeże dane (last_success < 24h) → bez kolejnego strzału
    await service.getEvents();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    service.close();
  });

  it('awaria źródła: stare wiersze zostają, retry dopiero po godzinie', async () => {
    let fail = false;
    const fetchFn = vi.fn().mockImplementation(async () => {
      if (fail) throw new Error('network down');
      return new Response(FIXTURE_HTML, { status: 200 });
    }) as unknown as typeof fetch;

    let clock = NOW.getTime();
    const service = createSpinoffEventsService({
      fetchFn,
      dbFile: ':memory:',
      now: () => new Date(clock),
    });

    await service.getEvents(); // sukces → 2 zdarzenia
    fail = true;
    clock += 25 * 60 * 60 * 1000; // dane stały się stale (>24h)

    const events = await service.getEvents(); // refresh pada → stare wiersze
    expect(events).toHaveLength(2);
    const callsAfterFail = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length;

    await service.getEvents(); // <1h od porażki → bez kolejnej próby
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFail);

    clock += 2 * 60 * 60 * 1000; // >1h → wolno spróbować ponownie
    fail = false;
    await service.getEvents();
    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFail + 1);
    service.close();
  });
});
