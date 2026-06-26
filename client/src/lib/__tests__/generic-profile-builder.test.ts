import { describe, it, expect } from 'vitest';
import {
  adoptProfileForDocument,
  buildProfileFromDraft,
  detectDateFormat,
  scoreDraft,
  suggestDraft,
  suggestRules,
  suggestSideValues,
  type ProfileDraft,
} from '../generic-profile-builder';
import { validateImportProfile } from 'shared';

/**
 * Testy czystej logiki kreatora importu uniwersalnego:
 * heurystyczny prefill z nagłówków + budowa profilu z draftu.
 */

const HEADERS = ['Trade date', 'Security', 'ISIN code', 'Direction', 'Shares', 'Unit price', 'Ccy'];
const SAMPLE = [
  ['2025-03-15', 'CD PROJEKT', 'PLOPTTC00011', 'BUY', '10', '100.00', 'PLN'],
  ['2025-04-10', 'KGHM', 'PLKGHM000017', 'SELL', '5', '150.00', 'PLN'],
];

describe('suggestDraft — heurystyczny prefill', () => {
  it('rozpoznaje kolumny po nazwach (EN) i wartości strony z próbki', () => {
    const draft = suggestDraft(HEADERS, SAMPLE, { delimiter: '|', headerRowIndex: 0 });

    expect(draft.trade.dateCol).toBe(0);
    expect(draft.trade.paperNameCol).toBe(1);
    expect(draft.trade.isinCol).toBe(2);
    expect(draft.trade.quantityCol).toBe(4);
    expect(draft.trade.priceCol).toBe(5);
    expect(draft.trade.currencyCol).toBe(6);
    expect(draft.trade.sideStrategy).toBe('column');
    expect(draft.trade.sideCol).toBe(3);
    expect(draft.trade.buyValues).toBe('BUY');
    expect(draft.trade.sellValues).toBe('SELL');
    expect(draft.trade.dateFormat).toBe('YYYY-MM-DD');
  });

  it('Trading 212: kolumna „Action" → strona z kolumny + wartości Market buy/sell', () => {
    const headers = ['Action', 'Time', 'ISIN', 'Ticker', 'Name', 'No. of shares', 'Price / share'];
    const sample = [
      ['Market buy', '2023-12-18 14:30', 'US17275R1023', 'CSCO', 'Cisco', '0.3069000000', '49.96'],
      ['Market sell', '2023-12-26 14:30', 'US04634X2027', 'ASTR', 'Astra', '1.5', '1.26'],
      ['Dividend (Dividend)', '2023-12-27', 'US56035L1044', 'MAIN', 'Main', '0.5', '0.23'],
    ];
    const draft = suggestDraft(headers, sample, { delimiter: ',', headerRowIndex: 0 });

    expect(draft.trade.sideStrategy).toBe('column');
    expect(draft.trade.sideCol).toBe(0); // „Action", nie „No. of shares"
    expect(draft.trade.buyValues).toContain('Market buy');
    expect(draft.trade.sellValues).toContain('Market sell');
    // Strona rozpoznana → karta luki „side" się nie pokaże.
    expect(scoreDraft(draft, sample).fields.side).toBe('ok');
  });

  it('rozpoznaje polskie nagłówki (Bossa-podobne)', () => {
    const headers = ['data', 'papier', 'isin', 'ilość', 'cena', 'waluta'];
    const sample = [['25.02.2026 09:47:27', 'KGHM', 'PLKGHM000017', '10', '150,50', 'PLN']];
    const draft = suggestDraft(headers, sample, { delimiter: ';', headerRowIndex: 0 });

    expect(draft.trade.dateCol).toBe(0);
    expect(draft.trade.paperNameCol).toBe(1);
    expect(draft.trade.quantityCol).toBe(3);
    expect(draft.trade.priceCol).toBe(4);
    expect(draft.trade.dateFormat).toBe('DD.MM.YYYY');
  });
});

describe('suggestSideValues — wartości kupna/sprzedaży z kolumny', () => {
  it('rozpoznaje prefiksowane wartości (Market buy/sell), ignoruje inne typy', () => {
    const sample = [['Market buy'], ['Market sell'], ['Dividend (Dividend)'], ['Deposit']];
    const sv = suggestSideValues(sample, 0)!;
    expect(sv.buyValues).toBe('Market buy');
    expect(sv.sellValues).toBe('Market sell');
  });

  it('zwraca null, gdy żadna wartość nie wygląda na kupno/sprzedaż', () => {
    expect(suggestSideValues([['Dividend'], ['Deposit']], 0)).toBeNull();
    expect(suggestSideValues([['x']], -1)).toBeNull();
  });
});

