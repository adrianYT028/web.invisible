#!/usr/bin/env node
/**
 * Asserts that every file pdfjs needs AT RUNTIME is in the deploy trace for the
 * resume upload route, and that each traced path resolves on disk.
 *
 * WHY THIS IS A SCRIPT AND NOT A UNIT TEST
 *   Neither omission it guards can be reproduced in vitest or `next dev`. Both
 *   resolve pdfjs against a complete node_modules, so the suite passes whether or
 *   not the files would be DEPLOYED. The only artifact that tells the truth is the
 *   `.nft.json` trace Next writes at build time — the exact file list Vercel
 *   copies into the function.
 *
 *   Both omissions shipped to production. They fail differently, which is worth
 *   knowing because it is how the first diagnosis went wrong:
 *
 *     package.json missing   -> 500 internal_error  ("An unexpected error
 *                               occurred"). Node will not load any file in a
 *                               package without the package's own manifest, so
 *                               pdf.mjs was present and unloadable.
 *     pdf.worker.mjs missing -> 422 extraction_failed ("this PDF could not be
 *                               read"). pdfjs loads, then cannot start its worker.
 *
 *   Fixing only the worker therefore changed nothing about the reported bug.
 *
 * Run after `npm run build`:
 *   node scripts/check-pdf-runtime-files.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

const TRACE = '.next/server/app/api/resume/upload/route.js.nft.json';
const TRACE_DIR = '.next/server/app/api/resume/upload';
const WORKER = 'pdf.worker';

/**
 * Files that MUST be in the deploy trace, and what breaks without each.
 *
 * `package.json` is the one that actually took production down: Node reads a
 * package's own manifest to resolve the package boundary and module type, so
 * without it `import('pdfjs-dist/legacy/build/pdf.mjs')` throws
 * ERR_MODULE_NOT_FOUND even though pdf.mjs itself is present. That surfaced as
 * `500 internal_error`.
 *
 * The worker is a separate omission with a different symptom — 422
 * extraction_failed — which is why fixing only the worker did not fix the bug.
 */
const REQUIRED = [
  {
    match: 'pdfjs-dist/package.json',
    why: 'Node cannot resolve the package at all without its manifest (500 internal_error)',
  },
  {
    match: 'pdf.worker.mjs',
    why: 'pdfjs cannot start its fake worker (422 extraction_failed)',
  },
  {
    // The one that actually kept it broken. Node has no DOMMatrix on any version;
    // pdfjs polyfills it from this optional dependency. Because it is optional and
    // our code never imports it, tracing does not pick it up on its own.
    match: '@napi-rs/canvas',
    why: 'pdf.mjs throws "DOMMatrix is not defined" on load (500 internal_error)',
  },
  {
    // Platform-suffixed native binary. On Vercel this is canvas-linux-x64-gnu; on
    // a dev Mac, canvas-darwin-arm64. Matching the extension rather than a
    // platform name keeps the check honest on both.
    match: '.node',
    why: 'the Skia native binary is absent, so @napi-rs/canvas cannot load',
  },
];

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

let failures = 0;

for (const req of REQUIRED) {
  const hits = trace.files.filter((f) => f.includes(req.match));

  if (hits.length === 0) {
    console.log(`FAIL  ${req.match} is NOT in the deploy trace`);
    console.log(`      -> ${req.why}`);
    console.log('      Fix: add it to outputFileTracingIncludes in next.config.ts');
    failures += 1;
    continue;
  }

  for (const f of hits) {
    const abs = resolve(TRACE_DIR, f);
    const exists = existsSync(abs);
    if (!exists) failures += 1;
    console.log(
      `${exists ? 'OK    ' : 'FAIL  '}${relative(process.cwd(), abs)}` +
        (exists ? '' : '   traced but not on disk')
    );
  }
}

console.log('');
if (failures > 0) {
  console.log(`FAIL: ${failures} problem(s). PDF upload will break in production.`);
  process.exit(1);
}
console.log('PASS: every file pdfjs needs at runtime is in the deploy trace.');
