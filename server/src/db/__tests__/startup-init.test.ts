import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-startup-init-'));
process.env.DATA_DIR = tmpDir;

// Symulacja incydentu 2026-07-23: baza JEDNEGO portfela niezapisywalna
// (SQLITE_READONLY) nie może wywalić inicjalizacji pozostałych. Mock rzuca
// dla wskazanych portfeli, dla reszty deleguje do prawdziwej implementacji.
vi.mock('../ticker-map-repo.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ticker-map-repo.js')>();
  const readonlyError = () => {
    const err = new Error('attempt to write a readonly database') as Error & { code: string };
    err.code = 'SQLITE_READONLY';
    return err;
  };
  return {
    ...actual,
    seedTickerMap: (portfolioId?: string) => {
      if (portfolioId === 'p-broken-seed') throw readonlyError();
      return actual.seedTickerMap(portfolioId);
    },
    migrateGpwToYahoo: (portfolioId: string) => {
      if (portfolioId === 'p-broken-migrate') throw readonlyError();
      return actual.migrateGpwToYahoo(portfolioId);
    },
  };
});

describe('startup-init — guard per portfel przy inicjalizacji baz', () => {
  let connection: typeof import('../connection.js');
  let result: import('../startup-init.js').StartupInitResult;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    // Rejestr z zepsutymi portfelami W ŚRODKU listy — dowód, że pętla idzie dalej
    const now = new Date().toISOString();
    const portfolios = ['p-ok-1', 'p-broken-seed', 'p-broken-migrate', 'p-ok-2'].map((id) => ({
      id,
      name: id,
      createdAt: now,
      settings: {},
    }));
    fs.writeFileSync(path.join(tmpDir, 'portfolios.json'), JSON.stringify(portfolios, null, 2));

    connection = await import('../connection.js');
    const { initAllPortfolioDbs } = await import('../startup-init.js');

    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    result = initAllPortfolioDbs();
  });

  afterAll(() => {
    errorSpy.mockRestore();
    connection.closeDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('nie rzuca i inicjalizuje pozostałe portfele mimo błędu jednego z nich', () => {
    expect(result.ok).toEqual(['p-ok-1', 'p-ok-2']);
  });

  it('raportuje pominięte portfele z kodem błędu', () => {
    expect(result.failed.map((f) => f.id)).toEqual(['p-broken-seed', 'p-broken-migrate']);
    expect(result.failed.every((f) => f.code === 'SQLITE_READONLY')).toBe(true);
  });

  it('loguje błąd z id portfela i kodem', () => {
    const logged = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((m) => m.includes('p-broken-seed') && m.includes('SQLITE_READONLY'))).toBe(
      true,
    );
    expect(
      logged.some((m) => m.includes('p-broken-migrate') && m.includes('SQLITE_READONLY')),
    ).toBe(true);
  });

  it('zdrowe portfele mają zainicjalizowany schemat (ticker_map istnieje)', () => {
    // TICKER_MAP w shared jest pusta (seed idzie z importów), więc dowodem
    // inicjalizacji jest istniejąca tabela, nie liczba wierszy.
    for (const id of ['p-ok-1', 'p-ok-2']) {
      const row = connection.getDb(id).prepare('SELECT COUNT(*) AS c FROM ticker_map').get() as {
        c: number;
      };
      expect(row.c).toBeGreaterThanOrEqual(0);
    }
  });

  it('nie zostawia w cache połączenia do zepsutej bazy (świeży getDb po naprawie)', () => {
    // Po błędzie guard zamyka połączenie; kolejne getDb otwiera je od nowa —
    // pośrednio: getDb nie rzuca i zwraca działające połączenie do zapisu.
    const db = connection.getDb('p-broken-seed');
    expect(db.prepare('SELECT COUNT(*) AS c FROM ticker_map').get()).toBeDefined();
  });
});