describe('scoreDraft — skan pewności mapowania', () => {
  it('pełne transakcje z kolumną strony → complete, brak luk', () => {
    const draft = suggestDraft(HEADERS, SAMPLE, { delimiter: '|', headerRowIndex: 0 });
    const score = scoreDraft(draft, SAMPLE);
    expect(score.verdict).toBe('complete');
    expect(score.gaps).toEqual([]);
    expect(score.fields.side).toBe('ok');
  });

  it('brak kolumny strony + dodatnie ilości → near z luką „side"', () => {
    const headers = ['data', 'papier', 'ilość', 'cena', 'waluta'];
    const sample = [
      ['2025-01-10', 'KGHM', '10', '150,50', 'PLN'],
      ['2025-02-11', 'CD PROJEKT', '5', '120,00', 'PLN'],
    ];
    const draft = suggestDraft(headers, sample, { delimiter: ';', headerRowIndex: 0 });
    const score = scoreDraft(draft, sample);
    expect(score.verdict).toBe('near');
    expect(score.gaps).toContain('side');
    expect(score.fields.date).toBe('ok');
    expect(score.fields.quantity).toBe('ok');
  });

  it('plik operacji (kwota bez ilości/ceny) → incomplete + operationsLike', () => {
    const headers = ['data', 'tytuł operacji', 'kwota', 'waluta'];
    const sample = [
      ['2025-01-10', 'Dywidenda KGHM', '12,50', 'PLN'],
      ['2025-02-01', 'Wpłata środków', '1000,00', 'PLN'],
    ];
    const draft = suggestDraft(headers, sample, { delimiter: ';', headerRowIndex: 0 });
    const score = scoreDraft(draft, sample);
    expect(score.verdict).toBe('incomplete');
    expect(score.operationsLike).toBe(true);
  });

  it('brak kolumny daty → incomplete', () => {
    const headers = ['papier', 'ilość', 'cena'];
    const sample = [['KGHM', '10', '150']];
    const draft = suggestDraft(headers, sample, { delimiter: ';', headerRowIndex: 0 });
    expect(scoreDraft(draft, sample).verdict).toBe('incomplete');
    expect(scoreDraft(draft, sample).fields.date).toBe('missing');
  });
});

describe('suggestRules — sugestia reguł z opisu', () => {
  it('mapuje słowa-klucze opisu na typy (podatek > dywidenda)', () => {
    const headers = ['data', 'tytuł operacji', 'kwota', 'waluta'];
    const sample = [
      ['2025-01-10', 'Dywidenda KGHM', '12,50', 'PLN'],
      ['2025-02-01', 'Podatek od dywidendy', '-2,38', 'PLN'],
      ['2025-03-01', 'Wpłata środków', '1000,00', 'PLN'],
      ['2025-04-01', 'Wypłata środków', '-500,00', 'PLN'],
    ];
    const { descriptionCol, rules } = suggestRules(headers, sample);
    expect(descriptionCol).toBe(1);
    const emits = rules.map((r) => r.emit);
    expect(emits).toContain('withholding_tax');
    expect(emits).toContain('dividend');
    expect(emits).toContain('deposit');
    expect(emits).toContain('withdrawal');
    // Reguły zasiane z opisu budują poprawny profil reguł.
    const draft = suggestDraft(headers, sample, { delimiter: ';', headerRowIndex: 0 });
    draft.mode = 'rules';
    draft.classify = rules;
    draft.cash.descriptionCol = descriptionCol;
    expect(buildProfileFromDraft(draft).ok).toBe(true);
  });

  it('brak kolumny opisu → brak reguł', () => {
    const { rules } = suggestRules(['data', 'ilość', 'cena'], [['2025-01-01', '10', '100']]);
    expect(rules).toEqual([]);
  });
});

describe('detectDateFormat', () => {
  it('rozstrzyga DD/MM vs MM/DD po zawartości', () => {
    expect(detectDateFormat(['25/03/2025'])).toBe('DD/MM/YYYY');
    expect(detectDateFormat(['03/25/2025'])).toBe('MM/DD/YYYY');
    expect(detectDateFormat(['05/03/2025'])).toBe('DD/MM/YYYY'); // niejednoznaczne → DD/MM
  });
});

