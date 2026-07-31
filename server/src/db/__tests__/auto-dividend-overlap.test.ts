import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CashOperation } from 'shared';

// DATA_DIR musi być ustawiony PRZED importem config/connection (czytane przy load)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-overlap-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-overlap';

const autoDividend = (date: string, ticker: string, amount: number): CashOperation => ({
  date,
  operationType: 'dividend',
  description: `Dywidenda ${ticker}`,
  amount,
  currency: 'PLN',
  ticker,
  source: 'auto-yahoo',
});

describe('findAutoDividendOverlaps — wykrywanie, nie kasowanie', () => {
  let opRepo: typeof import('../operations-repo.js');
  let connection: typeof import('../connection.js');

  beforeAll(async () => {
    opRepo = await import('../operations-repo.js');
    connection = await import('../connection.js');
    opRepo.insertOperation(autoDividend('2026-05-14', 'ASB.WA', 1033.72), PID);
    opRepo.insertOperation(autoDividend('2026-01-10', 'PZU.WA', 400), PID);
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('zgłasza parę, gdy dywidenda brokera trafia w okno szacunku skanera', () => {
    const broker: CashOperation = {
      date: '2026-05-28T00:00:00',
      operationType: 'dividend',
      description: 'Dywidenda z wyciągu',
      amount: 837.31,
      currency: 'PLN',
      ticker: 'ASB.WA',
      source: 'bossa',
    };

    const overlaps = opRepo.findAutoDividendOverlaps(PID, [broker]);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].ticker).toBe('ASB.WA');
    expect(overlaps[0].autoAmount).toBe(1033.72);
  });

  it('dopasowuje ticker bez sufiksu giełdy (Bossa „ASB" vs Yahoo „ASB.WA")', () => {
    const broker: CashOperation = {
      date: '2026-05-20',
      operationType: 'dividend',
      description: 'Dywidenda',
      amount: 800,
      currency: 'PLN',
      ticker: 'ASB.WA',
      source: 'mbank',
    };
    expect(opRepo.findAutoDividendOverlaps(PID, [broker])).toHaveLength(1);
  });

  it('NIC nie usuwa — oba wpisy zostają w bazie', () => {
    const before = opRepo.getAllOperations(PID).length;
    opRepo.findAutoDividendOverlaps(PID, [
      {
        date: '2026-05-28',
        operationType: 'dividend',
        description: 'x',
        amount: 1,
        currency: 'PLN',
        ticker: 'ASB.WA',
        source: 'bossa',
      },
    ]);
    expect(opRepo.getAllOperations(PID)).toHaveLength(before);
  });

  it('poza oknem 30 dni nie zgłasza nic', () => {
    const broker: CashOperation = {
      date: '2026-08-01',
      operationType: 'dividend',
      description: 'Dywidenda',
      amount: 900,
      currency: 'PLN',
      ticker: 'ASB.WA',
      source: 'bossa',
    };
    expect(opRepo.findAutoDividendOverlaps(PID, [broker])).toHaveLength(0);
  });

  it('inny papier w tym samym oknie nie jest parą', () => {
    const broker: CashOperation = {
      date: '2026-05-20',
      operationType: 'dividend',
      description: 'Dywidenda',
      amount: 100,
      currency: 'PLN',
      ticker: 'KGH.WA',
      source: 'bossa',
    };
    expect(opRepo.findAutoDividendOverlaps(PID, [broker])).toHaveLength(0);
  });

  it('operacje bez tickera i nie-dywidendy są ignorowane', () => {
    const ops: CashOperation[] = [
      {
        date: '2026-05-20',
        operationType: 'deposit',
        description: 'Wpłata',
        amount: 1000,
        currency: 'PLN',
        source: 'bossa',
      },
      {
        date: '2026-05-20',
        operationType: 'dividend',
        description: 'Bez tickera',
        amount: 10,
        currency: 'PLN',
        source: 'bossa',
      },
    ];
    expect(opRepo.findAutoDividendOverlaps(PID, ops)).toHaveLength(0);
  });
});
