import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { TickerMapEntry } from 'shared';

// DATA_DIR przed importem modułów dotykających config/connection
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-ticker-map-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-ticker-map';

function realEntry(overrides: Partial<TickerMapEntry> = {}): TickerMapEntry {
  return {
    isin: 'US0378331005',
    ticker: 'AAPL',
    name: 'Apple Inc.',
    exchange: 'OTHER',
    currency: 'USD',
    priceSource: 'yahoo',
    ...overrides,
  };
}

/** Kształt stuba, jaki import zapisuje dla nierozwiązanego debiutu: ticker === name,
 *  bez kropki giełdowej. */
function stubEntry(overrides: Partial<TickerMapEntry> = {}): TickerMapEntry {
  return {
    isin: 'PLNEWCO00011',
    ticker: 'NOWASPOLKA',
    name: 'NOWASPOLKA',
    exchange: 'GPW',
    currency: 'PLN',
    priceSource: 'stooq',
    ...overrides,
  };
}

describe('ticker-map-repo — provisional stub / anchor', () => {
  let repo: typeof import('../ticker-map-repo.js');
  let connection: typeof import('../connection.js');

  beforeAll(async () => {
    repo = await import('../ticker-map-repo.js');
    connection = await import('../connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Czyścimy tabelę między testami
    for (const e of repo.getAllTickers(PID)) repo.deleteTickerMapEntry(e.isin, PID);
  });

  describe('isProvisionalStub', () => {
    it('rozpoznaje stub debiutu (ticker === name, bez kropki)', () => {
      expect(repo.isProvisionalStub(stubEntry())).toBe(true);
    });

    it('NIE traktuje jako stub prawdziwego zagranicznego tickera (name != ticker)', () => {
      expect(repo.isProvisionalStub(realEntry())).toBe(false);
    });

    it('symbol z sufiksem giełdy TEŻ jest stubem, gdy nikt go nie potwierdził', () => {
      // Zmiana z 2026-08-23: nazwa równa tickerowi znaczy „niepotwierdzony",
      // niezależnie od kropki. Wcześniej taki wpis nie był stubem i zamarzał pod
      // kotwicą — tak `SMSN.L` (cena 4× niższa od instrumentu z XTB, nazwa
      // „SMSN.L", bo wyszukiwarka Yahoo tego symbolu nie znała) został w bazie
      // na stałe. Ponowne rozpoznanie takich wpisów jest tanie i idzie przez
      // te same guardy.
      expect(repo.isProvisionalStub({ ticker: 'CDR.WA', name: 'CDR.WA' })).toBe(true);
      expect(repo.isProvisionalStub({ ticker: 'SMSN.L', name: 'SMSN.L' })).toBe(true);
    });

    it('NIE traktuje jako stub wpisu z prawdziwą nazwą przy symbolu z sufiksem', () => {
      expect(repo.isProvisionalStub({ ticker: 'SMSN.IL', name: 'Samsung Electronics' })).toBe(
        false,
      );
    });

    it('bezpieczny dla null/undefined/pustego name', () => {
      expect(repo.isProvisionalStub(null)).toBe(false);
      expect(repo.isProvisionalStub(undefined)).toBe(false);
      expect(repo.isProvisionalStub({ ticker: 'X', name: '' })).toBe(false);
    });
  });

  describe('anchor (upsertTickerMapEntry, force=false)', () => {
    it('kotwiczy prawdziwy wpis — drugi upsert go NIE nadpisuje', () => {
      repo.upsertTickerMapEntry(realEntry(), PID);
      repo.upsertTickerMapEntry(realEntry({ ticker: 'WRONG', name: 'Wrong Co' }), PID);
      expect(repo.getTickerByIsin(realEntry().isin, PID)?.ticker).toBe('AAPL');
    });

    it('NIE kotwiczy stuba — prawdziwa rezolucja nadpisuje debiutowy placeholder', () => {
      // 1. Import zapisuje stub dla nierozwiązanego debiutu
      repo.upsertTickerMapEntry(stubEntry(), PID);
      expect(repo.getTickerByIsin(stubEntry().isin, PID)?.ticker).toBe('NOWASPOLKA');

      // 2. Później źródło listuje spółkę → resolver nadpisuje stub prawdziwym tickerem
      repo.upsertTickerMapEntry(
        stubEntry({ ticker: 'NSP.WA', name: 'Nowa Spółka SA', priceSource: 'yahoo' }),
        PID,
      );
      const after = repo.getTickerByIsin(stubEntry().isin, PID);
      expect(after?.ticker).toBe('NSP.WA');
      expect(after?.name).toBe('Nowa Spółka SA');
    });

    it('po zagojeniu stuba nowy wpis jest już zakotwiczony (nie flipuje)', () => {
      repo.upsertTickerMapEntry(stubEntry(), PID);
      repo.upsertTickerMapEntry(stubEntry({ ticker: 'NSP.WA', name: 'Nowa Spółka SA' }), PID);
      // kolejny auto-resolve nie może już podmienić realnego tickera
      repo.upsertTickerMapEntry(stubEntry({ ticker: 'OTHER.WA', name: 'Inna' }), PID);
      expect(repo.getTickerByIsin(stubEntry().isin, PID)?.ticker).toBe('NSP.WA');
    });
  });
});
