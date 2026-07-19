import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/connection
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-lazy-stub-'));

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
