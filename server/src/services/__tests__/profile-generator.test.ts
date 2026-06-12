import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateProfileFromContent, selfCheck } from '../profile-generator.js';
import { LlmUnavailableError, resetLlmClientStateForTests } from '../llm-client.js';
import { validateImportProfile } from 'shared';

/**
 * Testy generatora profili — LLM mockowany przez vi.stubGlobal('fetch').
 * Scenariusze z planu: valid / broken-JSON / schema-violating / low-confidence
 * / unavailable. Self-check biegnie na PRAWDZIWYM silniku (bez mocków).
 */

const CSV = [
  'Trade date|Security|ISIN code|Direction|Shares|Unit price|Ccy',
  '2025-03-15|CD PROJEKT|PLOPTTC00011|BUY|10|100.00|PLN',
  '2025-04-10|KGHM|PLKGHM000017|SELL|5|150.00|PLN',
  '2025-05-02|PKN ORLEN|PLPKN0000018|BUY|20|62.00|PLN',
].join('\n');

/** Poprawny profil dla CSV powyżej — taki powinien zwrócić "dobry" LLM. */
const GOOD_PROFILE = {
  specVersion: 1,
  brokerLabel: 'Testowy Broker',
  file: { delimiter: '|', headerRow: { strategy: 'first' } },
  classify: [
    { id: 'trade', when: [{ col: { name: 'Trade date' }, op: 'notEmpty' }], emit: 'trade' },
  ],
  defaultClass: 'skip',
  trade: {
    date: { source: { kind: 'column', col: { name: 'Trade date' } }, formats: ['YYYY-MM-DD'] },
    paperName: { kind: 'column', col: { name: 'Security' } },
    isin: { kind: 'column', col: { name: 'ISIN code' } },
    quantity: { kind: 'column', col: { name: 'Shares' } },
    price: { kind: 'column', col: { name: 'Unit price' } },
    currency: { kind: 'column', col: { name: 'Ccy' }, fallback: 'PLN' },
    side: {
      strategy: 'column',
      col: { name: 'Direction' },
      buyValues: ['BUY'],
      sellValues: ['SELL'],
    },
  },
};

/** Profil przechodzący zod, ale mapujący ZŁE kolumny (cena ← Direction). */
const BAD_MAPPING_PROFILE = {
  ...GOOD_PROFILE,
  trade: { ...GOOD_PROFILE.trade, price: { kind: 'column', col: { name: 'Direction' } } },
};

function llmResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: 'mock-model', choices: [{ message: { content } }] }),
    text: async () => '',
  } as unknown as Response;
}

