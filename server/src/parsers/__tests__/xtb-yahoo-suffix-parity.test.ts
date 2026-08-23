import { describe, it, expect } from 'vitest';
import { FOREIGN_YAHOO_SUFFIXES, hasForeignYahooSuffix } from 'shared';
import { XTB_TO_YAHOO, SUFFIX_CURRENCY } from '../xtb-transactions.js';

/**
 * Parser XTB tłumaczy sufiks KRAJU („SMSN.UK") na sufiks giełdy Yahoo
 * („SMSN.L"), a resolver po tym sufiksie rozstrzyga, czy papier jest polski.
 * Gdyby parser wyprodukował sufiks, którego resolver nie zna, papier wpadłby
 * w gałąź polską po samej etykiecie waluty (bywa nią waluta konta) i wróciłby
 * nierozpoznany — dokładnie tak zginęło `SMSN.UK` (zgłoszenie 2026-08-23).
 */
describe('parytet sufiksów XTB → Yahoo', () => {
  it('każdy sufiks produkowany przez parser jest znany resolverowi', () => {
    const unknown = Object.entries(XTB_TO_YAHOO)
      .map(([country, suffix]) => ({ country, suffix }))
      // '' = USA (goły symbol), '.WA' = Warszawa (gałąź polska)
      .filter(({ suffix }) => suffix !== '' && suffix !== '.WA')
      .filter(({ suffix }) => !FOREIGN_YAHOO_SUFFIXES.has(suffix.replace(/^\./, '').toUpperCase()))
      .map(({ country, suffix }) => `${country} → ${suffix}`);

    expect(unknown).toEqual([]);
  });

  it('symbol po tłumaczeniu jest rozpoznawany jako zagraniczny (poza .WA i USA)', () => {
    expect(hasForeignYahooSuffix('SMSN' + XTB_TO_YAHOO.UK)).toBe(true);
    expect(hasForeignYahooSuffix('INPST' + XTB_TO_YAHOO.NL)).toBe(true);
    expect(hasForeignYahooSuffix('JSW' + XTB_TO_YAHOO.PL)).toBe(false);
    expect(hasForeignYahooSuffix('PLTR' + XTB_TO_YAHOO.US)).toBe(false);
  });

  it('obie mapy parsera pokrywają ten sam zestaw krajów', () => {
    expect(Object.keys(XTB_TO_YAHOO).sort()).toEqual(Object.keys(SUFFIX_CURRENCY).sort());
  });
});
