import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Asserts that the class names used by the newer surfaces actually exist in the
 * stylesheet.
 *
 * ---------------------------------------------------------------------------
 * WHY
 *
 * `ServicesOverview` was first written against `.feature-grid` and
 * `.section-inner`. Neither exists — the real names are `.features-grid` and
 * `.features-section`. TypeScript was happy, the build was happy, and the whole
 * section would have shipped unstyled. A class name is a string, so nothing in the
 * normal toolchain checks it.
 *
 * ---------------------------------------------------------------------------
 * SCOPE
 *
 * Deliberately limited to the files listed below rather than every component.
 * Older components predate this check and some compose class names dynamically,
 * which this cannot read. Widening the list is welcome; loosening the assertion to
 * accommodate a genuinely dynamic class is not — extract that case out instead.
 */

const FILES = [
  // The hero cube: 20-odd new class names, none of which TypeScript or the build
  // can check. This is exactly the file most likely to ship unstyled.
  'src/components/hero/ServiceCube.tsx',
  'src/components/sections/ServicesOverview.tsx',
  'src/components/sections/ServicePaywall.tsx',
  'src/app/services/page.tsx',
  'src/app/pricing/page.tsx',
  'src/app/account/ApiKeyManager.tsx',
];

const CSS = readFileSync('src/app/globals.css', 'utf8');

/** Every literal class token used in a `className="…"` attribute. */
function classesIn(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const tokens = new Set<string>();
  for (const m of source.matchAll(/className="([^"{}]+)"/g)) {
    for (const token of m[1].split(/\s+/)) {
      if (token.length > 0) tokens.add(token);
    }
  }
  return [...tokens].sort();
}

/** Whether the stylesheet defines a rule for this class. */
function defined(cls: string): boolean {
  // Matches `.cls` followed by anything that cannot continue an identifier, which
  // keeps `.feature-card` from being satisfied by `.feature-cards`.
  return new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(
    CSS
  );
}

describe('class names resolve to real styles', () => {
  for (const path of FILES) {
    it(`${path} uses only classes defined in globals.css`, () => {
      const missing = classesIn(path).filter((c) => !defined(c));
      // Named in the failure so the fix is obvious rather than a hunt.
      expect(missing).toEqual([]);
    });
  }

  it('would catch a class that does not exist', () => {
    // Guards the guard: if `defined` ever returned true for everything, the tests
    // above would pass vacuously.
    expect(defined('this-class-definitely-does-not-exist')).toBe(false);
    expect(defined('feature-card')).toBe(true);
  });

  it('does not accept a prefix match as a definition', () => {
    // `.features-grid` exists; `.features-gri` must not count as defined.
    expect(defined('features-grid')).toBe(true);
    expect(defined('features-gri')).toBe(false);
  });
});