describe('buildProfileFromDraft', () => {
  const baseDraft = (): ProfileDraft =>
    suggestDraft(HEADERS, SAMPLE, { delimiter: '|', headerRowIndex: 0 });

  it('tryb all-trades → poprawny profil przechodzący walidację schematu', () => {
    const draft = baseDraft();
    draft.brokerLabel = 'Testowy';
    const result = buildProfileFromDraft(draft);

    expect(result.ok).toBe(true);
    const validation = validateImportProfile(result.profile);
    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.profile.brokerLabel).toBe('Testowy');
      expect(validation.profile.classify[0].emit).toBe('trade');
      expect(validation.profile.needsNameResolution).toBe(false); // ISIN jest
    }
  });

  it('brak kolumny ISIN → needsNameResolution=true', () => {
    const draft = baseDraft();
    draft.trade.isinCol = -1;
    const result = buildProfileFromDraft(draft);

    expect(result.ok).toBe(true);
    expect((result.profile as { needsNameResolution?: boolean }).needsNameResolution).toBe(true);
  });

  it('preludium metadanych (headerRowIndex>0) → headerRow scan z sygnaturą', () => {
    const draft = baseDraft();
    draft.headerRowIndex = 12;
    const result = buildProfileFromDraft(draft);

    expect(result.ok).toBe(true);
    const file = (result.profile as { file: { headerRow: { strategy: string } } }).file;
    expect(file.headerRow.strategy).toBe('scan');
  });

  it('tryb rules: reguły + wspólne mapowanie cash powielone per klasa', () => {
    const headers = ['data', 'tytuł operacji', 'kwota', 'waluta'];
    const draft = suggestDraft(headers, [['2025-01-10', 'Przelew', '100,00', 'PLN']], {
      delimiter: ';',
      headerRowIndex: 0,
    });
    draft.mode = 'rules';
    draft.defaultClass = 'other';
    draft.classify = [
      { id: 'r1', colIndex: 1, op: 'contains', values: 'Przelew', emit: 'deposit' },
      { id: 'r2', colIndex: 1, op: 'contains', values: 'dywidendy', emit: 'dividend' },
    ];
    const result = buildProfileFromDraft(draft);

    expect(result.ok).toBe(true);
    const profile = result.profile as Record<string, unknown>;
    expect(profile.deposit).toBeDefined();
    expect(profile.dividend).toBeDefined();
    expect(profile.other).toBeDefined(); // defaultClass=other wymaga mapowania
    expect(validateImportProfile(profile).ok).toBe(true);
  });

  it('czytelne błędy PL przy brakach (kolumna daty, wartości reguły)', () => {
    const draft = baseDraft();
    draft.trade.dateCol = -1;
    const result = buildProfileFromDraft(draft);

    expect(result.ok).toBe(false);
    expect(result.errors!.some((e) => e.includes('kolumnę daty'))).toBe(true);

    const rulesDraft = baseDraft();
    rulesDraft.mode = 'rules';
    rulesDraft.classify = [{ id: 'r1', colIndex: 1, op: 'contains', values: '', emit: 'deposit' }];
    const rulesResult = buildProfileFromDraft(rulesDraft);
    expect(rulesResult.ok).toBe(false);
    expect(rulesResult.errors!.some((e) => e.includes('wartości'))).toBe(true);
  });
});

describe('adoptProfileForDocument — P1 adopcja podobnego profilu', () => {
  const sourceProfile = (): unknown => {
    const draft = suggestDraft(HEADERS, SAMPLE, { delimiter: '|', headerRowIndex: 0 });
    draft.brokerLabel = 'Źródłowy';
    const built = buildProfileFromDraft(draft);
    if (!built.ok) throw new Error('fixture profilu niepoprawny');
    return built.profile;
  };

  it('nadpisuje delimiter pliku docelowego i zachowuje resztę mapowania', () => {
    const adopted = adoptProfileForDocument(sourceProfile(), { delimiter: ';' }) as {
      file: { delimiter: string; sheet?: string };
      brokerLabel: string;
    };
    expect(adopted.file.delimiter).toBe(';');
    expect(adopted.brokerLabel).toBe('Źródłowy');
    expect('sheet' in adopted.file).toBe(false); // CSV → bez arkusza
    expect(validateImportProfile(adopted).ok).toBe(true);
  });

  it('dla XLSX ustawia nazwę arkusza (marker fingerprintu)', () => {
    const adopted = adoptProfileForDocument(sourceProfile(), {
      delimiter: ';',
      sheet: 'CASH OPERATION HISTORY',
    }) as { file: { sheet?: string } };
    expect(adopted.file.sheet).toBe('CASH OPERATION HISTORY');
  });

  it('zwraca głęboki klon — nie mutuje źródła', () => {
    const src = sourceProfile() as { file: { delimiter: string } };
    const adopted = adoptProfileForDocument(src, { delimiter: ',' }) as {
      file: { delimiter: string };
    };
    expect(adopted.file.delimiter).toBe(',');
    expect(src.file.delimiter).toBe('|'); // źródło nietknięte
  });
});