describe('generateProfileFromContent (mock fetch)', () => {
  beforeEach(() => {
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_BASE_URL = 'https://mock.example/v1';
    delete process.env.GENERIC_IMPORT_LLM;
    resetLlmClientStateForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
  });

  it('poprawny profil za pierwszym razem → profile + wysoka pewność', async () => {
    const fetchMock = vi.fn().mockResolvedValue(llmResponse(JSON.stringify(GOOD_PROFILE)));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateProfileFromContent(CSV);

    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(1);
    expect(result!.confidence).toBe(1);
    expect(result!.profile.brokerLabel).toBe('Testowy Broker');
    expect(result!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // Payload requesta: zredagowana próbka, json_schema w response_format
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.messages[1].content).toContain('ISIN code');
  });

  it('zepsuty JSON w 1. próbie → retry z feedbackiem → sukces w 2.', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(llmResponse('to nie jest json {'))
      .mockResolvedValueOnce(llmResponse('```json\n' + JSON.stringify(GOOD_PROFILE) + '\n```'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateProfileFromContent(CSV);

    expect(result).not.toBeNull();
    expect(result!.attempts).toBe(2);
    // Feedback z błędem doklejony do 2. promptu
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(secondBody.messages[1].content).toContain('Previous attempt was rejected');
  });

  it('profil łamiący schemat → feedback z błędami zod; 3× źle → null', async () => {
    const broken = JSON.stringify({ specVersion: 1, brokerLabel: 'X' }); // brak file/classify
    const fetchMock = vi.fn().mockResolvedValue(llmResponse(broken));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateProfileFromContent(CSV);

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 + 2 retry
  });

  it('niska pewność (złe mapowanie kolumn) → retry → null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(llmResponse(JSON.stringify(BAD_MAPPING_PROFILE)));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateProfileFromContent(CSV);

    expect(result).toBeNull();
    // Feedback self-checku w retry promptach (złe mapowanie ceny → wszystkie
    // wiersze odpadają na invalid_price → ścieżka "emitted ZERO")
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(retryBody.messages[1].content).toMatch(/parsed only|Re-examine|emitted ZERO/);
  });

  it('brak klucza API → LlmUnavailableError (route mapuje na 503)', async () => {
    delete process.env.LLM_API_KEY;
    await expect(generateProfileFromContent(CSV)).rejects.toThrow(LlmUnavailableError);
  });

  it('GENERIC_IMPORT_LLM=off → LlmUnavailableError mimo klucza', async () => {
    process.env.GENERIC_IMPORT_LLM = 'off';
    await expect(generateProfileFromContent(CSV)).rejects.toThrow(LlmUnavailableError);
    delete process.env.GENERIC_IMPORT_LLM;
  });

  it('LLM_BASE_URL=api.deepseek.com → zablokowane (decyzja prywatności)', async () => {
    process.env.LLM_BASE_URL = 'https://api.deepseek.com/v1';
    await expect(generateProfileFromContent(CSV)).rejects.toThrow(/deepseek/i);
  });

  it('dostawca bez json_schema → automatyczny fallback na json_object', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Invalid response_format: json_schema is not supported',
        json: async () => ({}),
      } as unknown as Response)
      .mockResolvedValueOnce(llmResponse(JSON.stringify(GOOD_PROFILE)));
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateProfileFromContent(CSV);

    expect(result).not.toBeNull();
    const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(retryBody.response_format.type).toBe('json_object');
  });

  it('redakcja payloadu: numer rachunku z próbki nie trafia do promptu', async () => {
    const csvWithAccount = [
      'Trade date|Security|ISIN code|Direction|Shares|Unit price|Ccy|Account number',
      '2025-03-15|CD PROJEKT|PLOPTTC00011|BUY|10|100.00|PLN|PL61109010140000071219812874',
    ].join('\n');
    const fetchMock = vi.fn().mockResolvedValue(llmResponse(JSON.stringify(GOOD_PROFILE)));
    vi.stubGlobal('fetch', fetchMock);

    await generateProfileFromContent(csvWithAccount);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[1].content).not.toContain('109010140000');
    expect(body.messages[1].content).toContain('PLOPTTC00011'); // ISIN zostaje
  });
});

describe('selfCheck — deterministyczna ocena profilu', () => {
  it('dobry profil → confidence 1', () => {
    const validation = validateImportProfile(GOOD_PROFILE);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const check = selfCheck(CSV, validation.profile);
    expect(check.ok).toBe(true);
    expect(check.confidence).toBe(1);
    expect(check.emitted).toBe(3);
  });

  it('złe mapowanie ceny → niska pewność z powodami', () => {
    const validation = validateImportProfile(BAD_MAPPING_PROFILE);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const check = selfCheck(CSV, validation.profile);
    expect(check.confidence).toBeLessThan(0.8);
    expect(check.topReasons.join(',')).toContain('invalid_price');
  });

  it('śmieci w walucie (nieznany kod ISO) → niska pewność mimo poprawnych kwot', () => {
    // Realny przypadek z dry-runu: regex wyciągał fragmenty tickerów ("IMI",
    // "SAC") do waluty — kwoty się zgadzały, więc bez sanity-checku walut
    // profil dostawał pewność 1.
    const garbageCurrencyProfile = {
      ...GOOD_PROFILE,
      trade: { ...GOOD_PROFILE.trade, currency: { kind: 'const', value: 'IMI' } },
    };
    const validation = validateImportProfile(garbageCurrencyProfile);
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const check = selfCheck(CSV, validation.profile);
    expect(check.confidence).toBeLessThan(0.8);
    expect(check.topReasons.join(',')).toContain('suspicious_currency');
  });
});
