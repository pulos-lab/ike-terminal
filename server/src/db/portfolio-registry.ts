import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Portfolio, PortfolioSettings } from 'shared';
import { DEFAULT_PORTFOLIO_SETTINGS } from 'shared';
import { config } from '../config.js';

function getRegistryPath(): string {
  return path.join(config.dataDir, 'portfolios.json');
}

export function getDbPathForPortfolio(id: string): string {
  return path.join(config.dataDir, `${id}.db`);
}

function loadPortfolios(): Portfolio[] {
  const p = getRegistryPath();
  if (!fs.existsSync(p)) return [];
  const list: Portfolio[] = JSON.parse(fs.readFileSync(p, 'utf-8'));
  for (const portfolio of list) {
    portfolio.settings = { ...DEFAULT_PORTFOLIO_SETTINGS, ...(portfolio.settings || {}) };
  }
  return list;
}

function savePortfolios(list: Portfolio[]): void {
  const dir = config.dataDir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getRegistryPath(), JSON.stringify(list, null, 2));
}

// ── User-scoped queries ─────────────────────────────────────────────────────

/** Get all portfolios. If userId provided, filter by owner only. */
export function getAllPortfolios(userId?: string): Portfolio[] {
  const all = loadPortfolios();
  if (!userId) return all;
  return all.filter(p => p.userId === userId);
}

export function getPortfolio(id: string): Portfolio | null {
  return loadPortfolios().find(p => p.id === id) || null;
}

/** Check if a portfolio belongs to a user */
export function isPortfolioOwnedBy(id: string, userId: string): boolean {
  const portfolio = getPortfolio(id);
  if (!portfolio) return false;
  return portfolio.userId === userId;
}

/** Claim an unowned (legacy) portfolio — assigns it to the given user */
export function claimPortfolio(id: string, userId: string): Portfolio | null {
  const list = loadPortfolios();
  const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return null;
  if (list[idx].userId) return null; // already owned
  list[idx].userId = userId;
  savePortfolios(list);
  return list[idx];
}

export function createPortfolio(name: string, userId?: string): Portfolio {
  const list = loadPortfolios();
  const portfolio: Portfolio = {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    settings: { ...DEFAULT_PORTFOLIO_SETTINGS },
    userId,
  };
  list.push(portfolio);
  savePortfolios(list);
  return portfolio;
}

export function updatePortfolio(id: string, updates: { name?: string; settings?: PortfolioSettings }): Portfolio | null {
  const list = loadPortfolios();
  const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return null;
  if (updates.name) list[idx].name = updates.name;
  if (updates.settings) list[idx].settings = updates.settings;
  savePortfolios(list);
  return list[idx];
}

export function deletePortfolio(id: string): void {
  const list = loadPortfolios().filter(p => p.id !== id);
  savePortfolios(list);
  const dbPath = getDbPathForPortfolio(id);
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/**
 * Initialize portfolio registry on first run.
 * Migrates existing portfolio.db → default.db if needed.
 */
export function initRegistry(): void {
  const registryPath = getRegistryPath();
  if (fs.existsSync(registryPath)) return;

  const oldDbPath = path.join(config.dataDir, 'portfolio.db');
  const defaultDbPath = getDbPathForPortfolio('default');

  if (fs.existsSync(oldDbPath) && !fs.existsSync(defaultDbPath)) {
    fs.renameSync(oldDbPath, defaultDbPath);
    for (const suffix of ['-wal', '-shm']) {
      const old = oldDbPath + suffix;
      if (fs.existsSync(old)) fs.renameSync(old, defaultDbPath + suffix);
    }
    console.log('Migrated portfolio.db → default.db');
  }

  const defaultPortfolio: Portfolio = {
    id: 'default',
    name: 'Moje IKE',
    createdAt: new Date().toISOString(),
    settings: { ...DEFAULT_PORTFOLIO_SETTINGS },
  };
  savePortfolios([defaultPortfolio]);
  console.log('Portfolio registry created.');
}
