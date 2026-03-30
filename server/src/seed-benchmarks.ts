/**
 * Seed benchmark historical prices from CSV files into price_history.db.
 *
 * CSV files (downloaded from Stooq) are expected in the `benchmark/` directory
 * at the project root. Format: Data,Otwarcie,Najwyzszy,Najnizszy,Zamkniecie,Wolumen
 *
 * Usage: npm run seed-benchmarks -w server
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { storeHistoricalPrices } from './services/history-cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCHMARK_DIR = path.resolve(__dirname, '../../benchmark');

const BENCHMARK_FILES = [
  { file: 'wig_d.csv', ticker: 'wig' },
  { file: 'wig20_d.csv', ticker: 'wig20' },
  { file: 'mwig40_d.csv', ticker: 'mwig40' },
  { file: 'swig80_d.csv', ticker: 'swig80' },
] as const;

function parseBenchmarkCsv(content: string): Array<{ date: string; close: number }> {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  // Skip header: Data,Otwarcie,Najwyzszy,Najnizszy,Zamkniecie,Wolumen
  const results: Array<{ date: string; close: number }> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length < 5) continue;

    const date = cols[0].trim();   // YYYY-MM-DD
    const close = parseFloat(cols[4].trim()); // Zamkniecie

    if (date && !isNaN(close)) {
      results.push({ date, close });
    }
  }
  return results;
}

async function seedBenchmarks() {
  console.log(`Benchmark CSV directory: ${BENCHMARK_DIR}`);

  if (!fs.existsSync(BENCHMARK_DIR)) {
    console.error(`Directory not found: ${BENCHMARK_DIR}`);
    process.exit(1);
  }

  for (const { file, ticker } of BENCHMARK_FILES) {
    const filePath = path.join(BENCHMARK_DIR, file);

    if (!fs.existsSync(filePath)) {
      console.warn(`  Skipping ${file} — file not found`);
      continue;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const data = parseBenchmarkCsv(content);

    if (data.length === 0) {
      console.warn(`  Skipping ${file} — no valid data rows`);
      continue;
    }

    storeHistoricalPrices(ticker, data, 'stooq-csv');

    const first = data[0].date;
    const last = data[data.length - 1].date;
    console.log(`  ${ticker}: ${data.length} rows (${first} → ${last})`);
  }

  console.log('Benchmark seed complete.');
}

seedBenchmarks().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
