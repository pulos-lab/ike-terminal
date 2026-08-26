import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-ing-'));
process.env.DATA_DIR = tmpDir;

/**
 * Test integracyjny pełnego przepływu ING: transakcje + DWA pliki historii
 * finansowej (PLN + GBP) w jednej paczce. Weryfikowane end-to-end:
 * - enrichment ISIN po numerze zlecenia (ZKA1→LU2910446546 przez blokadę IPO,
 *   PKNORLEN→PLPKN0000018 przez rozliczenie sprzedaży) + propagacja po tickerze,
 * - syntetyczna S z wykupu przymusowego GBP MIMO braku zakupów w historii,
 * - skip rozliczeń/blokad (bez podwójnego cash), dywidenda netto,
 * - dedup przy ponownym imporcie tych samych plików.
 */

// Pliki ING nie mają nagłówków — czysty join wierszy.
const tx = (rows: string[]) => Buffer.from(rows.join('\r\n'), 'utf-8');
const ops = (rows: string[]) =>
  Buffer.from(rows.map((r, i) => `${i + 1};${r}`).join('\r\n'), 'utf-8');

const TX_ROWS = [
  // Kupno PKNORLEN (blokada niżej niesie ISIN dla tego zlecenia)
  '27-09-2023 09:03:10;847844577;PKNORLEN;Kupno;150;59,40;8 910,00;32.97;8 942,97',
  // Sprzedaż PKNORLEN innym zleceniem — ISIN z rozliczenia sprzedaży
  '25-07-2025 09:11:39;937900176;PKNORLEN;Sprzedaż;78;83,84;6 539,52;24.20;6 515,32',
  // Przydział IPO Żabki pod tickerem PDA ZKA1 (alias → ZABKA) — ISIN z blokady IPO
  '14-10-2024 16:43:07;901072676;ZKA1;Kupno;314;21,50;6 751,00;0.00;6 751,00',
];

const OPS_PLN_ROWS = [
  '24-08-2026;;Saldo końcowe;;0.00;PLN',
  '29-07-2025;Transakcje;Rozliczenie transakcji sprzedaży nr 1128 do zlecenia 937900176, PLPKN0000018, 78 x 83,84;6515.32;6515.32;PLN',
  '20-12-2024;Dywidendy;DVCA Dywidenda pieniężna PLPKN0000018: 105 x 4,15 PLN - rozliczenie;435.75;5701.99;PLN',
  '20-12-2024;Dywidendy;DVCA Dywidenda pieniężna PLPKN0000018: 105 x 4,15 PLN - podatek;-83.00;5618.99;PLN',
  '09-10-2024;Blokady pod zlecenia;Blokada pod zapis na IPO, 901072676, LU2910446546, 3285x21.5;-70627.50;10.54;PLN',
  '27-09-2023;Blokady pod zlecenia;Blokada pod zlecenie kupna 847844577, PLPKN0000018, 150 x 59.4000;-8942.97;0.00;PLN',
  '27-11-2024;Wpłaty/wypłaty;WPL/3977466/Zasilenie rachunku;58000.00;82052.22;PLN',
  '01-07-2023;;Saldo początkowe;;554.50;PLN',
];

const OPS_GBP_ROWS = [
  '24-08-2026;;Saldo końcowe;;1086.12;GBP',
  '19-08-2026;;LAP1 Wykup przymusowy GB00B1YKG049: 360 x 2,35 GBP - rozliczenie;846.00;1086.12;GBP',
  '18-08-2026;Dywidendy;DVCA Dywidenda pieniężna GB00B1YKG049: 360 x 0,15 GBP - rozliczenie;54.00;240.12;GBP',
  '03-07-2019;;Saldo początkowe;;0.00;GBP',
];

const bulkInput = (pid: string) => ({
  transactionsFiles: [{ buffer: tx(TX_ROWS), originalname: 'historiaTransakcji_test.csv' }],
  operationsFiles: [
    { buffer: ops(OPS_PLN_ROWS), originalname: 'historiaFinansowa_test.csv' },
    { buffer: ops(OPS_GBP_ROWS), originalname: 'historiaFinansowa_GBP_test.csv' },
  ],
  portfolioId: pid,
});

