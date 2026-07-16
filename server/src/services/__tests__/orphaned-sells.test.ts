import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Transaction } from 'shared';

// DATA_DIR przed importem modułów dotykających config/connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-orphaned-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-orphaned-sells';

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    date: '2026-04-17T09:23:11',
    paperName: 'S2B.WA',
    isin: 'S2B.WA',
    quantity: 12,
    side: 'S',
    price: 10,
    value: 120,
    commission: 0,
    total: 120,
    currency: 'PLN',
    source: 'xtb',
    ...overrides,
  };
}

describe('orphaned-sells', () => {
  let svc: typeof import('../orphaned-sells.js');
  let repo: typeof import('../../db/orphaned-sells-repo.js');
  let txRepo: typeof import('../../db/transactions-repo.js');
  let splitsRepo: typeof import('../../db/splits-repo.js');
  let spinOffsRepo: typeof import('../../db/spin-offs-repo.js');
  let connection: typeof import('../../db/connection.js');

  beforeAll(async () => {
    svc = await import('../orphaned-sells.js');
    repo = await import('../../db/orphaned-sells-repo.js');
    txRepo = await import('../../db/transactions-repo.js');
    splitsRepo = await import('../../db/splits-repo.js');
    spinOffsRepo = await import('../../db/spin-offs-repo.js');
    connection = await import('../../db/connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    txRepo.clearTransactions(PID);
    repo.clearOrphanDismissals(PID);
    const db = connection.getDb(PID);
    db.prepare('DELETE FROM stock_splits').run();
    db.prepare('DELETE FROM spin_offs').run();
  });

  it('sprzedaż bez kupna trafia do pending; kupno domykające usuwa detekcję', () => {
    txRepo.insertTransactions([tx()], PID);
    let view = svc.getOrphanedSellsView(PID);
    expect(view.pending).toHaveLength(1);
    expect(view.pending[0]).toMatchObject({
      isin: 'S2B.WA',
      missingQuantity: 12,
      currency: 'PLN',
    });
    expect(view.dismissed).toHaveLength(0);

    // Kupno spin-off (cena 0) dzień przed sprzedażą — detekcja znika sama
    txRepo.insertTransactions(
      [tx({ side: 'K', date: '2026-04-16', price: 0, value: 0, total: 0 })],
      PID,
    );
    view = svc.getOrphanedSellsView(PID);
    expect(view.pending).toHaveLength(0);
    expect(view.dismissed).toHaveLength(0);
  });

  it('"Ignoruj" przenosi do dismissed; "Przywróć" cofa; wzrost brakującej ilości przywraca do pending', () => {
    txRepo.insertTransactions([tx()], PID);
    repo.dismissOrphanedSell('S2B.WA', 12, PID);

    let view = svc.getOrphanedSellsView(PID);
    expect(view.pending).toHaveLength(0);
    expect(view.dismissed).toHaveLength(1);

    // Kolejny import powiększa sierotę → decyzja przestaje obowiązywać
    txRepo.insertTransactions([tx({ quantity: 5, date: '2026-05-04T10:00:00' })], PID);
    view = svc.getOrphanedSellsView(PID);
    expect(view.pending).toHaveLength(1);
    expect(view.pending[0].missingQuantity).toBe(17);
    expect(view.dismissed).toHaveLength(0);

    // Ponowne "Ignoruj" z nową ilością, potem "Przywróć"
    repo.dismissOrphanedSell('S2B.WA', 17, PID);
    expect(svc.getOrphanedSellsView(PID).dismissed).toHaveLength(1);
    expect(repo.restoreOrphanedSell('S2B.WA', PID)).toBe(true);
    expect(svc.getOrphanedSellsView(PID).pending).toHaveLength(1);
  });

  it('ISIN ze splitem w bazie jest wykluczony (fałszywy alarm: sprzedaż po splicie > kupno sprzed)', () => {
    // 10 kupione, split 20:1, 200 sprzedane — surowe sumy: sold 200 > bought 10
    txRepo.insertTransactions(
      [
        tx({ side: 'K', quantity: 10, date: '2021-01-05T10:00:00' }),
        tx({ side: 'S', quantity: 200, date: '2022-06-01T10:00:00' }),
      ],
      PID,
    );
    expect(svc.getOrphanedSellsView(PID).pending).toHaveLength(1);

    splitsRepo.upsertSplits(PID, [
      { isin: 'S2B.WA', ticker: 'S2B', splitDate: '2021-07-02', ratio: 20, source: 'manual' },
    ]);
    const view = svc.getOrphanedSellsView(PID);
    expect(view.pending).toHaveLength(0);
    expect(view.dismissed).toHaveLength(0);
  });

  it('dziecko ZAAPLIKOWANEGO spin-offu jest wykluczone (pozycję tworzy syntetyk); reverted przywraca detekcję', () => {
    // Sprzedaż dziecka spin-offu bez kupna w bazie — syntetyczny zakup jest
    // compute-time i nie trafia do tabeli transactions.
    txRepo.insertTransactions([tx({ isin: 'AUTO_MBGL', paperName: 'MBGL' })], PID);
    expect(svc.getOrphanedSellsView(PID).pending).toHaveLength(1);

    spinOffsRepo.insertSpinOff(PID, {
      parentIsin: 'US78409V1044',
      parentTicker: 'SPGI',
      childIsin: 'AUTO_MBGL',
      childTicker: 'MBGL',
      childName: 'Mobility Global',
      exDate: '2026-04-01',
      ratio: 1,
      allocationPct: 0.08,
      childQty: 12,
      currency: 'USD',
      status: 'applied',
      source: 'map',
    });
    let view = svc.getOrphanedSellsView(PID);
    expect(view.pending).toHaveLength(0);
    expect(view.dismissed).toHaveLength(0);

    // Tombstone (reverted) = syntetyka nie ma → decyzja wraca do użytkownika
    const row = spinOffsRepo.getSpinOffs(PID)[0];
    spinOffsRepo.updateSpinOffStatus(PID, row.id!, 'reverted');
    view = svc.getOrphanedSellsView(PID);
    expect(view.pending).toHaveLength(1);
  });

  it('spin-off skipped_broker NIE filtruje detekcji (syntetyka nie ma, realne wiersze są niekompletne)', () => {
    txRepo.insertTransactions([tx({ isin: 'AUTO_MBGL', paperName: 'MBGL' })], PID);
    spinOffsRepo.insertSpinOff(PID, {
      parentIsin: 'US78409V1044',
      parentTicker: 'SPGI',
      childIsin: 'AUTO_MBGL',
      childTicker: 'MBGL',
      childName: 'Mobility Global',
      exDate: '2026-04-01',
      ratio: 1,
      allocationPct: 0,
      childQty: 12,
      currency: 'USD',
      status: 'skipped_broker',
      source: 'map',
    });
    expect(svc.getOrphanedSellsView(PID).pending).toHaveLength(1);
  });

  it('clearOrphanDismissals usuwa decyzje (kaskada /api/import/clear)', () => {
    repo.dismissOrphanedSell('A', 1, PID);
    repo.dismissOrphanedSell('B', 2, PID);
    expect(repo.listOrphanDismissals(PID)).toHaveLength(2);
    expect(repo.clearOrphanDismissals(PID)).toBe(2);
    expect(repo.listOrphanDismissals(PID)).toHaveLength(0);
  });
});
