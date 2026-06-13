import { getImportsDb } from '../db/imports-db.js';

/**
 * Dzienny limit generacji AI per użytkownik — anty-spam najdroższego zasobu.
 *
 * Endpoint generate-profile to jedyne miejsce, gdzie zalogowany użytkownik
 * może wywołać płatne API (każdy NOWY fingerprint = wywołanie LLM; trafienie
 * w bibliotekę nic nie kosztuje). Limit liczy PRÓBY, nie sukcesy — nieudana
 * generacja (3 podejścia modelu) kosztuje tokeny tak samo.
 *
 * Konstrukcja bez nowej infrastruktury:
 * - licznik prób w pamięci procesu (per użytkownik per dzień UTC),
 * - po restarcie serwera pamięć znika, ale zapisane SUKCESY zostają
 *   w import_profiles (created_by_user_id + generated_by='llm') — bierzemy
 *   max(pamięć, baza), więc restart nie zeruje limitu w całości.
 *
 * Env: GENERIC_IMPORT_LLM_DAILY_LIMIT (domyślnie 20; 0/ujemna = wyłączony).
 * Uczciwy użytkownik z kilkoma plikami brokera nigdy limitu nie zobaczy.
 */

const DEFAULT_DAILY_LIMIT = 20;

/** Klucz `${userId}:${YYYY-MM-DD}` → liczba prób od startu procesu. */
const attempts = new Map<string, number>();

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function llmDailyLimit(): number {
  const raw = process.env.GENERIC_IMPORT_LLM_DAILY_LIMIT;
  if (raw === undefined || raw === '') return DEFAULT_DAILY_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : DEFAULT_DAILY_LIMIT;
}

/** Ile generacji użytkownik zużył dziś: max(próby w pamięci, sukcesy w bazie). */
export function llmGenerationsUsedToday(userId: string): number {
  const inMemory = attempts.get(`${userId}:${dayKey()}`) ?? 0;
  const persisted = (
    getImportsDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM import_profiles
         WHERE created_by_user_id = ? AND generated_by = 'llm'
           AND date(created_at) = date('now')`,
      )
      .get(userId) as { n: number }
  ).n;
  return Math.max(inMemory, persisted);
}

/** Czy użytkownik może odpalić kolejną generację (limit ≤0 = bez limitu). */
export function llmQuotaExceeded(userId: string): boolean {
  const limit = llmDailyLimit();
  if (limit <= 0) return false;
  return llmGenerationsUsedToday(userId) >= limit;
}

/** Zarejestruj próbę generacji (wywołać PRZED startem) + sprzątnij stare dni. */
export function registerLlmGenerationAttempt(userId: string): void {
  const today = dayKey();
  const key = `${userId}:${today}`;
  attempts.set(key, (attempts.get(key) ?? 0) + 1);
  for (const k of attempts.keys()) {
    if (!k.endsWith(`:${today}`)) attempts.delete(k);
  }
}

/** Wyłącznie dla testów. */
export function resetLlmQuotaForTests(): void {
  attempts.clear();
}
