import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the resume retention reaper.
 *
 * The behaviour under test is ORDERING and FAILURE DIRECTION, not the happy path.
 * Migration 011's own comment warns that deleting the row before the Storage
 * object strands personal data that no query can find — so the tests that matter
 * are the ones asserting files go first and that a Storage failure leaves the row
 * alone to be retried.
 */

/** Ordered log of the operations the route performed. */
const ops: string[] = [];

const state = {
  expired: [] as { id: string; storage_bucket: string; storage_path: string }[],
  selectError: null as { message: string } | null,
  removeError: null as { message: string } | null,
  deleteError: null as { message: string } | null,
  cronSecret: 'right-secret' as string | undefined,
};

const removedPaths: string[] = [];
const deletedIds: string[] = [];

vi.mock('@/lib/env', () => ({
  env: {
    get cronSecret() {
      return state.cronSecret;
    },
  },
}));

vi.mock('@/lib/http', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/http')>();
  return { ...actual, logSafe: () => {} };
});

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: () => ({
    from() {
      return {
        select() {
          return {
            lte() {
              return {
                order() {
                  return {
                    limit: async () => {
                      ops.push('select');
                      return state.selectError
                        ? { data: null, error: state.selectError }
                        : { data: state.expired, error: null };
                    },
                  };
                },
              };
            },
          };
        },
        delete() {
          return {
            in: async (_col: string, ids: string[]) => {
              ops.push('delete-rows');
              deletedIds.push(...ids);
              return { error: state.deleteError };
            },
          };
        },
      };
    },
    storage: {
      from() {
        return {
          remove: async (paths: string[]) => {
            ops.push('remove-files');
            if (!state.removeError) removedPaths.push(...paths);
            return { data: null, error: state.removeError };
          },
        };
      },
    },
  }),
}));

import { POST } from './route';

function req(secret = 'right-secret'): Request {
  return new Request('http://localhost/api/cron/reap-resumes', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
  });
}

function row(id: string, path = `u/${id}`, bucket = 'resumes') {
  return { id, storage_bucket: bucket, storage_path: path };
}

beforeEach(() => {
  ops.length = 0;
  removedPaths.length = 0;
  deletedIds.length = 0;
  state.expired = [];
  state.selectError = null;
  state.removeError = null;
  state.deleteError = null;
  state.cronSecret = 'right-secret';
});

describe('authentication', () => {
  // An unauthenticated endpoint that DELETES user data is the worst possible
  // thing to leave open.
  it('rejects a wrong secret', async () => {
    const res = await POST(req('wrong'));
    expect(res.status).toBe(401);
    expect(ops).toEqual([]);
  });

  it('rejects a missing bearer entirely', async () => {
    const res = await POST(
      new Request('http://localhost/api/cron/reap-resumes', { method: 'POST' })
    );
    expect(res.status).toBe(401);
    expect(ops).toEqual([]);
  });

  // Fails closed: without a configured secret the route must refuse rather than
  // run unauthenticated.
  it('refuses to run when CRON_SECRET is unset', async () => {
    state.cronSecret = undefined;
    const res = await POST(req());
    expect(res.status).toBe(503);
    expect(ops).toEqual([]);
  });
});

describe('nothing due', () => {
  it('does no work and reports zero', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      expired: 0,
      rows: 0,
    });
    expect(ops).toEqual(['select']);
  });
});

describe('ordering', () => {
  // THE test. Migration 011 warns that the other order strands personal data
  // that nothing points at any more.
  it('deletes the FILE before the ROW', async () => {
    state.expired = [row('a'), row('b')];
    await POST(req());
    expect(ops).toEqual(['select', 'remove-files', 'delete-rows']);
    expect(ops.indexOf('remove-files')).toBeLessThan(
      ops.indexOf('delete-rows')
    );
  });

  it('removes every expired path and then deletes exactly those rows', async () => {
    state.expired = [row('a'), row('b'), row('c')];
    const res = await POST(req());
    expect(removedPaths).toEqual(['u/a', 'u/b', 'u/c']);
    expect(deletedIds).toEqual(['a', 'b', 'c']);
    await expect(res.json()).resolves.toMatchObject({
      expired: 3,
      files: 3,
      rows: 3,
    });
  });

  it('groups by bucket rather than assuming one', async () => {
    state.expired = [
      row('a', 'u/a', 'resumes'),
      row('b', 'u/b', 'legacy-bucket'),
    ];
    await POST(req());
    // Two separate remove calls, one per bucket.
    expect(ops.filter((o) => o === 'remove-files')).toHaveLength(2);
    expect(deletedIds.sort()).toEqual(['a', 'b']);
  });
});

