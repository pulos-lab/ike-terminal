/**
 * Klient LLM dla generatora profili importu — provider-agnostyczny.
 *
 * Zwykły `fetch` do endpointu chat completions w formacie OpenAI-compatible
 * (Mistral La Plateforme, Scaleway Generative APIs, OVHcloud AI Endpoints…).
 * Zmiana dostawcy = zmiana env, nie kodu.
 *
 * Env:
 * - LLM_BASE_URL    — domyślnie https://api.mistral.ai/v1 (Mistral: firma EU,
 *                     rezydencja danych w EU, natywny structured output),
 * - LLM_API_KEY     — wymagany; brak = LLM wyłączony (ścieżka ręczna działa),
 * - LLM_MODEL       — domyślnie mistral-small-latest,
 * - LLM_TIMEOUT_MS  — domyślnie 60000,
 * - GENERIC_IMPORT_LLM=off — twardy wyłącznik funkcji.
 *
 * PRYWATNOŚĆ (decyzja produktowa): do API trafiają WYŁĄCZNIE nagłówki i
 * zredagowana próbka (sample-redactor) — nigdy pełny plik. Bezpośrednie
 * api.deepseek.com jest ZABLOKOWANE (przetwarzanie danych w Chinach);
 * modele DeepSeek można używać przez hosta EU (Scaleway/OVH).
 */

const DEFAULT_BASE_URL = 'https://api.mistral.ai/v1';
const DEFAULT_MODEL = 'mistral-small-latest';
const DEFAULT_TIMEOUT_MS = 60_000;

/** LLM niedostępny (brak konfiguracji / wyłączony / sieć) → route mapuje na 503. */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/** Błąd żądania (4xx/5xx z API) — komunikat techniczny do logów/retry. */
export class LlmRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LlmRequestError';
    this.status = status;
  }
}

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** Czy generacja LLM jest skonfigurowana i włączona. */
export function isLlmEnabled(): boolean {
  if ((process.env.GENERIC_IMPORT_LLM ?? '').toLowerCase() === 'off') return false;
  return Boolean(process.env.LLM_API_KEY);
}

function getConfig(): LlmConfig {
  if (!isLlmEnabled()) {
    throw new LlmUnavailableError(
      'Generator mapowań (AI) jest wyłączony — brak klucza LLM_API_KEY. ' +
        'Możesz zmapować kolumny ręcznie.',
    );
  }
  const baseUrl = (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (/api\.deepseek\.com/i.test(baseUrl)) {
    // Decyzja produktowa: dane klientów nie mogą iść do api.deepseek.com (Chiny).
    throw new LlmUnavailableError(
      'LLM_BASE_URL wskazuje na api.deepseek.com — niedozwolone (przetwarzanie danych ' +
        'poza EU). Użyj dostawcy z rezydencją EU (Mistral, Scaleway, OVHcloud).',
    );
  }
  return {
    baseUrl,
    apiKey: process.env.LLM_API_KEY!,
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

export interface ChatCompleteInput {
  system: string;
  user: string;
  /**
   * JSON Schema odpowiedzi (structured output). Mistral wspiera natywnie;
   * dostawcy bez json_schema dostają automatyczny fallback na json_object —
   * pętla walidacji zod w generatorze i tak jest obowiązkowa.
   */
  jsonSchema?: Record<string, unknown>;
}

export interface ChatCompleteResult {
  content: string;
  model: string;
}

/** Czy dostawca odrzucił format json_schema (→ fallback na json_object). */
let jsonSchemaUnsupported = false;

export async function chatComplete(input: ChatCompleteInput): Promise<ChatCompleteResult> {
  const config = getConfig();

  const attempt = async (useJsonSchema: boolean): Promise<ChatCompleteResult> => {
    const responseFormat =
      input.jsonSchema && useJsonSchema
        ? {
            type: 'json_schema',
            json_schema: { name: 'import_profile', schema: input.jsonSchema, strict: false },
          }
        : { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          response_format: responseFormat,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new LlmUnavailableError(
        `Usługa AI nie odpowiada (${(err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message}) — możesz zmapować kolumny ręcznie.`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Dostawca bez json_schema → przełącz na json_object i ponów raz.
      if (
        useJsonSchema &&
        (response.status === 400 || response.status === 422) &&
        /response_format|json_schema/i.test(body)
      ) {
        jsonSchemaUnsupported = true;
        return attempt(false);
      }
      if (response.status === 401 || response.status === 403) {
        throw new LlmUnavailableError(
          'Usługa AI odrzuciła klucz API (401/403) — sprawdź LLM_API_KEY.',
        );
      }
      throw new LlmRequestError(
        `LLM HTTP ${response.status}: ${body.slice(0, 300)}`,
        response.status,
      );
    }

    const json = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new LlmRequestError(
        'LLM zwrócił pustą odpowiedź (brak choices[0].message.content)',
        502,
      );
    }
    return { content, model: json.model ?? config.model };
  };

  return attempt(!jsonSchemaUnsupported);
}

/** Reset cache'owanej flagi fallbacku — wyłącznie dla testów. */
export function resetLlmClientStateForTests(): void {
  jsonSchemaUnsupported = false;
}
