import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TickerMapEntry } from 'shared';

// DATA_DIR PRZED (dynamicznym) importem modułów dotykających config/connection.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-classification-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-classification-backfill';

/** Stan z audytu 2026-11-06: TSM rozpoznany (NYSE, USD), kraj po stubie GPW. */
const TSM_STALE: TickerMapEntry = {
  isin: 'US8740391003',
  ticker: 'TSM',
  name: 'Taiwan Semiconductor Manufacturing Company Limited',
  exchange: 'NYSE',
  currency: 'USD',
  priceSource: 'yahoo',
  sector: 'Informatyka',
  supersector: 'Technologie',
  country: 'Poland',
};

describe('classification-backfill', () => {
  let mod: typeof import('../classification-backfill.js');
  let repo: typeof import('../../db/ticker-map-repo.js');
  let connection: typeof import('../../db/connection.js');

  beforeAll(async () => {
    mod = await import('../classification-backfill.js');
    repo = await import('../../db/ticker-map-repo.js');
    connection = await import('../../db/connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    connection.getDb(PID).prepare('DELETE FROM ticker_map').run();
  });

  describe('hasStalePolishCountry', () => {
    it('„Poland" na papierze z NYSE w USD = ślad po stubie', () => {
      expect(mod.hasStalePolishCountry(TSM_STALE)).toBe(true);
    });

    it('polskie papiery i papiery w PLN nie są podejrzane', () => {
      const gpw = { ...TSM_STALE, ticker: 'PKO.WA', exchange: 'GPW' as const, currency: 'PLN' };
      expect(mod.hasStalePolishCountry(gpw)).toBe(false);
      expect(mod.hasStalePolishCountry({ ...TSM_STALE, currency: 'PLN' })).toBe(false);
      expect(mod.hasStalePolishCountry({ ...TSM_STALE, ticker: 'XYZ.WA' })).toBe(false);
      expect(mod.hasStalePolishCountry({ ...TSM_STALE, country: 'Taiwan' })).toBe(false);
    });

    it('wpis z kompletną klasyfikacją wraca do backfillu tylko przez ślad po stubie', () => {
      expect(mod.needsClassificationBackfill(TSM_STALE)).toBe(true);
      expect(mod.needsClassificationBackfill({ ...TSM_STALE, country: 'Taiwan' })).toBe(false);
      expect(mod.needsClassificationBackfill({ ...TSM_STALE, isin: 'OPT:TSM' })).toBe(false);
    });
  });

  describe('applyClassificationBackfill', () => {
    it('poprawia kraj TSM z „Poland" na wynik z Yahoo', () => {
      repo.upsertTickerMapEntry(TSM_STALE, PID);
      const touched = mod.applyClassificationBackfill(
        TSM_STALE,
        { supersector: 'Technologie', subsector: 'Informatyka', country: 'Taiwan' },
        PID,
      );
      expect(touched).toBe(true);
      expect(repo.getTickerByIsin(TSM_STALE.isin, PID)?.country).toBe('Taiwan');
    });

    it('wyścig: wynik policzony dla stuba NIE nadpisuje wpisu przepisanego w międzyczasie', () => {
      // Kopia, na której backfill liczył: prowizoryczny stub z giełdą GPW, bez kraju.
      const stub: TickerMapEntry = {
        isin: TSM_STALE.isin,
        ticker: 'Taiwan Semi.Manufa.Ltd ADR',
        name: 'Taiwan Semi.Manufa.Ltd ADR',
        exchange: 'GPW',
        currency: 'PLN',
        priceSource: 'stooq',
      };
      // W bazie już wpis po samonaprawie (NYSE, kraj z Yahoo).
      repo.upsertTickerMapEntry({ ...TSM_STALE, country: 'Taiwan' }, PID);

      const touched = mod.applyClassificationBackfill(
        stub,
        { supersector: null, subsector: null, country: 'Poland' },
        PID,
      );

      expect(touched).toBe(false);
      expect(repo.getTickerByIsin(TSM_STALE.isin, PID)?.country).toBe('Taiwan');
    });

    it('nie nadpisuje poprawnego kraju innym wynikiem', () => {
      const ok = { ...TSM_STALE, country: 'Taiwan' };
      repo.upsertTickerMapEntry(ok, PID);
      const touched = mod.applyClassificationBackfill(
        ok,
        { supersector: 'Technologie', subsector: 'Informatyka', country: 'United States' },
        PID,
      );
      expect(touched).toBe(false);
      expect(repo.getTickerByIsin(TSM_STALE.isin, PID)?.country).toBe('Taiwan');
    });

    it('dopisuje brakujące sektory i kraj; ręcznych sektorów nie rusza', () => {
      const bare: TickerMapEntry = {
        ...TSM_STALE,
        sector: undefined,
        supersector: undefined,
        country: undefined,
      };
      repo.upsertTickerMapEntry(bare, PID);
      expect(
        mod.applyClassificationBackfill(
          bare,
          { supersector: 'Technologie', subsector: 'Informatyka', country: 'Taiwan' },
          PID,
        ),
      ).toBe(true);
      const after = repo.getTickerByIsin(TSM_STALE.isin, PID)!;
      expect(after).toMatchObject({
        supersector: 'Technologie',
        sector: 'Informatyka',
        country: 'Taiwan',
      });

      // Drugi przebieg z innym sektorem — sektor już jest, nie nadpisujemy.
      mod.applyClassificationBackfill(
        after,
        { supersector: 'Przemysł', subsector: 'X', country: 'Taiwan' },
        PID,
      );
      expect(repo.getTickerByIsin(TSM_STALE.isin, PID)?.supersector).toBe('Technologie');
    });
  });
});
