import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Asserts the entitlement gate map at the source level.
 *
 * Every one of these endpoints was reachable by any logged-in account before the
 * gates went in, bounded only by a per-day cap that three of them did not have.
 * The risk now is the reverse: a future edit quietly removing a gate from
 * `/api/prep`, which spends roughly 1,400 provider tokens per job, and nothing
 * failing.
 *
 * ---------------------------------------------------------------------------
 * THE PRINCIPLE BEING ENCODED
 *
 * Full access buys CREATING and DISCOVERING new work. Reading, editing,
 * exporting and deleting data the user already owns is never withheld — a
 * cancelled plan must not lock someone out of their own records, which is a
 * data-portability problem rather than a paywall.
 *
 * So the gate follows the cost and the novelty, not the table.
 */

interface Expectation {
  path: string;
  /** Handlers that MUST call requireService. */
  gated: string[];
  /** Handlers that must NOT, with the reason recorded. */
  open: Record<string, string>;
}

const EXPECTED: Expectation[] = [
  {
    path: 'src/app/api/jobs/route.ts',
    gated: ['POST'], // saving a NEW role
    open: { GET: 'lists the caller’s own tracked roles' },
  },
  {
    path: 'src/app/api/jobs/[id]/route.ts',
    gated: [],
    open: {
      PATCH: 'edits the caller’s own row',
      DELETE: 'deletes the caller’s own row, which must always be possible',
    },
  },
  {
    path: 'src/app/api/jobs/discover/route.ts',
    gated: ['GET'], // finds NEW openings
    open: {},
  },
  {
    path: 'src/app/api/jobs/export/route.ts',
    gated: [],
    open: { GET: 'returns the caller’s own data as CSV — data portability' },
  },
  {
    path: 'src/app/api/prep/route.ts',
    gated: ['POST'], // starts a run: the most expensive action in the product
    open: {},
  },
  {
    path: 'src/app/api/prep/[id]/route.ts',
    gated: ['POST'], // ticks a run, spending inference
    open: { GET: 'reads results the caller already generated' },
  },
  {
    path: 'src/app/api/prep/[id]/export/route.ts',
    gated: [],
    open: {
      GET: 'returns a run the caller already paid to produce, as CSV — data portability',
    },
  },
];

/** Split a route module into its exported handlers. */
function handlers(source: string): Record<string, string> {
  const parts = source.split(/^export async function /m);
  const out: Record<string, string> = {};
  for (const body of parts.slice(1)) {
    const verb = /^([A-Z]+)/.exec(body)?.[1];
    if (verb) out[verb] = body;
  }
  return out;
}

function read(path: string): Record<string, string> {
  return handlers(readFileSync(path, 'utf8'));
}

describe('service entitlement gates', () => {
  for (const { path, gated, open } of EXPECTED) {
    describe(path, () => {
      it('exports exactly the handlers this test knows about', () => {
        const found = Object.keys(read(path)).sort();
        const expected = [...gated, ...Object.keys(open)].sort();
        // A new handler added without a gate decision fails here rather than
        // shipping ungated.
        expect(found).toEqual(expected);
      });

      for (const verb of gated) {
        it(`${verb} is entitlement-gated`, () => {
          const body = read(path)[verb];
          expect(body).toBeDefined();
          expect(body).toContain('requireService(user.id');
          // The gate must actually short-circuit, not just be computed.
          expect(body).toContain('if (gate) return gate;');
        });

        it(`${verb} gates AFTER authenticating`, () => {
          const body = read(path)[verb];
          const auth = body.indexOf("not_authenticated");
          const gate = body.indexOf('requireService(user.id');
          expect(auth).toBeGreaterThan(-1);
          // Otherwise `user.id` would be read before the null check.
          expect(gate).toBeGreaterThan(auth);
        });
      }

      for (const [verb, why] of Object.entries(open)) {
        it(`${verb} is deliberately open — ${why}`, () => {
          const body = read(path)[verb];
          expect(body).toBeDefined();
          expect(body).not.toContain('requireService(user.id');
          // Still authenticated, and still scoped to the caller.
          expect(body).toContain('not_authenticated');
        });
      }
    });
  }

  // The resume analyser is bounded by volume, not access: migration 011 gives the
  // free plan one upload and one scan a day so the value is visible before
  // payment. A gate here would delete that taster.
  it('leaves the resume routes quota-bounded rather than gated', () => {
    for (const path of [
      'src/app/api/resume/upload/route.ts',
      'src/app/api/resume/scan/route.ts',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toContain('requireService(');
      expect(source).toContain('checkResumeQuota');
    }
  });

  // The installer is gated by hasServiceAccess directly rather than through
  // requireService, because it must also honour the legacy one-time licence.
  it('gates the installer on desktop access', () => {
    const source = readFileSync('src/app/api/download/[platform]/route.ts', 'utf8');
    expect(source).toContain("hasServiceAccess");
    expect(source).toContain("'desktop'");
  });

  // The nightly job-index sync is machine-authenticated and has no user.
  it('does not gate the cron sync route', () => {
    const source = readFileSync('src/app/api/jobs/sync/route.ts', 'utf8');
    expect(source).not.toContain('requireService(');
    expect(source).toContain('CRON_SECRET');
  });
});
