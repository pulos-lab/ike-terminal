/**
 * Generyczny guard scrapowanego źródła danych: circuit breaker (jawne odcięcie
 * 429/403/challenge) + detekcja „cichej śmierci" markupu (200 OK, ale parsery
 * nic nie wyciągają — tak umarł Stooq) + powiadomienia przy przejściu stanu.
 *
 * Fabryka zamiast stanu module-level: wszyscy konsumenci jednego źródła
 * (np. biznesradar: ceny live, historia, katalog tickerów, kalendarz dywidend)
 * współdzielą JEDNĄ instancję (jedna prawda o odcięciu), a testy tworzą świeże
 * instancje z memory store i szpiegiem notify. Wiązanie produkcyjne dla
 * biznesradar: `biznesradar-guard.ts`.
 *
 * Dwa odrębne stany (inna reakcja admina):
 *  - `blocked` — anti-bot nas odciął; przeczekać (backoff), nie dobijać serwisu;
 *  - `suspectedMarkupChange` — źródło odpowiada 200, ale parsery zwracają pustkę
 *    na wielu RÓŻNYCH kluczach; wymaga naprawy parsera.
 *
 * Guard NIGDY nie rzuca (awaria store'a degraduje do pamięci) — siedzi na
 * gorącej ścieżce fetchy cen.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

/** Persystencja stanu guarda (dedup powiadomień + lastSuccessAt przeżywa deploy). */
export interface GuardStateStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** Store w price_history.db (lazy open, WAL) — wzorzec br_catalog_state. */
export function createSqliteGuardStore(source: string, dbFile: string): GuardStateStore {
  let db: Database.Database | null = null;
  function getDb(): Database.Database {
    if (!db) {
      if (dbFile !== ':memory:') {
        const dir = path.dirname(dbFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
      db = new Database(dbFile);
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS source_guard_state (
          source TEXT NOT NULL,
          key    TEXT NOT NULL,
          value  TEXT NOT NULL,
          PRIMARY KEY (source, key)
        );
      `);
    }
    return db;
  }
  return {
    get(key: string): string | null {
      const row = getDb()
        .prepare('SELECT value FROM source_guard_state WHERE source = ? AND key = ?')
        .get(source, key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    set(key: string, value: string): void {
      getDb()
        .prepare('INSERT OR REPLACE INTO source_guard_state (source, key, value) VALUES (?, ?, ?)')
        .run(source, key, value);
    },
  };
}

/** Store w pamięci — testy + degradacja, gdy SQLite niedostępny. */
export function createMemoryGuardStore(): GuardStateStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
  };
}

/** Ładunek powiadomienia — przekazywany do `notify` przy przejściu stanu. */
export interface SourceGuardAlert {
  source: string;
  kind: 'blocked' | 'markup-change';
  /** ISO — tylko dla kind='blocked'. */
  blockedUntil?: string;
  consecutiveBlocks?: number;
  /** Klucze z pustymi parse'ami — tylko dla kind='markup-change'. */
  missKeys?: string[];
  lastSuccessAt?: string | null;
}

/** Migawka stanu guarda — kształt pola `sources.<nazwa>` w /api/health. */
export interface SourceGuardState {
  blocked: boolean;
  blockedUntil: string | null;
  consecutiveBlocks: number;
  suspectedMarkupChange: boolean;
  parseMissKeys: string[];
  lastSuccessAt: string | null;
  lastNotified: { blocked: string | null; markupChange: string | null };
}

export interface SourceGuardOptions {
  /** Nazwa źródła (prefiks logów, pole alertu), np. 'biznesradar'. */
  name: string;
  /** Default: pamięć (bez persystencji). */
  store?: GuardStateStore;
  /** Wołane przy przejściu stanu (już po dedupie); błędy tylko logowane. */
  notify?: (alert: SourceGuardAlert) => void | Promise<void>;
  /** Zegar w ms — testy wstrzykują sterowany. */
  now?: () => number;
  /** Tyle blokad pod rząd otwiera bezpiecznik (default 3 — jak dotychczasowy breaker). */
  blockThreshold?: number;
  /** Cisza po odcięciu (default 30 min — jak dotychczasowy breaker). */
  blockBackoffMs?: number;
  /** Okno, w którym parse-missy się kumulują/wygasają (default 24 h). */
  missWindowMs?: number;
  /** Tyle RÓŻNYCH kluczy per-ticker w oknie podnosi podejrzenie markupu (default 3). */
  distinctMissThreshold?: number;
  /** Tyle KOLEJNYCH missów klucza strukturalnego (strona-singleton) podnosi alarm (default 2). */
  structuralMissThreshold?: number;
  /** Świeży sukces (dowolny klucz) młodszy niż to tłumi regułę distinct (default 15 min). */
  successGraceMs?: number;
  /** Max 1 powiadomienie / rodzaj stanu / tyle ms (default 24 h); dedup w store. */
  notifyDedupMs?: number;
  /** Throttle zapisu lastSuccessAt do store'a (default 10 min) — bez write'u per fetch. */
  persistSuccessThrottleMs?: number;
}

export interface SourceGuard {
  /** Bezpiecznik otwarty → konsument NIE rusza sieci (oddaje cache/pustkę). */
  isBlocked(): boolean;
  /** Odpowiedź rozpoznana jako blokada anti-bot (429/403/challenge). */
  registerBlock(): void;
  /** Udany parse; `key` czyści swój wpis parse-miss. Zeruje breaker. */
  registerSuccess(key?: string): void;
  /**
   * 200 OK, ale parser nic nie wyciągnął. `structural` = strona-singleton
   * (katalog, kalendarz), gdzie nie ma „różnych tickerów" — alarmuje reguła
   * kolejnych missów zamiast liczby różnych kluczy.
   */
  registerParseMiss(key: string, opts?: { structural?: boolean }): void;
  getState(): SourceGuardState;
}

interface MissEntry {
  lastAt: number;
  consecutive: number;
  structural: boolean;
}

export function createSourceGuard(options: SourceGuardOptions): SourceGuard {
  const {
    name,
    store = createMemoryGuardStore(),
    notify = () => {},
    now = Date.now,
    blockThreshold = 3,
    blockBackoffMs = 30 * 60 * 1000,
    missWindowMs = 24 * 60 * 60 * 1000,
    distinctMissThreshold = 3,
    structuralMissThreshold = 2,
    successGraceMs = 15 * 60 * 1000,
    notifyDedupMs = 24 * 60 * 60 * 1000,
    persistSuccessThrottleMs = 10 * 60 * 1000,
  } = options;

  // ── Stan w pamięci (backoff 30 min ≪ interwał deployów — celowo bez persystencji) ──
  let consecutiveBlocks = 0;
  let blockedUntilMs = 0;
  const missMap = new Map<string, MissEntry>();
  let lastMarkup = false; // ostatnio wyliczony stan markupu — do detekcji przejścia false→true

  // ── Lustro store'a (leniwie ładowane; przeżywa deploy) ─────────────────────
  let loaded = false;
  let lastSuccessAtMs: number | null = null;
  let lastPersistedSuccessMs: number | null = null;
  const lastNotifiedMs: { blocked: number | null; markupChange: number | null } = {
    blocked: null,
    markupChange: null,
  };

  function storeGet(key: string): string | null {
    try {
      return store.get(key);
    } catch (err) {
      console.error(`[${name}] guard store get(${key}) nie powiódł się:`, err);
      return null;
    }
  }

  function storeSet(key: string, value: string): void {
    try {
      store.set(key, value);
    } catch (err) {
      console.error(`[${name}] guard store set(${key}) nie powiódł się:`, err);
    }
  }

  function parseIsoMs(value: string | null): number | null {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }

  function ensureLoaded(): void {
    if (loaded) return;
    loaded = true;
    lastSuccessAtMs = parseIsoMs(storeGet('last_success'));
    lastPersistedSuccessMs = lastSuccessAtMs;
    lastNotifiedMs.blocked = parseIsoMs(storeGet('last_notified:blocked'));
    lastNotifiedMs.markupChange = parseIsoMs(storeGet('last_notified:markup_change'));
  }

  function pruneMisses(nowMs: number): void {
    for (const [key, entry] of missMap) {
      if (nowMs - entry.lastAt > missWindowMs) missMap.delete(key);
    }
  }

  /**
   * Warunek podejrzenia zmiany markupu (wyliczany, nie zatrzaskiwany):
   *  - ≥N RÓŻNYCH kluczy per-ticker w oknie I brak świeżego sukcesu (grace) —
   *    jeden delisted ticker nie przestrzeli, a sukcesy innych tłumią alarm; LUB
   *  - klucz strukturalny z ≥M KOLEJNYMI missami (kolejne próby stron-singletonów
   *    są naturalnie odseparowane ≥1 h przez retry-interval konsumentów).
   */
  function computeMarkup(nowMs: number): boolean {
    pruneMisses(nowMs);
    const entries = [...missMap.values()];
    const distinct = entries.filter((e) => !e.structural).length;
    const noFreshSuccess = lastSuccessAtMs === null || nowMs - lastSuccessAtMs > successGraceMs;
    if (distinct >= distinctMissThreshold && noFreshSuccess) return true;
    return entries.some((e) => e.structural && e.consecutive >= structuralMissThreshold);
  }

  function maybeNotify(kind: 'blocked' | 'markupChange', nowMs: number): void {
    const last = lastNotifiedMs[kind];
    if (last !== null && nowMs - last < notifyDedupMs) return;
    // Timestamp PRZED odpaleniem notify — chroni przed double-fire z równoległych przejść.
    lastNotifiedMs[kind] = nowMs;
    storeSet(
      kind === 'blocked' ? 'last_notified:blocked' : 'last_notified:markup_change',
      new Date(nowMs).toISOString(),
    );
    const lastSuccessIso =
      lastSuccessAtMs !== null ? new Date(lastSuccessAtMs).toISOString() : null;
    const alert: SourceGuardAlert =
      kind === 'blocked'
        ? {
            source: name,
            kind: 'blocked',
            blockedUntil: new Date(blockedUntilMs).toISOString(),
            consecutiveBlocks,
            lastSuccessAt: lastSuccessIso,
          }
        : {
            source: name,
            kind: 'markup-change',
            missKeys: [...missMap.keys()],
            lastSuccessAt: lastSuccessIso,
          };
    try {
      // notify wołane synchronicznie (testy widzą wywołanie od razu); async błędy łapane.
      void Promise.resolve(notify(alert)).catch((err) =>
        console.error(`[${name}] powiadomienie guarda nie powiodło się:`, err),
      );
    } catch (err) {
      console.error(`[${name}] powiadomienie guarda nie powiodło się:`, err);
    }
  }

  return {
    isBlocked(): boolean {
      return now() < blockedUntilMs;
    },

    registerBlock(): void {
      ensureLoaded();
      const nowMs = now();
      consecutiveBlocks += 1;
      if (consecutiveBlocks >= blockThreshold && nowMs >= blockedUntilMs) {
        blockedUntilMs = nowMs + blockBackoffMs;
        console.warn(
          `[${name}] wykryto odcięcie (${consecutiveBlocks} blokad pod rząd) — ` +
            `bezpiecznik otwarty do ${new Date(blockedUntilMs).toISOString()}. ` +
            `Fetch-e wstrzymane; sprawdź czy ${name} nie zmienił zabezpieczeń.`,
        );
        maybeNotify('blocked', nowMs);
      }
    },

    registerSuccess(key?: string): void {
      ensureLoaded();
      const nowMs = now();
      consecutiveBlocks = 0;
      blockedUntilMs = 0;
      lastSuccessAtMs = nowMs;
      if (
        lastPersistedSuccessMs === null ||
        nowMs - lastPersistedSuccessMs >= persistSuccessThrottleMs
      ) {
        lastPersistedSuccessMs = nowMs;
        storeSet('last_success', new Date(nowMs).toISOString());
      }
      if (key) missMap.delete(key);
      // Epizod markup-change zamyka się po cichu (bez maila „wróciło").
      lastMarkup = computeMarkup(nowMs);
    },

    registerParseMiss(key: string, opts?: { structural?: boolean }): void {
      ensureLoaded();
      const nowMs = now();
      const prev = missMap.get(key);
      missMap.set(key, {
        lastAt: nowMs,
        consecutive: (prev?.consecutive ?? 0) + 1,
        structural: opts?.structural ?? prev?.structural ?? false,
      });
      const markup = computeMarkup(nowMs);
      if (markup && !lastMarkup) {
        console.warn(
          `[${name}] podejrzenie zmiany markupu — parsery nic nie wyciągają ` +
            `(klucze: ${[...missMap.keys()].join(', ')}). Sprawdź strukturę stron źródła.`,
        );
        maybeNotify('markupChange', nowMs);
      }
      lastMarkup = markup;
    },

    getState(): SourceGuardState {
      ensureLoaded();
      const nowMs = now();
      const markup = computeMarkup(nowMs);
      lastMarkup = markup;
      return {
        blocked: nowMs < blockedUntilMs,
        blockedUntil: blockedUntilMs > 0 ? new Date(blockedUntilMs).toISOString() : null,
        consecutiveBlocks,
        suspectedMarkupChange: markup,
        parseMissKeys: [...missMap.keys()],
        lastSuccessAt: lastSuccessAtMs !== null ? new Date(lastSuccessAtMs).toISOString() : null,
        lastNotified: {
          blocked:
            lastNotifiedMs.blocked !== null ? new Date(lastNotifiedMs.blocked).toISOString() : null,
          markupChange:
            lastNotifiedMs.markupChange !== null
              ? new Date(lastNotifiedMs.markupChange).toISOString()
              : null,
        },
      };
    },
  };
}