describe('failure directions', () => {
  // Recoverable: nothing is deleted, so the next run tries again.
  it('leaves the row alone when the Storage delete fails', async () => {
    state.expired = [row('a')];
    state.removeError = { message: 'storage down' };

    const res = await POST(req());

    expect(ops).toEqual(['select', 'remove-files']);
    expect(deletedIds).toEqual([]);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      files: 0,
      rows: 0,
      storageFailures: 1,
    });
  });

  it('reports a 500 when the row delete fails, so the schedule surfaces it', async () => {
    state.expired = [row('a')];
    state.deleteError = { message: 'db down' };

    const res = await POST(req());

    expect(res.status).toBe(500);
    // The file IS gone; the row is retried because it is still expired.
    expect(removedPaths).toEqual(['u/a']);
  });

  it('retries on a select failure rather than reporting a clean run', async () => {
    state.selectError = { message: 'db down' };
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(ops).toEqual(['select']);
  });

  // A file removed by hand must not leave its row stuck forever.
  it('still deletes the row when the object was already gone', async () => {
    state.expired = [row('a')];
    // Supabase reports no error for an already-absent object.
    state.removeError = null;
    await POST(req());
    expect(deletedIds).toEqual(['a']);
  });
});

describe('batching', () => {
  it('splits Storage removals into batches of 100', async () => {
    state.expired = Array.from({ length: 250 }, (_, i) => row(`r${i}`));
    await POST(req());
    // 250 paths in one bucket -> 3 remove calls.
    expect(ops.filter((o) => o === 'remove-files')).toHaveLength(3);
    expect(removedPaths).toHaveLength(250);
    // Rows are deleted in a single call.
    expect(ops.filter((o) => o === 'delete-rows')).toHaveLength(1);
    expect(deletedIds).toHaveLength(250);
  });

  it('flags that more is probably waiting when the run fills its cap', async () => {
    state.expired = Array.from({ length: 500 }, (_, i) => row(`r${i}`));
    const res = await POST(req());
    await expect(res.json()).resolves.toMatchObject({ moreLikely: true });
  });

  it('does not flag more when the run is under the cap', async () => {
    state.expired = [row('a')];
    const res = await POST(req());
    await expect(res.json()).resolves.toMatchObject({ moreLikely: false });
  });
});

// -----------------------------------------------------------------------------
// The schedule
// -----------------------------------------------------------------------------
//
// A reaper that is never invoked is exactly the bug this route exists to fix:
// migration 011 shipped the column, the function and the promise, and no
// scheduled caller. So the registration is asserted, not assumed.
describe('cron registration', () => {
  it('is scheduled in vercel.json', async () => {
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons?: { path: string; schedule: string }[];
    };
    const entry = config.crons?.find(
      (c) => c.path === '/api/cron/reap-resumes'
    );
    expect(entry).toBeDefined();
    expect(entry?.schedule).toMatch(/^[\d*/,\-\s]+$/);
  });

  it('does not collide with the job-index sync window', async () => {
    // Both are daily; running them in the same minute makes a slow sync and a
    // slow reap compete for the same function concurrency.
    const { readFileSync } = await import('node:fs');
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons?: { path: string; schedule: string }[];
    };
    const schedules = (config.crons ?? []).map((c) => c.schedule);
    expect(new Set(schedules).size).toBe(schedules.length);
  });
});

// -----------------------------------------------------------------------------
// The scheduler has to be able to reach these routes
//
// Both cron routes exported only POST. Vercel invokes a cron job with a GET
// request, so both scheduled entries in vercel.json received 405 and NEITHER job
// ever ran in production — not the job-index sync, and not this reaper.
//
// The reaper exists because migration 011 shipped a 90-day retention window with
// no job to enforce it. Shipping a route the scheduler cannot call recreated that
// exact bug one layer up, and the earlier verification missed it by calling the
// handler with POST: that proved the handler worked and said nothing about whether
// Vercel could reach it.
//
// Asserted from the source, because the failure is a missing EXPORT — there is no
// runtime behaviour to observe when the method simply is not there.
// -----------------------------------------------------------------------------
describe('cron routes are reachable by the scheduler', () => {
  const CRON_ROUTES = [
    'src/app/api/cron/reap-resumes/route.ts',
    'src/app/api/jobs/sync/route.ts',
  ];

  it('every path scheduled in vercel.json exports a GET handler', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      crons?: { path: string }[];
    };
    const scheduled = vercel.crons ?? [];
    expect(scheduled.length).toBeGreaterThan(0);

    for (const { path } of scheduled) {
      // vercel.json holds URL paths; map each to its route file.
      const file = `src/app${path}/route.ts`;
      const source = readFileSync(file, 'utf8');

      const hasGet =
        /export\s+async\s+function\s+GET\b/.test(source) ||
        /export\s+const\s+GET\s*=/.test(source);

      expect(
        hasGet,
        `${path} is scheduled in vercel.json but ${file} exports no GET handler. ` +
          'Vercel triggers cron jobs with an HTTP GET request, so this job will ' +
          'return 405 and never run.'
      ).toBe(true);
    }
  });

  it('keeps POST too, so a job can still be triggered by hand', () => {
    for (const file of CRON_ROUTES) {
      const source = readFileSync(file, 'utf8');
      expect(/export\s+async\s+function\s+POST\b/.test(source), file).toBe(true);
    }
  });

  // An alias cannot drift; two hand-written handlers can.
  it('aliases GET to POST rather than duplicating the handler', () => {
    for (const file of CRON_ROUTES) {
      const source = readFileSync(file, 'utf8');
      expect(/export\s+const\s+GET\s*=\s*POST;/.test(source), file).toBe(true);
    }
  });
});
