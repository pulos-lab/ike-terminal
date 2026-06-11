import { describe, it, expect } from 'vitest';
import { parseBossaTransactions } from '../bossa-transactions.js';

const CSV_HEADER = 'data;papier;isin;-;ilość;cena;wartość;prowizja;po prowizji;waluta';

function buildCsv(lines: string[]): string {
  return [CSV_HEADER, ...lines].join('\n');
}

describe('parseBossaTransactions — obligacje Catalyst', () => {
  it('skarbowa DS1030: kategoria bond, cena zostaje w % nominału', () => {
    // 10 szt @ 98,50% × nominał 1000 zł = 9850 zł
    const csv = buildCsv([
      '05.03.2024 10:00:00;DS1030;PL0000112736;K;10;98,50;9850,00;19,70;9869,70;PLN',
    ]);
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].category).toBe('bond');
    expect(result.data[0].price).toBe(98.5);
    expect(result.data[0].value).toBe(9850);
    expect(result.data[0].total).toBe(9869.7);
    expect(result.warnings).toBeUndefined();
  });

  it('korporacyjna z bond-map (KGH0631): kategoria bond', () => {
    const csv = buildCsv([
      '10.04.2024 11:00:00;KGH0631;PLO023600011;K;5;101,20;5060,00;10,00;5070,00;PLN',
    ]);
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].category).toBe('bond');
  });

  it('realny przykład z formularza Bossy: BST0327, nominał 100, wartość z narosłymi odsetkami', () => {
    // Zrzut formularza kupna 2026-06-11: 20 szt @ 101,50% × nominał 100 zł = 2030,00
    // + odsetki narosłe 0,17 zł/szt × 20 = 2033,40 przed prowizją; +5 zł prowizji = 2038,40.
    // Odchył 0,17% — poniżej progu 3%, więc import bez warningu.
    const csv = buildCsv([
      '11.06.2026 12:00:00;BST0327;PLBEST000333;K;20;101,50;2033,40;5,00;2038,40;PLN',
    ]);
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].category).toBe('bond');
    expect(result.data[0].price).toBe(101.5);
    expect(result.data[0].total).toBe(2038.4);
    expect(result.warnings).toBeUndefined();
  });

  it('skarbowa spoza mapy (regex serii): kategoria bond, nominał inferowany bez warningu', () => {
    // DS9999 nie istnieje w bond-map, ale pasuje do TREASURY_BOND_RE
    const csv = buildCsv([
      '05.03.2024 10:00:00;DS9999;PL0000999999;K;10;98,50;9850,00;19,70;9869,70;PLN',
    ]);
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data[0].category).toBe('bond');
    expect(result.warnings).toBeUndefined();
  });

  it('wartość z narosłymi odsetkami w granicach kuponu (~4%) → BEZ warningu', () => {
    // expected = 10 × 98,50% × 1000 = 9850; value 10250 → odchył ~3,9% — to legalne
    // odsetki narosłe (potwierdzone formularzem Bossy), nie błąd nominału.
    const csv = buildCsv([
      '05.03.2024 10:00:00;DS1030;PL0000112736;K;10;98,50;10250,00;19,70;10269,70;PLN',
    ]);
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.warnings).toBeUndefined();
  });

  it('realny przykład FPC0235 (BGK): odsetki 21,70/szt w wartości → BEZ warningu', () => {
    // Formularz Bossy 2026-06-11: 23 × 101,78% × 1000 = 23 409,40 + 21,70×23 = 23 908,50;
    // prowizja 45,43 → 23 953,93.
    const csv = buildCsv([
      '11.06.2026 12:00:00;FPC0235;PL0000500468;K;23;101,78;23908,50;45,43;23953,93;PLN',
    ]);
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.data[0].category).toBe('bond');
    expect(result.data[0].total).toBe(23953.93);
    expect(result.warnings).toBeUndefined();
  });

  it('wartość odbiegająca o rząd wielkości (błędny nominał) → warning, import bez blokady', () => {
    // expected = 10 × 98,50% × 1000 = 9850; value 985 → odchył 10× (pomyłka nominału 100 vs 1000)
    const csv = buildCsv([
      '05.03.2024 10:00:00;DS1030;PL0000112736;K;10;98,50;985,00;19,70;1004,70;PLN',
    ]);
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain('DS1030');
    expect(result.warnings![0]).toContain('nominał');
  });

  it('zwykła akcja: brak kategorii bond i brak warningu', () => {
    const csv = buildCsv([
      '25.02.2026 10:00:00;KGHM;PLKGHM000017;K;10;150,50;1505,00;5,00;1510,00;PLN',
    ]);
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data[0].category).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it('korporacyjna spoza bond-map z ISIN-em emitenta: NIE klasyfikowana jako bond', () => {
    // Wzorzec "3 litery + MMRR" celowo NIE wystarcza — tylko mapa lub seria skarbowa
    const csv = buildCsv([
      '05.03.2024 10:00:00;XYZ0630;PLXYZAB00012;K;10;99,00;990,00;2,00;992,00;PLN',
    ]);
    const result = parseBossaTransactions(csv, 'batch-test');

    expect(result.data[0].category).toBeUndefined();
  });
});
