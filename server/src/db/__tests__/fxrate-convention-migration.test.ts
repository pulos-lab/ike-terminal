import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../schema.js';

/** Wiersz DEGIRO w starej konwencji fx_rate (quote per payment, surowy "Kurs wymiany"). */
function insertTx(
  db: InstanceType<typeof Database>,
  opts: { currency: string; fxRate: number | null; source?: string },
): number {
  const r = db
    .prepare(
      `INSERT INTO transactions
         (date, paper_name, isin, quantity, side, price, value, commission, total,
          currency, payment_currency, fx_rate, source)
       VALUES ('2024-03-27T11:41:00', 'X', 'PL0000000001', 10, 'K', 10, 100, 0, 100,
               ?, 'EUR', ?, ?)`,
    )
    .run(opts.currency, opts.fxRate, opts.source ?? 'degiro');
  return Number(r.lastInsertRowid);
}

function fxOf(db: InstanceType<typeof Database>, id: number): number | null {
  return (db.prepare('SELECT fx_rate FROM transactions WHERE id = ?').get(id) as any).fx_rate;
}

describe('migracja fxrate_convention_a_done — inwersja kursów DEGIRO', () => {
  it('odwraca stare kursy DEGIRO (PLN 1/x, GBP 100/x), nie tyka innych źródeł ani NULL', () => {
    const db = new Database(':memory:');
    initSchema(db); // świeża baza — flaga ustawiona, brak danych do inwersji
    // Symulacja bazy sprzed migracji: stare wiersze + brak flagi
    db.prepare('DELETE FROM portfolio_metadata WHERE key = ?').run('fxrate_convention_a_done');
    const pln = insertTx(db, { currency: 'PLN', fxRate: 4.3127 });
    const gbp = insertTx(db, { currency: 'GBP', fxRate: 87.0405 }); // GBX-per-EUR z pliku
    const noFx = insertTx(db, { currency: 'EUR', fxRate: null });
    const xtb = insertTx(db, { currency: 'PLN', fxRate: 4.3127, source: 'xtb' });

    initSchema(db);

    expect(fxOf(db, pln)).toBeCloseTo(1 / 4.3127, 10);
    expect(fxOf(db, gbp)).toBeCloseTo(100 / 87.0405, 10);
    expect(fxOf(db, noFx)).toBeNull();
    expect(fxOf(db, xtb)).toBe(4.3127); // tylko source='degiro'
    db.close();
  });

  it('jest jednorazowa — ponowny initSchema nie odwraca drugi raz', () => {
    const db = new Database(':memory:');
    initSchema(db);
    db.prepare('DELETE FROM portfolio_metadata WHERE key = ?').run('fxrate_convention_a_done');
    const pln = insertTx(db, { currency: 'PLN', fxRate: 4.3127 });

    initSchema(db);
    const after = fxOf(db, pln);
    initSchema(db);

    expect(fxOf(db, pln)).toBe(after);
    expect(after).toBeCloseTo(1 / 4.3127, 10);
    db.close();
  });
});
