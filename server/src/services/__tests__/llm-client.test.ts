import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chatComplete, LlmUnavailableError, resetLlmClientStateForTests } from '../llm-client.js';

/**
 * Testy blokady DeepSeek w getConfig: hostname z new URL() zamiast regexa
 * na całym stringu. Regex blokował URL-e jedynie WSPOMINAJĄCE deepseek
 * (np. w query) i nie łapał wszystkich subdomen.
 */

function llmResponse(content: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: 'mock-model', choices: [{ message: { content } }] }),
    text: async () => '',
  } as unknown as Response;
}

const INPUT = { system: 'system', user: 'user' };

describe('chatComplete — blokada DeepSeek po hostname', () => {
  beforeEach(() => {
    process.env.LLM_API_KEY = 'test-key';
    delete process.env.GENERIC_IMPORT_LLM;
    resetLlmClientStateForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_BASE_URL;
  });

  it('dokładny host api.deepseek.com → zablokowane', async () => {
    process.env.LLM_BASE_URL = 'https://api.deepseek.com/v1';
    await expect(chatComplete(INPUT)).rejects.toThrow(/deepseek/i);
  });

  it('goły deepseek.com → zablokowane', async () => {
    process.env.LLM_BASE_URL = 'https://deepseek.com/v1';
    await expect(chatComplete(INPUT)).rejects.toThrow(/deepseek/i);
  });

  it('subdomena eu.api.deepseek.com → zablokowane', async () => {
    process.env.LLM_BASE_URL = 'https://eu.api.deepseek.com/v1';
    await expect(chatComplete(INPUT)).rejects.toThrow(/deepseek/i);
  });

  it('wielkość liter bez znaczenia (API.DEEPSEEK.COM) → zablokowane', async () => {
    process.env.LLM_BASE_URL = 'https://API.DEEPSEEK.COM/v1';
    await expect(chatComplete(INPUT)).rejects.toThrow(/deepseek/i);
  });

  it('deepseek tylko w query — NIE blokowane (stary regex dawał false positive)', async () => {
    process.env.LLM_BASE_URL = 'https://llm.example.com/v1?upstream=api.deepseek.com';
    const fetchMock = vi.fn().mockResolvedValue(llmResponse('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await chatComplete(INPUT);

    expect(result.content).toBe('{"ok":true}');
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('llm.example.com');
  });

  it('host podszywający się sufiksem (notdeepseek.com) — NIE blokowane', async () => {
    process.env.LLM_BASE_URL = 'https://notdeepseek.com/v1';
    const fetchMock = vi.fn().mockResolvedValue(llmResponse('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(chatComplete(INPUT)).resolves.toBeDefined();
  });

  it('niepoprawny URL → LlmUnavailableError zamiast wybuchu w fetch', async () => {
    process.env.LLM_BASE_URL = 'to-nie-jest-url';
    await expect(chatComplete(INPUT)).rejects.toThrow(LlmUnavailableError);
    await expect(chatComplete(INPUT)).rejects.toThrow(/poprawnym adresem URL/);
  });
});
