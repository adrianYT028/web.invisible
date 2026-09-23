#!/usr/bin/env node
/**
 * Asserts that `pdf.worker.mjs` is in the deploy trace for the resume upload
 * route, and that the traced path actually resolves on disk.
 *
 * WHY THIS IS A SCRIPT AND NOT A UNIT TEST
 *   The bug it guards cannot be reproduced in vitest. Vitest resolves pdfjs from
 *   node_modules, where the worker is always present, so the tests pass whether
 *   or not the file would be deployed. The only artifact that tells the truth is
 *   the `.nft.json` trace Next writes at BUILD time, which is the exact file list
 *   Vercel copies into the function.
 *
 *   Production symptom when this is missing: every PDF upload answers
 *   `500 internal_error` -> "An unexpected error occurred."
 *
 * Run after `npm run build`:
 *   node scripts/check-pdf-worker-traced.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const TRACE = '.next/server/app/api/resume/upload/route.js.nft.json';
const TRACE_DIR = '.next/server/app/api/resume/upload';
const WORKER = 'pdf.worker';

if (!existsSync(TRACE)) {
  console.error(`${TRACE} not found. Run "npm run build" first.`);
  process.exit(2);
}

const trace = JSON.parse(readFileSync(TRACE, 'utf8'));
const pdfFiles = trace.files.filter((f) => f.includes('pdfjs'));
const workers = trace.files.filter((f) => f.includes(WORKER));

console.log(`trace            ${TRACE}`);
console.log(`files traced     ${trace.files.length}`);
console.log(`pdfjs files      ${pdfFiles.length}`);
console.log(`pdf.worker files ${workers.length}`);
console.log('');

if (workers.length === 0) {
  console.log('FAIL: pdf.worker.mjs is NOT in the deploy trace.');
  console.log('      Every PDF upload will return 500 internal_error in production.');
  console.log('      Fix: add it to outputFileTracingIncludes in next.config.ts.');
  process.exit(1);
}

let allResolve = true;
for (const f of workers) {
  const abs = resolve(TRACE_DIR, f);
  const exists = existsSync(abs);
  if (!exists) allResolve = false;
  console.log(`  ${exists ? 'RESOLVES' : 'MISSING '}  ${relative(process.cwd(), abs)}`);
}

console.log('');
if (!allResolve) {
  console.log('FAIL: a traced worker path does not resolve on disk.');
  process.exit(1);
}
console.log('PASS: the worker is in the deploy trace and the path resolves.');
