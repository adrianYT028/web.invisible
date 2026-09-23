#!/usr/bin/env node
/**
 * Determines the MINIMAL set of pdfjs-dist files needed to load the parser and
 * read a PDF, by building sandboxes that contain only a candidate set.
 *
 * WHY
 *   Vercel deploys only the files Next's tracing selected, and two separate
 *   omissions have already broken production. Guessing which file is missing has
 *   now been wrong twice. This reproduces the deployed condition locally and on
 *   demand, so the answer is measured rather than inferred from a 503.
 *
 *   Each sandbox gets its own `node_modules/pdfjs-dist` containing exactly the
 *   candidate files, so Node's resolver sees precisely what a Lambda would.
 *
 * Usage: node scripts/probe-pdfjs-minimal.mjs
 */

import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const SRC = 'node_modules/pdfjs-dist';
const ROOT = join(tmpdir(), `pdfjs-probe-${Date.now()}`);

/** A valid one-page PDF with extractable text, built inline. */
const PDF_SRC = `
function buildPdf(lines) {
  const text = lines
    .map((l, i) => \`BT /F1 11 Tf 72 \${700 - i * 16} Td (\${l}) Tj ET\`)
    .join('\\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    \`<< /Length \${text.length} >>\\nstream\\n\${text}\\nendstream\`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\\n';
  objects.forEach((body, i) => { pdf += \`\${i + 1} 0 obj\\n\${body}\\nendobj\\n\`; });
  pdf += \`trailer\\n<< /Size \${objects.length + 1} /Root 1 0 R >>\\n%%EOF\`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

// Two stages, reported separately: a module that loads but cannot parse is a
// different missing file than one that will not load at all.
let stage = 'import';
try {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  stage = 'parse';
  const doc = await getDocument({
    data: buildPdf(['Jordan Blake', 'Backend Engineer', 'SKILLS', 'Go, Postgres']),
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
    password: '',
  }).promise;
  const page = await doc.getPage(1);
  const content = await page.getTextContent();
  const chars = content.items.map((i) => i.str ?? '').join('').length;
  console.log(\`OK pages=\${doc.numPages} chars=\${chars}\`);
} catch (err) {
  console.log(\`FAIL stage=\${stage} \${err && err.code ? err.code + ' ' : ''}\${err && err.message ? err.message.split('\\n')[0].slice(0, 160) : err}\`);
  process.exit(1);
}
`;

const CANDIDATES = [
  {
    label: 'pdf.mjs only',
    files: ['legacy/build/pdf.mjs'],
    note: 'what tracing produced originally',
  },
  {
    label: '+ package.json',
    files: ['package.json', 'legacy/build/pdf.mjs'],
    note: 'is the manifest the whole story?',
  },
  {
    label: '+ package.json + worker',
    files: ['package.json', 'legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs'],
    note: 'what next.config.ts now ships',
  },
  {
    label: '+ wasm/',
    files: ['package.json', 'legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs', 'wasm'],
    note: 'pdfjs 6 ships a wasm/ directory',
  },
  {
    label: 'whole pdfjs only',
    files: ['.'],
    note: 'every pdfjs file, still no @napi-rs/canvas',
  },
  {
    label: 'pdfjs + napi canvas',
    files: ['package.json', 'legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs'],
    withCanvas: true,
    note: 'pdfjs optionalDependency that supplies DOMMatrix',
  },
  {
    label: 'whole pdfjs + canvas',
    files: ['.'],
    withCanvas: true,
    note: 'control — must pass, or the probe itself is wrong',
  },
];

/**
 * pdfjs declares `optionalDependencies: { "@napi-rs/canvas": "^1.0.0" }` and uses
 * it to polyfill `DOMMatrix`, which Node does not provide on any version
 * (checked: undefined on both 20 and 22). Copied alongside so a sandbox can be
 * given it or denied it.
 *
 * The binary is platform-suffixed — `canvas-darwin-arm64` here, and
 * `canvas-linux-x64-gnu` on Vercel — so whatever is present is copied rather than
 * a fixed name.
 */
const CANVAS_PKGS = ['@napi-rs/canvas', '@napi-rs/canvas-darwin-arm64', '@napi-rs/wasm-runtime'];

console.log(`node ${process.version}`);
console.log(`sandboxes under ${ROOT}\n`);

const results = [];

for (const c of CANDIDATES) {
  const box = join(ROOT, c.label.replace(/[^a-z0-9]+/gi, '_'));
  const pkgDir = join(box, 'node_modules', 'pdfjs-dist');
  mkdirSync(pkgDir, { recursive: true });

  for (const rel of c.files) {
    if (rel === '.') {
      cpSync(SRC, pkgDir, { recursive: true });
    } else {
      const from = join(SRC, rel);
      const to = join(pkgDir, rel);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
    }
  }

  if (c.withCanvas) {
    for (const pkg of CANVAS_PKGS) {
      const from = join('node_modules', pkg);
      const to = join(box, 'node_modules', pkg);
      mkdirSync(dirname(to), { recursive: true });
      try {
        cpSync(from, to, { recursive: true });
      } catch {
        // A platform variant that is not installed on this machine. Not fatal:
        // only the host's own variant needs to be present for the probe to run.
      }
    }
  }

  // No "type" field: the entry point is .mjs, which is ESM regardless.
  writeFileSync(join(box, 'package.json'), JSON.stringify({ name: 'probe' }));
  writeFileSync(join(box, 'test.mjs'), PDF_SRC);

  let out;
  let passed = true;
  try {
    out = execFileSync(process.execPath, ['test.mjs'], {
      cwd: box,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    passed = false;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n')[0] || 'no output';
  }

  results.push({ ...c, passed, out });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${c.label.padEnd(26)} ${out.slice(0, 120)}`);
  console.log(`      ${c.note}`);
}

rmSync(ROOT, { recursive: true, force: true });

const firstPass = results.find((r) => r.passed);
console.log('');
if (!firstPass) {
  console.log('Nothing passed, including the whole package — the probe is wrong, not pdfjs.');
  process.exit(1);
}
console.log(`Minimal working set: ${firstPass.label}`);
if (firstPass.label === 'whole package') {
  console.log('Only the complete package works. next.config.ts should include the');
  console.log('whole pdfjs-dist directory rather than named files.');
}
