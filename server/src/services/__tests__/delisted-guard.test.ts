import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR przed importem modułu (isin-resolver statycznie dociąga db/ticker-map-repo).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ike-test-delisted-'));
process.env.DATA_DIR = tmpDir;

/**
 * Guard papierów delisted — po uogólnieniu mapy (DELISTED_PAPERS) wpisy mogą
 * nieść własną giełdę/walutę/źródło cen; historyczne wpisy GPW zachowują
 * dotychczasowe defaulty. Wpis z name ≠ ticker nie jest prowizorycznym stubem,
 * więc zatrzymuje pętlę ponawiania resolveUnknownIsins.
 */
describe('tryDelistedGuard', () => {
  let tryDelistedGuard: typeof import('../isin-resolver.js').tryDelistedGuard;
  let isProvisionalStub: typeof import('../../db/ticker-map-repo.js').isProvisionalStub;

  beforeAll(async () => {
    ({ tryDelistedGuard } = await import('../isin-resolver.js'));
    ({ isProvisionalStub } = await import('../../db/ticker-map-repo.js'));
  });

  it('wpis GPW (PLASTBOX) zachowuje historyczne defaulty GPW/PLN/stooq', () => {
    expect(tryDelistedGuard('PLPSTBX00016')).toEqual({
      isin: 'PLPSTBX00016',
      ticker: 'PLASTBOX',
      name: 'Plast-Box S.A.',
      exchange: 'GPW',
      currency: 'PLN',
      priceSource: 'stooq',
    });
  });

  it('wpis zagraniczny (IPF po squeeze-oucie) niesie własną giełdę i walutę', () => {
    const entry = tryDelistedGuard('GB00B1YKG049');
    expect(entry).toMatchObject({
      isin: 'GB00B1YKG049',
      ticker: 'IPF',
      name: 'International Personal Finance plc',
      exchange: 'OTHER',
      currency: 'GBP',
    });
    // name ≠ ticker ⇒ nie-stub ⇒ resolveUnknownIsins przestaje ponawiać.
    expect(isProvisionalStub(entry)).toBe(false);
  });

  it('nieznany ISIN → null (guard nie zgaduje)', () => {
    expect(tryDelistedGuard('US0000000000')).toBeNull();
  });
});
