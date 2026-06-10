import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułów dotykających config/auth.db
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-share-'));
process.env.DATA_DIR = tmpDir;

const {
  createShare,
  getShareByToken,
  getShareForPortfolio,
  updateShare,
  deleteShareForPortfolio,
  isValidTokenFormat,
} = await import('../../db/share-repo.js');
const { getAuthDb } = await import('../../auth.js');

const SETTINGS = {
  scope: 'chart' as const,
  showAmounts: false,
  benchmark: 'wig',
  validity: '7d' as const,
};

describe('share-repo', () => {
  it('createShare generuje 32-znakowy token base64url i poprawne expiresAt', () => {
    const share = createShare('pf-1', SETTINGS);
    expect(isValidTokenFormat(share.token)).toBe(true);
    expect(share.portfolioId).toBe('pf-1');
    expect(share.scope).toBe('chart');
    expect(share.showAmounts).toBe(false);
    expect(share.expiresAt).not.toBeNull();
    expect(getShareByToken(share.token)?.token).toBe(share.token);
  });

  it('jeden aktywny link per portfel — drugi INSERT rzuca (UNIQUE)', () => {
    expect(() => createShare('pf-1', SETTINGS)).toThrow();
  });

  it('validity=indefinite → expiresAt null', () => {
    const share = createShare('pf-indef', { ...SETTINGS, validity: 'indefinite' });
    expect(share.expiresAt).toBeNull();
  });

  it('updateShare zmienia ustawienia bez zmiany tokenu', () => {
    const before = getShareForPortfolio('pf-1')!;
    const after = updateShare('pf-1', {
      scope: 'chart_positions',
      showAmounts: true,
      benchmark: 'sp500',
      validity: 'indefinite',
    })!;
    expect(after.token).toBe(before.token);
    expect(after.scope).toBe('chart_positions');
    expect(after.showAmounts).toBe(true);
    expect(after.expiresAt).toBeNull();
  });

  it('zły format tokenu → null bez dotykania DB', () => {
    expect(getShareByToken('abc')).toBeNull();
    expect(getShareByToken("' OR 1=1 --")).toBeNull();
    expect(getShareByToken('a'.repeat(32) + 'b')).toBeNull();
  });

  it('wygasły link → null + lazy delete wiersza', () => {
    const share = createShare('pf-expired', SETTINGS);
    getAuthDb()
      .prepare(`UPDATE portfolio_shares SET expiresAt = datetime('now', '-1 hour') WHERE token = ?`)
      .run(share.token);
    expect(getShareByToken(share.token)).toBeNull();
    const row = getAuthDb()
      .prepare('SELECT COUNT(*) AS n FROM portfolio_shares WHERE token = ?')
      .get(share.token) as { n: number };
    expect(row.n).toBe(0);
  });

  it('deleteShareForPortfolio unieważnia natychmiast', () => {
    const share = getShareForPortfolio('pf-1')!;
    expect(deleteShareForPortfolio('pf-1')).toBe(true);
    expect(getShareByToken(share.token)).toBeNull();
    expect(deleteShareForPortfolio('pf-1')).toBe(false);
  });
});
