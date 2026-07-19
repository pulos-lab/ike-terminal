import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/connection
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-lazy-stub-'));

describe('shouldRunLazyPass — throttling lazy passów w tle', () => {
  let shouldRunLazyPass: typeof import('../portfolio-views.js').shouldRunLazyPass;
  let SECTOR_RETRY_MS: number;

  beforeAll(async () => {
    const mod = await import('../portfolio-views.js');
    shouldRunLazyPass = mod.shouldRunLazyPass;
    SECTOR_RETRY_MS = mod.SECTOR_BACKFILL_RETRY_MS;
  });

  const RM = 6 * 60 * 60 * 1000;

  it('nie odpala, gdy nie ma pracy do zrobienia', () => {
    expect(shouldRunLazyPass(false, undefined, false, 1_000_000, RM)).toBe(false);
  });

  it('odpala przy pierwszym trafieniu (jest praca, brak wcześniejszej próby)', () => {
    expect(shouldRunLazyPass(true, undefined, false, 1_000_000, RM)).toBe(true);
  });

  it('nie odpala, gdy przebieg już leci (in-flight guard)', () => {
    expect(shouldRunLazyPass(true, undefined, true, 1_000_000, RM)).toBe(false);
  });

  it('throttluje w oknie retry i ponawia po jego upływie', () => {
    const last = 1_000_000;
    expect(shouldRunLazyPass(true, last, false, last + RM - 1, RM)).toBe(false);
    expect(shouldRunLazyPass(true, last, false, last + RM, RM)).toBe(true);
  });

  it('backfill sektorów używa 6h interwału', () => {
    expect(SECTOR_RETRY_MS).toBe(6 * 60 * 60 * 1000);
  });
});

describe('shouldResolveStubs — throttling lazy re-resolucji debiutowych stubów', () => {
  let shouldResolveStubs: typeof import('../portfolio-views.js').shouldResolveStubs;
  let RETRY_MS: number;

  beforeAll(async () => {
    const mod = await import('../portfolio-views.js');
    shouldResolveStubs = mod.shouldResolveStubs;
    RETRY_MS = mod.STUB_RESOLVE_RETRY_MS;
  });

  it('nie próbuje, gdy nie ma stubów', () => {
    expect(shouldResolveStubs(false, undefined, false, 1_000_000)).toBe(false);
  });

  it('próbuje przy pierwszym trafieniu (są stuby, brak wcześniejszej próby)', () => {
    expect(shouldResolveStubs(true, undefined, false, 1_000_000)).toBe(true);
  });

  it('nie próbuje, gdy przebieg jest już w toku (in-flight guard)', () => {
    expect(shouldResolveStubs(true, undefined, true, 1_000_000)).toBe(false);
  });

  it('throttluje w oknie retry', () => {
    const last = 1_000_000;
    expect(shouldResolveStubs(true, last, false, last + RETRY_MS - 1)).toBe(false);
  });

  it('próbuje ponownie po upływie okna retry', () => {
    const last = 1_000_000;
    expect(shouldResolveStubs(true, last, false, last + RETRY_MS)).toBe(true);
    expect(shouldResolveStubs(true, last, false, last + RETRY_MS + 1)).toBe(true);
  });
});
