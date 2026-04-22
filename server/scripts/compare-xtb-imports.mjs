#!/usr/bin/env node
// Dev-only: parse all files in Import/xtb/ and print a comparison matrix.
// Used as acceptance gate for XTB parser fixes — see plan goofy-brewing-meerkat.md.
//
// Run from repo root:  node server/scripts/compare-xtb-imports.mjs
// Requires: server already built (dist/ present) or tsx installed.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseXtbFile } from '../dist/parsers/xtb-transactions.js';

const XTB_DIR = resolve(import.meta.dirname, '../../Import/xtb');
const files = readdirSync(XTB_DIR)
  .filter(f => f.toLowerCase().endsWith('.xlsx'))
  .sort();

function groupSum(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const cur = m.get(k) ?? { count: 0, sum: 0 };
    cur.count += 1;
    cur.sum += r.amount ?? r.value ?? 0;
    m.set(k, cur);
  }
  return m;
}

function fmt(n) { return Number(n).toFixed(2); }

for (const f of files) {
  const buf = readFileSync(join(XTB_DIR, f));
  console.log('\n=== ' + f + ' ===');
  let res;
  try {
    res = await parseXtbFile(buf, 'test-batch', f);
  } catch (e) {
    console.log('  PARSE ERROR:', e.message);
    continue;
  }

  const tx = res.transactions.data;
  const ops = res.operations.data;
  console.log(`  transactions: ${tx.length}  (skipped: ${res.transactions.skipped.length})`);
  console.log(`  operations:   ${ops.length}  (skipped: ${res.operations.skipped.length})`);

  // Group by category/side
  const bySide = groupSum(tx, t => `${t.category}/${t.side}`);
  if (bySide.size > 0) {
    console.log('  tx by category/side:');
    for (const [k, v] of [...bySide.entries()].sort()) {
      console.log(`    ${k.padEnd(14)} count=${String(v.count).padStart(3)}  Σvalue=${fmt(v.sum)}`);
    }
  }

  // Group ops by operationType
  const byType = groupSum(ops, o => o.operationType);
  if (byType.size > 0) {
    console.log('  ops by operationType:');
    for (const [k, v] of [...byType.entries()].sort()) {
      console.log(`    ${k.padEnd(14)} count=${String(v.count).padStart(3)}  Σamount=${fmt(v.sum)}`);
    }
  }

  // Currencies seen
  const txCur = new Set(tx.map(t => `${t.currency}/${t.paymentCurrency}`));
  if (txCur.size > 0) console.log('  tx currencies (quote/payment):', [...txCur].sort().join(', '));
  const opCur = new Set(ops.map(o => o.currency));
  if (opCur.size > 0) console.log('  op currencies:', [...opCur].sort().join(', '));

  // Instruments
  const instr = new Set(tx.map(t => t.paperName));
  if (instr.size > 0) console.log('  instruments:', [...instr].sort().join(', '));

  // Warnings
  if (res.warnings?.length) {
    console.log('  warnings:');
    for (const w of res.warnings) console.log('    - ' + w);
  }
}
