import { describe, it, expect } from 'vitest';
import {
  TREASURY_BOND_RE,
  isBondInstrument,
  findBondByTicker,
  findBondByIsin,
  inferBondNominal,
} from 'shared';

describe('TREASURY_BOND_RE', () => {
  it('łapie serie skarbowe i BGK/PFR', () => {
    for (const t of ['DS1030', 'WZ1131', 'PS0527', 'OK0128', 'WS0447', 'FPC0733', 'IDS1024']) {
      expect(TREASURY_BOND_RE.test(t)).toBe(true);
    }
  });

  it('NIE łapie zwykłych tickerów ani korporacyjnych obligacji', () => {
    for (const t of ['KGHM', 'CDR', 'KGH0631', 'PKO0827', 'DS103', 'DS10301', 'XTB']) {
      expect(TREASURY_BOND_RE.test(t)).toBe(false);
    }
  });
});

describe('isBondInstrument', () => {
  it('rozpoznaje skarbową po regexie (nawet spoza mapy)', () => {
    expect(isBondInstrument('DS9999')).toBe(true);
  });

  it('rozpoznaje korporacyjną po bond-map (ticker i ISIN)', () => {
    expect(isBondInstrument('KGH0631')).toBe(true);
    expect(isBondInstrument('cokolwiek', 'PLO023600011')).toBe(true);
  });

  it('rozpoznaje skarbową po prefiksie ISIN PL0000', () => {
    expect(isBondInstrument('NIEZNANA', 'PL0000999999')).toBe(true);
  });

  it('NIE rozpoznaje akcji GPW', () => {
    expect(isBondInstrument('KGHM', 'PLKGHM000017')).toBe(false);
    expect(isBondInstrument('CDR', 'PLOPTTC00011')).toBe(false);
  });
});

describe('bond-map lookups', () => {
  it('findBondByTicker zwraca wpis z nominałem i datą wykupu', () => {
    const bond = findBondByTicker('DS1030');
    expect(bond).not.toBeNull();
    expect(bond!.isin).toBe('PL0000112736');
    expect(bond!.nominal).toBe(1000);
    expect(bond!.maturityDate).toBe('2030-10-25');
    expect(bond!.segment).toBe('treasury');
  });

  it('findBondByIsin działa jako indeks odwrotny', () => {
    expect(findBondByIsin('PL0000112736')?.ticker).toBe('DS1030');
  });
});

describe('inferBondNominal', () => {
  it('inferuje 1000 zł z transakcji (kurs 98,50%, 10 szt, 9850 zł)', () => {
    expect(inferBondNominal(10, 98.5, 9850)).toBe(1000);
  });

  it('toleruje narosłe odsetki w wartości (do 15%)', () => {
    // value 10050 → kandydat 1020 → snap do 1000
    expect(inferBondNominal(10, 98.5, 10050)).toBe(1000);
  });

  it('inferuje 100 zł (typowy nominał detalicznych korporacyjnych)', () => {
    expect(inferBondNominal(50, 99, 4950)).toBe(100);
  });

  it('realny przykład BST0327: wartość z narosłymi odsetkami → nominał 100', () => {
    // 2033,40 / (20 × 101,50%) = 100,17 → snap do 100 (formularz Bossy 2026-06-11)
    expect(inferBondNominal(20, 101.5, 2033.4)).toBe(100);
  });

  it('realny przykład FPC0235: odsetki 21,70/szt (2,1% nominału) → nominał 1000', () => {
    // 23 908,50 / (23 × 101,78%) = 1021,3 → snap do 1000 (formularz Bossy 2026-06-11)
    expect(inferBondNominal(23, 101.78, 23908.5)).toBe(1000);
  });

  it('dla spójnych danych akcyjnych (value = qty × price) zwraca z definicji 100', () => {
    // Kandydat = value/(qty × price/100) = dokładnie 100 dla każdej akcji —
    // dlatego inferencja jest wołana WYŁĄCZNIE dla instrumentów już
    // sklasyfikowanych jako obligacja (category='bond'), nigdy do detekcji.
    expect(inferBondNominal(10, 150.5, 1505)).toBe(100);
  });

  it('zwraca null gdy kandydat nie pasuje do żadnego typowego nominału', () => {
    // kandydat = 5000/(10 × 0,985) ≈ 507,6 → poza {100, 1000, 10000}
    expect(inferBondNominal(10, 98.5, 5000)).toBeNull();
  });

  it('zwraca null dla nieprawidłowych danych', () => {
    expect(inferBondNominal(0, 98.5, 9850)).toBeNull();
    expect(inferBondNominal(10, 0, 9850)).toBeNull();
    expect(inferBondNominal(10, 98.5, 0)).toBeNull();
  });
});
