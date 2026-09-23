import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

// -----------------------------------------------------------------------------
// The deployed Node version must satisfy what pdfjs-dist demands
// -----------------------------------------------------------------------------
//
// `pdfjs-dist@6` declares `engines: { node: ">=22.13.0 || >=24" }`. Nothing
// enforces that — npm prints a warning at install time and carries on, and the
// library loads fine on older Node for many code paths, so local development and
// the entire test suite pass regardless.
//
// In production it did not load at all. Every PDF upload answered
// `500 internal_error` ("An unexpected error occurred") while .docx and .txt
// uploads returned 200, because mammoth asks only for Node >= 12. The pattern
// pointed at the database for a while, since the failing line was a dynamic
// `import()` whose error escaped as an unhandled exception.
//
// So the Node version is now pinned in `engines.node`, which Vercel reads and
// which overrides whatever is selected in project settings. This test fails if
// that pin is ever removed or drops below what pdfjs needs — the alternative is
// discovering it again from a customer report.
// -----------------------------------------------------------------------------

/** Lowest Node major that pdfjs-dist@6 accepts, from its own engines field. */
const REQUIRED_MAJOR = 22;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

describe('deployed Node version vs pdfjs requirement', () => {
  it('pins engines.node in package.json', () => {
    const pkg = readJson('package.json');
    const engines = pkg.engines as { node?: string } | undefined;

    expect(
      engines?.node,
      'package.json must pin engines.node — without it Vercel picks the version ' +
        'and pdfjs silently fails to load in production'
    ).toBeTruthy();
  });

  it('pins a major at or above what pdfjs-dist requires', () => {
    const pkg = readJson('package.json');
    const pinned = (pkg.engines as { node: string }).node;

    // Accepts "22.x", ">=22.13.0", "22.13.0" and similar. The first number in
    // the range is the major being asked for.
    const major = Number(/(\d+)/.exec(pinned)?.[1]);
    expect(Number.isFinite(major), `could not read a major version from "${pinned}"`).toBe(true);
    expect(
      major,
      `engines.node is "${pinned}" but pdfjs-dist needs Node >= ${REQUIRED_MAJOR}.13`
    ).toBeGreaterThanOrEqual(REQUIRED_MAJOR);
  });

  it('still matches what pdfjs-dist actually asks for', () => {
    // Guards the constant above against a pdfjs upgrade that raises its floor.
    // If pdfjs starts demanding Node 24, this fails and REQUIRED_MAJOR plus the
    // pin both need raising — rather than the requirement quietly going unmet.
    const pdfjs = readJson('node_modules/pdfjs-dist/package.json');
    const declared = (pdfjs.engines as { node?: string } | undefined)?.node ?? '';

    const lowest = Math.min(
      ...[...declared.matchAll(/(\d+)/g)]
        .map((m) => Number(m[1]))
        // Only majors: ">=22.13.0" yields 22, 13 and 0, and 13/0 are not majors.
        .filter((n) => n >= 10)
    );

    expect(
      lowest,
      `pdfjs-dist now declares "${declared}". Raise REQUIRED_MAJOR and engines.node.`
    ).toBeLessThanOrEqual(REQUIRED_MAJOR);
  });
});
