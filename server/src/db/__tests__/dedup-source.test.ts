import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Transaction } from 'shared';

// DATA_DIR PRZED importem config/connection (czytane przy load) — import dynamiczny.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-dedup-source-'));
process.env.DATA_DIR = tmpDir;

const tx = (source: Transaction['source'], over: Partial<Transaction> = {}): Transaction => ({
  date: '2024-03-01T10:00:00',
  paperName: 'KGHM',
  isin: 'PLKGHM000017',
  quantity: 10,
  side: 'K',
  price: 150,
  value: 1500,
  commission: 3,
  total: 1503,
  currency: 'PLN',
  source,
  ...over,
});

describe('insertTransactionsWithDedup — źródło w kluczu', () => {
  let repo: typeof import('../transactions-repo.js');
  let connection: typeof import('../connection.js');
  const pids: string[] = [];
  const pid = (name: string) => {
    pids.push(name);
    return name;
  };

  beforeAll(async () => {
    repo = await import('../transactions-repo.js');
    connection = await import('../connection.js');
  });

  afterAll(() => {
    for (const p of pids) connection.closeDb(p);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('identyczne zlecenie u DWÓCH brokerów to dwie transakcje', () => {
    const p = pid('dedup-two-brokers');
    expect(repo.insertTransactionsWithDedup([tx('mbank')], p).inserted).toBe(1);
    expect(repo.insertTransactionsWithDedup([tx('bossa')], p).inserted).toBe(1);
    expect(repo.getTransactionsCount(p)).toBe(2);
  });

  it('ten sam broker ponownie → duplikat (nakładające się eksporty)', () => {
    const p = pid('dedup-same-broker');
    repo.insertTransactionsWithDedup([tx('bossa')], p);
    const r = repo.insertTransactionsWithDedup([tx('bossa')], p);
    expect(r.inserted).toBe(0);
    expect(r.duplicates).toHaveLength(1);
  });

  it('generic i manual pasują do każdego źródła (jak przed zmianą klucza)', () => {
    const p = pid('dedup-wildcards');
    repo.insertTransactionsWithDedup([tx('degiro')], p);
    expect(repo.insertTransactionsWithDedup([tx('generic')], p).inserted).toBe(0);
    const p2 = pid('dedup-wildcards-2');
    repo.insertTransactionsWithDedup([tx('manual')], p2);
    expect(repo.insertTransactionsWithDedup([tx('xtb')], p2).inserted).toBe(0);
  });
});
