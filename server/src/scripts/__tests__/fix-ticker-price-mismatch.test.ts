import { describe, it, expect } from 'vitest';
import {
  classifyPrice,
  verdictLooksCorrect,
  shouldRetryAsForeign,
} from '../fix-ticker-price-mismatch.js';

/**
 * Wszystkie liczby pochodzą z realnych wpisów `ticker_map` na produkcji
 * (przesiew 1013 trójek, 2026-08-06). Ta funkcja jest jedynym miejscem, które
 * decyduje „to cudzy papier" vs „to tylko wygląda dziwnie" — a przesiew pokazał,
 * że fałszywek jest tu znacznie więcej niż realnych błędów.
 */
describe('classifyPrice — cena transakcji vs notowanie przypisanego papieru', () => {
  describe('rozpoznaje CUDZY papier', () => {
    it('ATAL → ATA.WA (ATCCARGO): 59,80 vs 15,20 PLN', () => {
      // Iloraz 3,93 leży blisko „splitu 4:1" — ale ŻADEN split nie jest zapisany,
      // więc to zły papier. Heurystyka po samym ilorazie przepuszczała ten wpis.
      expect(classifyPrice({ txPrice: 59.8, providerPrice: 15.2, fxRate: 1 })).toBe('niezgodna');
    });

    it('TSGAMES → TSG.WA (TESGAS): 169,20 vs 3,74 PLN', () => {
      expect(classifyPrice({ txPrice: 169.2, providerPrice: 3.74, fxRate: 1 })).toBe('niezgodna');
    });

    it('TIM → TINS.JK (indonezyjska cyna): 50,69 PLN vs 575 IDR', () => {
      // Kurs IDR→PLN ~0,00022; iloraz 0,088 nie pasuje ani do 1, ani do kursu.
      expect(classifyPrice({ txPrice: 50.69, providerPrice: 575, fxRate: 0.00022 })).toBe(
        'niezgodna',
      );
    });

    it('NOVOB.CO → NOV.WA (NOVINA): 282,80 vs 0,61 PLN', () => {
      expect(classifyPrice({ txPrice: 282.8, providerPrice: 0.61, fxRate: 1 })).toBe('niezgodna');
    });
  });

  describe('NIE podnosi alarmu tam, gdzie papier jest poprawny', () => {
    it('ten sam papier, ta sama skala', () => {
      expect(classifyPrice({ txPrice: 100, providerPrice: 98.5, fxRate: 1 })).toBe('zgodna');
    });

    it('IWDA.L: cena zapisana w walucie konta (540,68 PLN vs 144,24 USD)', () => {
      expect(classifyPrice({ txPrice: 540.68, providerPrice: 144.24, fxRate: 3.73 })).toBe(
        'inna-waluta',
      );
    });

    it('BRKB.VI: cross-listing (500,65 USD vs 425,05 EUR)', () => {
      // Przy kursie EUR/USD ~1,18 „ta sama skala" i „inna waluta" są nierozróżnialne
      // i obie znaczą to samo: papier się zgadza. Sprawdzamy więc kubełek, nie etykietę.
      const v = classifyPrice({ txPrice: 500.65, providerPrice: 425.05, fxRate: 1.18 });
      expect(verdictLooksCorrect(v)).toBe(true);
      expect(v).not.toBe('niezgodna');
    });

    it('notowanie w pensach przy transakcji w funtach', () => {
      expect(classifyPrice({ txPrice: 2800, providerPrice: 28, fxRate: 1 })).toBe('jednostka-gbx');
    });
  });

  describe('rozjazd wyjaśnia ZAPISANY split, nie „splitowo wyglądający" iloraz', () => {
    it('IBKR 4:1 (176 vs 44,87 USD) — ze splitem w bazie', () => {
      expect(classifyPrice({ txPrice: 176, providerPrice: 44.87, fxRate: 1, splitRatio: 4 })).toBe(
        'split',
      );
    });

    it('LCID 1:10 (3,285 vs 32,60 USD) — reverse split w bazie', () => {
      expect(
        classifyPrice({ txPrice: 3.285, providerPrice: 32.6, fxRate: 1, splitRatio: 1 / 10 }),
      ).toBe('split');
    });

    it('EZRA 1:40 po zmianie tickera RELI (0,2074 vs 8,32 USD)', () => {
      expect(
        classifyPrice({ txPrice: 0.2074, providerPrice: 8.32, fxRate: 1, splitRatio: 1 / 40 }),
      ).toBe('split');
    });

    it('ten sam iloraz BEZ zapisanego splitu to zły papier, nie split', () => {
      // 176/44,87 = 3,92 (IBKR) i 59,8/15,2 = 3,93 (ATAL) — nie do rozróżnienia
      // po samej liczbie. Rozstrzyga fakt z bazy.
      expect(classifyPrice({ txPrice: 176, providerPrice: 44.87, fxRate: 1 })).toBe('niezgodna');
    });

    it('zapisany split o INNEJ skali nie tłumaczy rozjazdu', () => {
      // Papier ma split 2:1, ale cena rozjeżdża się 60× — to nie jest ten powód.
      expect(
        classifyPrice({ txPrice: 110.65, providerPrice: 1.82, fxRate: 1, splitRatio: 2 }),
      ).toBe('niezgodna');
    });
  });

  describe('kurs walutowy musi być Z DNIA TRANSAKCJI i pasować ciasno', () => {
    it('TIM → TIMB (brazylijski telekom o tej samej nazwie) NIE przechodzi', () => {
      // Dry-run na produkcji 2026-08-07 zaproponował podmianę polskiego TIM-u na
      // TIMB z NYSE. Iloraz 50,69/17,78 = 2,85 vs kurs USD/PLN z tamtej daty 3,99
      // → 29% obok. Przy kursie DZISIEJSZYM (~3,5) mieściło się w 25% i przechodziło.
      expect(classifyPrice({ txPrice: 50.69, providerPrice: 17.78, fxRate: 3.99 })).toBe(
        'niezgodna',
      );
    });

    it('realne przewalutowanie trafia w kilka procent i przechodzi', () => {
      // IWDA.L: 540,68 PLN / 144,24 USD = 3,749 przy kursie 3,73 → 0,5% różnicy.
      expect(classifyPrice({ txPrice: 540.68, providerPrice: 144.24, fxRate: 3.73 })).toBe(
        'inna-waluta',
      );
    });

    it('luźne dopasowanie do kursu (18% obok) już NIE wystarcza', () => {
      expect(classifyPrice({ txPrice: 50.69, providerPrice: 17.78, fxRate: 3.5 })).toBe(
        'niezgodna',
      );
    });
  });

  describe('brak danych nie jest dowodem błędu', () => {
    it('provider bez notowania → brak-danych', () => {
      expect(classifyPrice({ txPrice: 100, providerPrice: null, fxRate: 1 })).toBe('brak-danych');
    });

    it('zerowa lub ujemna cena → brak-danych', () => {
      expect(classifyPrice({ txPrice: 100, providerPrice: 0, fxRate: 1 })).toBe('brak-danych');
      expect(classifyPrice({ txPrice: 0, providerPrice: 100, fxRate: 1 })).toBe('brak-danych');
    });

    it('brak kursu walutowego nie zamienia poprawnego wpisu w błędny', () => {
      // Bez kursu iloraz 3,73 nie ma jak się wytłumaczyć — ale to NIE jest
      // powód do nadpisania wpisu, więc werdykt nie może trafić do „correct".
      expect(
        verdictLooksCorrect(
          classifyPrice({ txPrice: 540.68, providerPrice: 144.24, fxRate: null }),
        ),
      ).toBe(false);
    });
  });

  describe('verdictLooksCorrect — co wolno zapisać po ponownym rozpoznaniu', () => {
    it('przepuszcza tylko werdykty potwierdzające papier', () => {
      expect(verdictLooksCorrect('zgodna')).toBe(true);
      expect(verdictLooksCorrect('inna-waluta')).toBe(true);
      expect(verdictLooksCorrect('jednostka-gbx')).toBe(true);
    });

    it('nie przepuszcza niepewnych — split, niezgodna, brak danych', () => {
      expect(verdictLooksCorrect('split')).toBe(false);
      expect(verdictLooksCorrect('niezgodna')).toBe(false);
      expect(verdictLooksCorrect('brak-danych')).toBe(false);
    });
  });

  describe('shouldRetryAsForeign — zła etykieta waluty wpycha obcy papier w polską gałąź', () => {
    it('etykieta PLN po nieudanej pierwszej próbie → ponów jako zagraniczny', () => {
      // INTU 551,07 „PLN" to w rzeczywistości 545,40 USD (Intuit). Etykieta waluty
      // konta sprawia, że resolver szuka wyłącznie listingów .WA i dorabia INT.WA.
      expect(shouldRetryAsForeign('PLN', true)).toBe(true);
    });

    it('pierwsza próba się powiodła → bez ponawiania', () => {
      expect(shouldRetryAsForeign('PLN', false)).toBe(false);
    });

    it('etykieta inna niż PLN → papier i tak idzie gałęzią zagraniczną', () => {
      expect(shouldRetryAsForeign('USD', true)).toBe(false);
      expect(shouldRetryAsForeign('EUR', true)).toBe(false);
    });
  });
});
