import fs from 'fs';
import path from 'path';
import { config } from './config.js';
import { getDb } from './db/connection.js';
import { seedTickerMap } from './db/ticker-map-repo.js';
import { decodeWindows1250 } from './parsers/encoding.js';
import { parseBossaTransactions } from './parsers/bossa-transactions.js';
import { parseBossaOperations } from './parsers/bossa-operations.js';
import { insertTransactions, getTransactionsCount, clearTransactions } from './db/transactions-repo.js';
import { insertOperations, getOperationsCount, clearOperations } from './db/operations-repo.js';

/**
 * Seed the database with initial CSV data from Bossa
 */
async function seed() {
  console.log('Initializing database...');
  getDb();
  seedTickerMap();
  console.log('Ticker map seeded.');

  // Clear existing data
  clearTransactions();
  clearOperations();
  console.log('Cleared existing data.');

  const csvDir = config.csvDir;

  // Import transaction files
  const txFiles = ['hisPW.csv', 'hisPW-2.csv'];
  for (const file of txFiles) {
    const filePath = path.join(csvDir, file);
    if (!fs.existsSync(filePath)) {
      console.log(`Skipping ${file} - not found`);
      continue;
    }
    const buffer = fs.readFileSync(filePath);
    const content = decodeWindows1250(buffer);
    const { data: transactions } = parseBossaTransactions(content, `seed-${file}`);
    const count = insertTransactions(transactions);
    console.log(`Imported ${count} transactions from ${file}`);
  }

  // Import operations file
  const opsPattern = /historia_finansowa/;
  const files = fs.readdirSync(csvDir);
  const opsFile = files.find(f => opsPattern.test(f) && f.endsWith('.csv'));
  if (opsFile) {
    const filePath = path.join(csvDir, opsFile);
    const buffer = fs.readFileSync(filePath);
    const content = decodeWindows1250(buffer);
    const { data: operations } = parseBossaOperations(content, `seed-${opsFile}`);
    const count = insertOperations(operations);
    console.log(`Imported ${count} operations from ${opsFile}`);
  } else {
    console.log('No operations CSV found');
  }

  console.log(`\nDatabase seeded:`);
  console.log(`  Transactions: ${getTransactionsCount()}`);
  console.log(`  Operations: ${getOperationsCount()}`);
}

seed().catch(console.error);