describe('bulkImport — ING: transakcje + historia finansowa per waluta', () => {
  let bulkImport: typeof import('../import-service.js').bulkImport;
  let txRepo: typeof import('../../db/transactions-repo.js');
  let opsRepo: typeof import('../../db/operations-repo.js');
  let connection: typeof import('../../db/connection.js');

  beforeAll(async () => {
    ({ bulkImport } = await import('../import-service.js'));
    txRepo = await import('../../db/transactions-repo.js');
    opsRepo = await import('../../db/operations-repo.js');
    connection = await import('../../db/connection.js');
  });

  afterAll(() => {
    connection.closeDb('test-ing');
    connection.closeDb('test-ing-dedup');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('enrichment ISIN, wykup bez zakupów i cash bez dublowania', async () => {
    const PID = 'test-ing';
    const result = await bulkImport(bulkInput(PID));

    expect(result.success).toBe(true);
    expect(result.detectedSource).toBe('ing');
    expect(result.detectedOperationsSource).toBe('ing');
    expect(result.transactionsImported).toBe(3); // syntetyczna S liczy się w syntheticSells

    const txs = txRepo.getAllTransactions(PID);

    // Join po numerze zlecenia: kupno (blokada) i sprzedaż (rozliczenie)
    // PKNORLEN dostały realny ISIN; ZKA1→ZABKA (alias) + ISIN z blokady IPO.
    const pkn = txs.filter((t) => t.paperName === 'PKNORLEN');
    expect(pkn).toHaveLength(2);
    expect(pkn.every((t) => t.isin === 'PLPKN0000018')).toBe(true);
    const zabka = txs.find((t) => t.paperName === 'ZABKA');
    expect(zabka).toMatchObject({ isin: 'LU2910446546', quantity: 314, side: 'K' });

    // Wykup przymusowy GBP: syntetyczna S MIMO braku zakupów (eksport nie sięga
    // nabycia) — gotówka +846 GBP musi wejść; sierotę łapie skrzynka.
    expect(result.syntheticSells).toBe(1);
    const buyout = txs.find((t) => t.isin === 'GB00B1YKG049');
    expect(buyout).toMatchObject({
      side: 'S',
      quantity: 360,
      price: 2.35,
      total: 846,
      currency: 'GBP',
      paymentCurrency: 'GBP',
      source: 'ing',
    });
    expect(buyout?.syntheticOrigin).toContain('Wykup przymusowy');
    expect(result.crossFileWarnings?.some((w) => w.includes('Sprzedaż bez kupna'))).toBe(true);
    expect(result.orphanedSells?.some((o) => o.isin === 'GB00B1YKG049')).toBe(true);

    // Operacje: wpłata PLN + dywidenda PLN netto + dywidenda GBP. Rozliczenia
    // sprzedaży i blokady NIE są księgowane (cash bez dublowania).
    const allOps = opsRepo.getAllOperations(PID);
    expect(allOps).toHaveLength(3);
    expect(allOps.find((o) => o.operationType === 'deposit')?.amount).toBe(58000);
    const dividends = allOps.filter((o) => o.operationType === 'dividend');
    expect(dividends.map((d) => [d.currency, d.amount]).sort()).toEqual([
      ['GBP', 54],
      ['PLN', 352.75],
    ]);
    expect(allOps.some((o) => Math.abs(o.amount) === 6515.32)).toBe(false);
    expect(allOps.some((o) => Math.abs(o.amount) === 70627.5)).toBe(false);
  });

  it('ponowny import tych samych plików = same duplikaty, zero nowych wierszy', async () => {
    const PID = 'test-ing-dedup';
    const first = await bulkImport(bulkInput(PID));
    expect(first.success).toBe(true);
    const txCountAfterFirst = txRepo.getAllTransactions(PID).length;
    const opsCountAfterFirst = opsRepo.getAllOperations(PID).length;

    const second = await bulkImport(bulkInput(PID));
    expect(second.success).toBe(true);
    expect(second.transactionsImported).toBe(0);
    expect(second.operationsImported).toBe(0);
    expect(txRepo.getAllTransactions(PID)).toHaveLength(txCountAfterFirst);
    expect(opsRepo.getAllOperations(PID)).toHaveLength(opsCountAfterFirst);
  });
});
