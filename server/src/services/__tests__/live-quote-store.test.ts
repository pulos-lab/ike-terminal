import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createLiveQuoteStore } from '../live-quote-store.js';

function store(now?: () => Date) {
  return createLiveQuoteStore({ dbFile: ':memory:', ...(now ? { now } : {}) });
}

describe('live-quote-store', () => {
  it('zapisuje i oddaje notowanie', () => {
    const s = store();
    s.upsert([
      {
        ticker: 'AAPL',
        price: 304.81,
        currency: 'USD',
        previousClose: 308.91,
        marketState: 'REGULAR',
        quoteTime: 1_785_786_314_000,
        source: 'yahoo-v7',
      },
    ]);

    const got = s.get('AAPL');
    expect(got).toMatchObject({
      price: 304.81,
      currency: 'USD',
      previousClose: 308.91,
      marketState: 'REGULAR',
    });
    expect(got!.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('kolejny zapis nadpisuje ten sam ticker (bez duplikatów)', () => {
    const s = store();
    s.upsert([{ ticker: 'AAPL', price: 100, currency: 'USD', source: 'yahoo-v7' }]);
    s.upsert([{ ticker: 'AAPL', price: 111, currency: 'USD', source: 'yahoo-v8' }]);
    expect(s.get('AAPL')?.price).toBe(111);
  });

  it('pomija ceny bezsensowne (0, ujemne, NaN)', () => {
    const s = store();
    s.upsert([
      { ticker: 'ZERO', price: 0, currency: 'USD', source: 'x' },
      { ticker: 'NEG', price: -5, currency: 'USD', source: 'x' },
      { ticker: 'NAN', price: Number.NaN, currency: 'USD', source: 'x' },
    ]);
    expect(s.get('ZERO')).toBeNull();
    expect(s.get('NEG')).toBeNull();
    expect(s.get('NAN')).toBeNull();
  });

  it('notowanie starsze niż limit wieku jest niewidoczne', () => {
    // Zegar przesuwany między zapisem a odczytem: notowanie zapisane 10 dni temu,
    // czytane dziś. Bez tego limitu zdelistowany ticker pokazywałby archaiczny
    // kurs jako aktualny — po cichu i bez końca.
    let clock = new Date(Date.now() - 10 * 86_400_000);
    const s = createLiveQuoteStore({ dbFile: ':memory:', now: () => clock });
    s.upsert([{ ticker: 'STALE', price: 42, currency: 'PLN', source: 'x' }]);

    clock = new Date();
    expect(s.get('STALE', 5)).toBeNull();
    expect(s.get('STALE', 30)).not.toBeNull();
  });

  it('getMany oddaje tylko świeże wpisy z listy', () => {
    const s = store();
    s.upsert([
      { ticker: 'A', price: 1, currency: 'USD', source: 'x' },
      { ticker: 'B', price: 2, currency: 'USD', source: 'x' },
    ]);
    const got = s.getMany(['A', 'B', 'C']);
    expect([...got.keys()].sort()).toEqual(['A', 'B']);
  });

  it('NIE dotyka tabeli price_history — historia zostaje serią zamknięć', () => {
    // Ten sam plik bazy, obie tabele obok siebie: zapis notowania live nie może
    // dopisać ani jednego wiersza do historii dziennej (to fałszowałoby TWR).
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE price_history (
      ticker TEXT, date TEXT, close REAL, source TEXT, PRIMARY KEY (ticker, date)
    );`);
    const before = db.prepare('SELECT COUNT(*) AS n FROM price_history').get() as { n: number };

    const s = store();
    s.upsert([{ ticker: 'AAPL', price: 304.81, currency: 'USD', source: 'yahoo-v7' }]);

    const after = db.prepare('SELECT COUNT(*) AS n FROM price_history').get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(after.n).toBe(0);
  });
});
