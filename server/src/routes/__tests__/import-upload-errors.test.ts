import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { Server } from 'http';

// DATA_DIR przed importem modułów dotykających config
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-import-'));
process.env.DATA_DIR = tmpDir;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { default: importRouter } = await import('../import.js');
  const app = express();
  app.use('/api/import', importRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Brak portu testowego');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function postFile(name: string, content: Buffer | string) {
  const fd = new FormData();
  fd.append('file', new Blob([content]), name);
  return fetch(`${baseUrl}/api/import/detect`, { method: 'POST', body: fd });
}

describe('import upload error handling', () => {
  it('odrzuca niedozwolony typ pliku z kodem 400 i czytelnym komunikatem', async () => {
    const res = await postFile('notatki.txt', 'to nie jest csv');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('CSV, XLSX i HTML');
  });

  it('odrzuca plik powyżej 5 MB z kodem 413', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 'a');
    const res = await postFile('duzy.csv', big);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('za duży');
  });

  it('akceptuje plik CSV (nie zwraca błędu uploadu)', async () => {
    const res = await postFile('test.csv', 'Data;Papier;ISIN\n');
    expect(res.status).toBe(200);
  });
});
