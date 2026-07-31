import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-notices-'));
process.env.DATA_DIR = tmpDir;

const PID = 'test-notices';
const NOTICE = { source: 'mBank eMakler', reason: 'dywidendy mogły nie zostać zaimportowane' };

describe('reimport_notices — prośby o ponowne wgranie wyciągu', () => {
  let repo: typeof import('../reimport-notices-repo.js');
  let connection: typeof import('../connection.js');

  beforeAll(async () => {
    repo = await import('../reimport-notices-repo.js');
    connection = await import('../connection.js');
  });

  afterAll(() => {
    connection.closeDb(PID);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('zakłada prośbę i zwraca ją jako aktywną', () => {
    expect(repo.addReimportNotice(PID, { ...NOTICE, detail: 'wgraj plik ponownie' })).toBe(true);

    const active = repo.getActiveReimportNotices(PID);
    expect(active).toHaveLength(1);
    expect(active[0].source).toBe('mBank eMakler');
    expect(active[0].detail).toBe('wgraj plik ponownie');
  });

  it('drugie założenie tej samej prośby nic nie zmienia (skrypt bywa uruchamiany dwa razy)', () => {
    expect(repo.addReimportNotice(PID, NOTICE)).toBe(false);
    expect(repo.getActiveReimportNotices(PID)).toHaveLength(1);
  });

  it('odłożenie usuwa z listy aktywnych, ale zostawia ślad w bazie', () => {
    const [notice] = repo.getActiveReimportNotices(PID);
    expect(repo.dismissReimportNotice(PID, notice.id)).toBe(true);
    expect(repo.getActiveReimportNotices(PID)).toHaveLength(0);
  });

  it('odłożonej prośby nie da się odłożyć drugi raz', () => {
    expect(repo.dismissReimportNotice(PID, 1)).toBe(false);
  });

  it('ponowne uruchomienie skryptu NIE wskrzesza odłożonej prośby', () => {
    expect(repo.addReimportNotice(PID, NOTICE)).toBe(false);
    expect(repo.getActiveReimportNotices(PID)).toHaveLength(0);
  });

  it('inna przyczyna to osobna prośba', () => {
    expect(repo.addReimportNotice(PID, { source: 'XTB', reason: 'inna sprawa' })).toBe(true);
    expect(repo.getActiveReimportNotices(PID)).toHaveLength(1);
  });
});
