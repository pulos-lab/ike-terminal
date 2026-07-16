import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Yahoo BEFORE importing the resolver
vi.mock('../yahoo-finance.js', () => ({
  fetchAssetProfile: vi.fn(),
}));

import { resolveSector } from '../sector-resolver.js';
import * as yahoo from '../yahoo-finance.js';
import { regionLabel } from 'shared';
import type { TickerMapEntry } from 'shared';

const fetchAssetProfile = yahoo.fetchAssetProfile as ReturnType<typeof vi.fn>;

function entry(overrides: Partial<TickerMapEntry>): TickerMapEntry {
  return {
    isin: 'US0000000000',
    ticker: 'TEST',
    name: 'Test Co',
    exchange: 'NYSE',
    currency: 'USD',
    priceSource: 'yahoo',
    ...overrides,
  };
}

describe('resolveSector — kraj siedziby', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GPW: sektor ze statycznej mapy + country=Poland, bez Yahoo', async () => {
    const res = await resolveSector(
      entry({ isin: 'PLPKO0000016', ticker: 'PKOBP.WA', name: 'PKO BP', exchange: 'GPW' }),
    );
    expect(res.country).toBe('Poland');
    expect(res.supersector).toBeTruthy();
    expect(fetchAssetProfile).not.toHaveBeenCalled();
  });

  it('GPW miss w mapie → fallback Yahoo, ale country zostaje Poland', async () => {
    fetchAssetProfile.mockResolvedValue({
      sector: 'Technology',
      industry: 'Software—Application',
      country: 'United States', // Yahoo bywa mylące dla spółek dual-listed — statyka wygrywa
    });
    const res = await resolveSector(
      entry({ isin: 'PLXYZ0000000', ticker: 'XYZ.WA', name: 'Nieznana Spółka', exchange: 'GPW' }),
    );
    expect(res).toEqual({
      supersector: 'Technologie',
      subsector: 'Informatyka',
      country: 'Poland',
    });
  });

  it('CATALYST: early-return Poland, zero strzałów do Yahoo', async () => {
    const res = await resolveSector(
      entry({ isin: 'PL0000000001', ticker: 'BST0728', exchange: 'CATALYST', currency: 'PLN' }),
    );
    expect(res).toEqual({ supersector: null, subsector: null, country: 'Poland' });
    expect(fetchAssetProfile).not.toHaveBeenCalled();
  });

  it('CFD (GOLD): supersektor ze statycznej mapy, country=null', async () => {
    const res = await resolveSector(
      entry({ isin: 'CFD:GOLD', ticker: 'GOLD', name: 'GOLD', exchange: 'OTHER' }),
    );
    expect(res.supersector).toBe('Surowce');
    expect(res.country).toBeNull();
    expect(fetchAssetProfile).not.toHaveBeenCalled();
  });

  it('zagraniczna spółka: GICS→stockwatch + country z profilu Yahoo', async () => {
    fetchAssetProfile.mockResolvedValue({
      sector: 'Technology',
      industry: 'Software—Application',
      country: 'United States',
    });
    const res = await resolveSector(entry({ ticker: 'MSFT', name: 'Microsoft' }));
    expect(res).toEqual({
      supersector: 'Technologie',
      subsector: 'Informatyka',
      country: 'United States',
    });
  });

  it('ADR na NYSE: country = kraj siedziby, nie kraj giełdy', async () => {
    fetchAssetProfile.mockResolvedValue({
      sector: 'Healthcare',
      industry: 'Drug Manufacturers—General',
      country: 'Denmark',
    });
    const res = await resolveSector(entry({ ticker: 'NVO', name: 'Novo Nordisk' }));
    expect(res.country).toBe('Denmark');
  });

  it('profil bez mapowania GICS: angielski sector jako subsector, country zachowany', async () => {
    fetchAssetProfile.mockResolvedValue({
      sector: 'Weird New Sector',
      industry: null,
      country: 'France',
    });
    const res = await resolveSector(entry({ ticker: 'ABC.PA' }));
    expect(res).toEqual({ supersector: null, subsector: 'Weird New Sector', country: 'France' });
  });

  it('profil z samym country (ETF-like bez sektora): country przechodzi', async () => {
    fetchAssetProfile.mockResolvedValue({ sector: null, industry: null, country: 'Germany' });
    const res = await resolveSector(entry({ ticker: 'XYZ.DE', exchange: 'XETRA' }));
    expect(res).toEqual({ supersector: null, subsector: null, country: 'Germany' });
  });

  it('Yahoo fail: wszystko null dla zagranicznej', async () => {
    fetchAssetProfile.mockRejectedValue(new Error('boom'));
    const res = await resolveSector(entry({ ticker: 'FAIL' }));
    expect(res).toEqual({ supersector: null, subsector: null, country: null });
  });
});

describe('regionLabel — etykieta wykresu Regiony', () => {
  it('kraj rozwiązany: tłumaczenie na polską etykietę', () => {
    expect(regionLabel('United States', 'NYSE')).toBe('USA');
    expect(regionLabel('Poland', 'GPW')).toBe('Polska');
    expect(regionLabel('Germany', 'XETRA')).toBe('Niemcy');
  });

  it('ADR: kraj wygrywa z giełdą', () => {
    expect(regionLabel('Denmark', 'NYSE')).toBe('Dania');
  });

  it('kraj spoza mapy: przechodzi bez tłumaczenia (lepsze niż „Inne")', () => {
    expect(regionLabel('Mongolia', 'OTHER')).toBe('Mongolia');
  });

  it('brak kraju: fallback po giełdzie — w tym XETRA i CATALYST (dawniej „Inne")', () => {
    expect(regionLabel(null, 'XETRA')).toBe('Niemcy');
    expect(regionLabel(null, 'CATALYST')).toBe('Polska');
    expect(regionLabel(null, 'GPW')).toBe('Polska');
    expect(regionLabel(null, 'NC')).toBe('Polska');
    expect(regionLabel(null, 'NASDAQ')).toBe('USA');
    expect(regionLabel(null, 'TSX')).toBe('Kanada');
  });

  it('brak kraju i nieznana/pusta giełda: „Inne"', () => {
    expect(regionLabel(null, 'OTHER')).toBe('Inne');
    expect(regionLabel(null, undefined)).toBe('Inne');
    expect(regionLabel(undefined, '')).toBe('Inne');
  });
});
