import { describe, it, expect } from 'vitest';
import { isPlausibleMatch, pickPlausible } from '../ticker-match.js';

/**
 * Wszystkie pary poniżej pochodzą z realnych danych: albo z produkcyjnego
 * `ticker_map` (659 unikalnych trójek zebranych 2026-07-20), albo z odpowiedzi
 * wyszukiwarki Yahoo sprawdzonych przy diagnozie zgłoszenia RELI→EZRA.
 */
describe('isPlausibleMatch — walidacja trafień Yahoo dla papierów zagranicznych', () => {
  describe('odrzuca cudze spółki', () => {
    it('RELI → RS (Reliance, Inc.) — zgłoszenie użytkownika 2026-07-20', () => {
      // Sedno błędu: "RELI" jest prefiksem "RELIANCE", więc dopasowanie
      // prefiksowe by to przepuściło. Portfel pokazywał 395,93 USD (dystrybutor
      // stali z S&P 500) zamiast 2,28 USD (Reliance Global Group).
      expect(isPlausibleMatch(['RELI'], { symbol: 'RS', name: 'Reliance, Inc.' })).toBe(false);
    });

    it('FI (Fiserv) → GGAL (argentyński bank)', () => {
      expect(
        isPlausibleMatch(['FI'], { symbol: 'GGAL', name: 'Grupo Financiero Galicia S.A.' }),
      ).toBe(false);
    });

    it('TIM (GPW) → TINS.JK (indonezyjska cyna)', () => {
      expect(isPlausibleMatch(['TIM'], { symbol: 'TINS.JK', name: 'PT TIMAH Tbk' })).toBe(false);
    });

    it('ISIN Reliance Global Group → RELY (Remitly Global)', () => {
      // Yahoo search po ISIN bywa kompletnie chybiony — US75960P1049 zwraca
      // Remitly. Walidacja po nazwie papieru od brokera to wyłapuje.
      expect(
        isPlausibleMatch(['US75960P1049', 'Reliance Global Group'], {
          symbol: 'RELY',
          name: 'Remitly Global, Inc.',
        }),
      ).toBe(false);
    });

    it('VERTIV → MPLVERBUM (kolizja na 3-znakowym prefiksie VER)', () => {
      expect(isPlausibleMatch(['VERTIV'], { symbol: 'VER.WA', name: 'MPLVERBUM' })).toBe(false);
    });

    it('UNIMOT → UNIBEP (kolizja na UNI)', () => {
      expect(isPlausibleMatch(['UNIMOT'], { symbol: 'UNI.WA', name: 'UNIBEP' })).toBe(false);
    });
  });

  describe('przepuszcza poprawne trafienia', () => {
    it('po dokładnym symbolu: TSLA → TSLA', () => {
      expect(isPlausibleMatch(['TSLA'], { symbol: 'TSLA', name: 'Tesla, Inc.' })).toBe(true);
    });

    it('po nazwie jednotokenowej: TESLA → Tesla, Inc.', () => {
      expect(isPlausibleMatch(['TESLA'], { symbol: 'TSLA', name: 'Tesla, Inc.' })).toBe(true);
    });

    it('po nazwie z formą prawną: SYNEKTIK → Synektik SA', () => {
      expect(isPlausibleMatch(['SYNEKTIK'], { symbol: 'SNT.WA', name: 'Synektik SA' })).toBe(true);
    });

    it('wielotokenowo z prefiksem: MICRON TECH → Micron Technology, Inc.', () => {
      expect(
        isPlausibleMatch(['MICRON TECH'], { symbol: 'MU', name: 'Micron Technology, Inc.' }),
      ).toBe(true);
    });

    it('wielotokenowo dokładnie: RIGETTI COMPUTING → Rigetti Computing, Inc.', () => {
      expect(
        isPlausibleMatch(['RIGETTI COMPUTING'], {
          symbol: 'RGTI',
          name: 'Rigetti Computing, Inc.',
        }),
      ).toBe(true);
    });

    it('klasa akcji jest ignorowana: NOVO NORDISK B → Novo Nordisk A/S', () => {
      expect(
        isPlausibleMatch(['NOVO NORDISK B'], { symbol: 'NOVO-B.CO', name: 'Novo Nordisk A/S' }),
      ).toBe(true);
    });

    it('sufiks giełdy dodany przez Yahoo: XYZ → XYZ.VI', () => {
      // Mapa XTB_TO_YAHOO ma tylko 13 sufiksów; dla nieznanego XTB oddaje goły
      // ticker, a Yahoo słusznie zwraca go z sufiksem. To musi przejść.
      expect(isPlausibleMatch(['XYZ'], { symbol: 'XYZ.VI', name: 'Some Vienna Co' })).toBe(true);
    });

    it('sufiks giełdy zmieniony: INPST.AS → INPST.AMS (ten sam base)', () => {
      expect(isPlausibleMatch(['INPST.AS'], { symbol: 'INPST.AMS', name: 'InPost' })).toBe(true);
    });

    it('trafienie po nazwie papieru, gdy ISIN nic nie mówi', () => {
      expect(
        isPlausibleMatch(['US75960P3037', 'Reliance Global Group'], {
          symbol: 'EZRA',
          name: 'Reliance Global Group, Inc.',
        }),
      ).toBe(true);
    });
  });

  describe('przypadki brzegowe', () => {
    it('puste zapytania nie przepuszczają niczego', () => {
      expect(isPlausibleMatch([], { symbol: 'RS', name: 'Reliance, Inc.' })).toBe(false);
      expect(isPlausibleMatch([undefined, null, '  '], { symbol: 'RS', name: 'X' })).toBe(false);
    });

    it('pusta nazwa kandydata nie wywraca dopasowania po symbolu', () => {
      expect(isPlausibleMatch(['EZRA'], { symbol: 'EZRA', name: '' })).toBe(true);
    });

    it('zapytanie złożone wyłącznie z ignorowanych tokenów nie pasuje po nazwie', () => {
      expect(isPlausibleMatch(['SA'], { symbol: 'XXX', name: 'Jakaś Spółka SA' })).toBe(false);
    });
  });
});

describe('pickPlausible — wybór pierwszego sensownego trafienia', () => {
  it('pomija cudzą spółkę i bierze właściwą z dalszej pozycji listy', () => {
    const candidates = [
      { symbol: 'RS', name: 'Reliance, Inc.' },
      { symbol: 'RLBY', name: 'Reliability Incorporated' },
      { symbol: 'EZRA', name: 'Reliance Global Group, Inc.' },
    ];
    expect(pickPlausible(candidates, ['Reliance Global Group'])?.symbol).toBe('EZRA');
  });

  it('zwraca null, gdy żadne trafienie nie przechodzi — wołający NIE może sięgnąć po [0]', () => {
    const candidates = [
      { symbol: 'RS', name: 'Reliance, Inc.' },
      { symbol: 'RLBY', name: 'Reliability Incorporated' },
    ];
    expect(pickPlausible(candidates, ['RELI'])).toBeNull();
  });

  it('pusta lista kandydatów → null', () => {
    expect(pickPlausible([], ['RELI'])).toBeNull();
  });
});
