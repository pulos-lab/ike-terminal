import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { initSchema } from './schema.js';
import { getDbPathForPortfolio } from './portfolio-registry.js';

const connections = new Map<string, Database.Database>();

export function getDb(portfolioId: string = 'default'): Database.Database {
  let db = connections.get(portfolioId);
  if (!db) {
    const dbPath = getDbPathForPortfolio(portfolioId);
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    connections.set(portfolioId, db);
  }
  return db;
}

export function closeDb(portfolioId?: string): void {
  if (portfolioId) {
    const db = connections.get(portfolioId);
    if (db) { db.close(); connections.delete(portfolioId); }
  } else {
    for (const [, db] of connections) {
      db.close();
    }
    connections.clear();
  }
}
