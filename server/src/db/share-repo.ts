import { randomBytes } from 'crypto';
import { getAuthDb } from '../auth.js';
import type { PortfolioShare, ShareSettingsInput, ShareValidity } from 'shared';

/**
 * Repozytorium publicznych linków portfeli (tabela portfolio_shares w auth.db).
 *
 * Lookup publiczny działa wyłącznie po tokenie (bez portfolioId), dlatego
 * tabela żyje w auth.db, nie w bazach per-portfel. UNIQUE(portfolioId)
 * egzekwuje regułę "jeden aktywny link na portfel" na poziomie DB.
 */

/** 24 bajty → 32 znaki base64url, 192 bity entropii. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{32}$/;

const VALIDITY_DAYS: Record<Exclude<ShareValidity, 'indefinite'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

interface ShareRow {
  token: string;
  portfolioId: string;
  scope: string;
  showAmounts: number;
  benchmark: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

function rowToShare(row: ShareRow): PortfolioShare {
  return {
    token: row.token,
    portfolioId: row.portfolioId,
    scope: row.scope as PortfolioShare['scope'],
    showAmounts: row.showAmounts === 1,
    benchmark: row.benchmark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}

/** expiresAt liczone serwerowo z presetu — nigdy nie ufamy dacie od klienta. */
function computeExpiresAt(validity: ShareValidity): string | null {
  if (validity === 'indefinite') return null;
  const days = VALIDITY_DAYS[validity];
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  // Format zgodny z SQLite datetime('now'): "YYYY-MM-DD HH:MM:SS" (UTC)
  return expires.toISOString().slice(0, 19).replace('T', ' ');
}

export function isValidTokenFormat(token: string): boolean {
  return TOKEN_FORMAT.test(token);
}

/**
 * Zwraca aktywny share dla tokenu albo null (nieistniejący/wygasły).
 * Wygasłe wiersze są kasowane leniwie przy lookupie.
 */
export function getShareByToken(token: string): PortfolioShare | null {
  if (!isValidTokenFormat(token)) return null;
  const db = getAuthDb();
  const row = db.prepare('SELECT * FROM portfolio_shares WHERE token = ?').get(token) as
    | ShareRow
    | undefined;
  if (!row) return null;
  if (row.expiresAt !== null && row.expiresAt <= nowUtc()) {
    db.prepare('DELETE FROM portfolio_shares WHERE token = ?').run(token);
    return null;
  }
  return rowToShare(row);
}

export function getShareForPortfolio(portfolioId: string): PortfolioShare | null {
  const db = getAuthDb();
  const row = db
    .prepare('SELECT * FROM portfolio_shares WHERE portfolioId = ?')
    .get(portfolioId) as ShareRow | undefined;
  if (!row) return null;
  if (row.expiresAt !== null && row.expiresAt <= nowUtc()) {
    db.prepare('DELETE FROM portfolio_shares WHERE portfolioId = ?').run(portfolioId);
    return null;
  }
  return rowToShare(row);
}

/** Rzuca przy naruszeniu UNIQUE(portfolioId) — router mapuje to na 409. */
export function createShare(portfolioId: string, settings: ShareSettingsInput): PortfolioShare {
  const db = getAuthDb();
  const token = randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO portfolio_shares (token, portfolioId, scope, showAmounts, benchmark, expiresAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    token,
    portfolioId,
    settings.scope,
    settings.showAmounts ? 1 : 0,
    settings.benchmark,
    computeExpiresAt(settings.validity),
  );
  return getShareForPortfolio(portfolioId)!;
}

/**
 * Aktualizuje ustawienia istniejącego linku — token bez zmian (URL rozesłany
 * ludziom nie może się zepsuć), expiresAt przeliczane od teraz.
 */
export function updateShare(
  portfolioId: string,
  settings: ShareSettingsInput,
): PortfolioShare | null {
  const db = getAuthDb();
  const result = db
    .prepare(
      `UPDATE portfolio_shares
       SET scope = ?, showAmounts = ?, benchmark = ?, expiresAt = ?, updatedAt = datetime('now')
       WHERE portfolioId = ?`,
    )
    .run(
      settings.scope,
      settings.showAmounts ? 1 : 0,
      settings.benchmark,
      computeExpiresAt(settings.validity),
      portfolioId,
    );
  if (result.changes === 0) return null;
  return getShareForPortfolio(portfolioId);
}

/** Hard delete — unieważnienie działa od następnego requestu (brak cache tokenów). */
export function deleteShareForPortfolio(portfolioId: string): boolean {
  const db = getAuthDb();
  const result = db.prepare('DELETE FROM portfolio_shares WHERE portfolioId = ?').run(portfolioId);
  return result.changes > 0;
}

function nowUtc(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
