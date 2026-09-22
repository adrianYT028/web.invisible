import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Guards the type-checking setup itself.
 *
 * `tsconfig.json` excludes test files, so neither `tsc --noEmit` nor `next build`
 * has ever type-checked one. That gap hid three real defects simultaneously: a
 * mock state interface whose field had been renamed everywhere except its
 * declaration, tests asserting against exports that no longer existed, and
 * call-argument reads that could not typecheck at all.
 *
 * `tsconfig.typecheck.json` closes it. These assertions exist because that file is
 * easy to delete during a tidy-up and its absence is SILENT — everything keeps
 * passing and the checking simply stops.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS USES THE TYPESCRIPT COMPILER API
 *
 * The first version of this test hand-rolled a JSONC comment stripper so it could
 * `JSON.parse` the config. It corrupted the file: a naive block-comment regex
 * treats the `/*` inside a glob like `** /*.ts` as the start of a comment and eats
 * everything up to the next occurrence. The config's `include` array was silently
 * destroyed and every assertion failed for the wrong reason.
 *
 * TypeScript already ships the correct parser, and `parseJsonConfigFileContent`
 * additionally RESOLVES the globs — so this can assert the property that actually
 * matters (test files end up in the checked set) rather than the spelling of the
 * config that is supposed to cause it.
 */

const CONFIG_PATH = 'tsconfig.typecheck.json';

/** Resolve a tsconfig exactly as `tsc -p` would, globs and `extends` included. */
function resolveConfig(path: string): ts.ParsedCommandLine {
  const read = ts.readConfigFile(path, (p) => readFileSync(p, 'utf8'));
  expect(read.error).toBeUndefined();
  return ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    resolve(dirname(path))
  );
}

describe('type-check coverage', () => {
  it('resolves without configuration errors', () => {
    const parsed = resolveConfig(CONFIG_PATH);
    expect(parsed.errors).toEqual([]);
  });

  // The property that matters. Not "the exclude list looks right" — whether test
  // files are actually in the set tsc will check.
  it('includes test files in the checked set', () => {
    const parsed = resolveConfig(CONFIG_PATH);
    const tests = parsed.fileNames.filter((f) => /\.test\.tsx?$/.test(f));
    expect(tests.length).toBeGreaterThan(20);
  });

  it('includes the __tests__ directory', () => {
    const parsed = resolveConfig(CONFIG_PATH);
    const inDir = parsed.fileNames.filter((f) => f.includes('__tests__'));
    expect(inDir.length).toBeGreaterThan(0);
  });

  it('still covers the application sources', () => {
    const parsed = resolveConfig(CONFIG_PATH);
    const app = parsed.fileNames.filter((f) =>
      /src\/app\/.*\.tsx?$/.test(f.replace(/\\/g, '/'))
    );
    expect(app.length).toBeGreaterThan(10);
  });

  // Demonstrates the gap is real rather than asserted: the base config, which
  // `next build` uses, must NOT contain test files. If this ever starts failing,
  // the separate config has become redundant and can be removed.
  it('documents that the base config excludes tests', () => {
    const base = resolveConfig('tsconfig.json');
    const tests = base.fileNames.filter((f) => /\.test\.tsx?$/.test(f));
    expect(tests).toEqual([]);
  });

  // Two configs with `incremental` sharing one build-info file report stale
  // results, which would let the check pass without having run.
  it('uses its own incremental build-info file', () => {
    const typecheck = resolveConfig(CONFIG_PATH);
    const base = resolveConfig('tsconfig.json');
    expect(typecheck.options.tsBuildInfoFile).toBeDefined();
    expect(typecheck.options.tsBuildInfoFile).not.toBe(
      base.options.tsBuildInfoFile
    );
  });

  it('is reachable through an npm script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.typecheck).toContain(CONFIG_PATH);
    // And a single command that runs types then tests, for use before pushing.
    expect(pkg.scripts?.verify).toContain('typecheck');
  });
});
