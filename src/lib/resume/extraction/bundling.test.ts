import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// -----------------------------------------------------------------------------
// Bundling guard
// -----------------------------------------------------------------------------
//
// This file exists because of a bug that NO other test in this repo can catch.
//
// pdfjs loads its parser in a worker. Under Node it falls back to a "fake
// worker", which dynamically imports `pdf.worker.mjs` from a path relative to the
// importing module. Vitest resolves pdfjs straight out of node_modules, where
// `pdf.mjs` and `pdf.worker.mjs` are siblings, so the worker is always found —
// which is why extract.integration.test.ts passes against real PDFs.
//
// Next.js is different. Turbopack bundles `pdf.mjs` into `.next/.../chunks/` and
// does NOT copy the worker alongside it, so at request time the lookup fails:
//
//     Setting up fake worker failed: "Cannot find module
//      '.../.next/dev/server/chunks/pdf.worker.mjs'"
//
// Every PDF upload then returns "this PDF could not be read" — a message that
// blames the user's file for an environment problem. It reached a real manual test
// with a green suite behind it.
//
// `serverExternalPackages` is what prevents it. This test asserts the config still
// declares it, so removing that line fails here instead of silently breaking every
// upload in production.
//
// It reads next.config.ts as TEXT rather than importing it, because importing the
// config pulls in Next's module graph, which is a disproportionate cost for
// checking that one string is present.
// -----------------------------------------------------------------------------

describe('next.config.ts bundling guard', () => {
  const config = fs.readFileSync(
    path.resolve(process.cwd(), 'next.config.ts'),
    'utf8'
  );

  it('declares serverExternalPackages', () => {
    expect(config).toMatch(/serverExternalPackages/);
  });

  it('keeps pdfjs-dist out of the server bundle', () => {
    // Without this, pdfjs cannot find its worker at runtime and EVERY pdf upload
    // fails. See the header for the exact error.
    expect(config).toMatch(/serverExternalPackages[\s\S]{0,120}pdfjs-dist/);
  });

  it('keeps mammoth out of the server bundle', () => {
    expect(config).toMatch(/serverExternalPackages[\s\S]{0,120}mammoth/);
  });

  it('still ships pdf.worker.mjs next to pdf.mjs in node_modules', () => {
    // The premise the fix depends on: marking the package external only helps if
    // the worker really is a sibling of the entry point there. A future pdfjs
    // release that relocates it would break uploads again, and this is the
    // cheapest place to notice.
    const dir = path.resolve(
      process.cwd(),
      'node_modules/pdfjs-dist/legacy/build'
    );
    expect(fs.existsSync(path.join(dir, 'pdf.mjs'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'pdf.worker.mjs'))).toBe(true);
  });
});
