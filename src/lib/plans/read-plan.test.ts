import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  readEffectivePlan,
  resetPlanSchemaProbeForTests,
} from './read-plan';
import { BUNDLE_PLAN, FREE_PLAN } from './services';

vi.mock('@/lib/http', () => ({ logSafe: () => {} }));

interface Reply {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

/**
 * Minimal stand-in for the query builder chain
 * `from('profiles').select(cols).eq('id', id).maybeSingle()`.
 *
 * Records every `select` argument so a test can assert WHICH shape was sent —
 * that is the only way to prove the missing-column state is latched rather than
 * re-probed on every request.
 */
function fakeAdmin(replies: Record<string, Reply>) {
  const selects: string[] = [];

  const client = {
    from(table: string) {
      expect(table).toBe('profiles');
      return {
        select(cols: string) {
          selects.push(cols);
          const reply = replies[cols];
          if (!reply) {
            throw new Error(`fakeAdmin: no reply configured for select("${cols}")`);
          }
          return {
            eq: () => ({ maybeSingle: async () => reply }),
          };
        },
      };
    },
  };

  return { admin: client as unknown as SupabaseClient, selects };
}

const WITH_EXPIRY = 'plan, plan_expires_at';
const PLAN_ONLY = 'plan';

const NOW = new Date('2026-09-01T12:00:00Z');

beforeEach(() => {
  resetPlanSchemaProbeForTests();
});

describe('readEffectivePlan on a migrated database', () => {
  it('returns a paid plan whose expiry is in the future', async () => {
    const { admin, selects } = fakeAdmin({
      [WITH_EXPIRY]: {
        data: { plan: BUNDLE_PLAN, plan_expires_at: '2026-10-01T00:00:00Z' },
        error: null,
      },
    });
    await expect(readEffectivePlan(admin, 'u1', NOW)).resolves.toBe(BUNDLE_PLAN);
    expect(selects).toEqual([WITH_EXPIRY]);
  });

  it('downgrades a paid plan whose expiry has passed', async () => {
    const { admin } = fakeAdmin({
      [WITH_EXPIRY]: {
        data: { plan: BUNDLE_PLAN, plan_expires_at: '2026-08-01T00:00:00Z' },
        error: null,
      },
    });
    await expect(readEffectivePlan(admin, 'u1', NOW)).resolves.toBe(FREE_PLAN);
  });

  it('treats a null expiry as perpetual', async () => {
    const { admin } = fakeAdmin({
      [WITH_EXPIRY]: {
        data: { plan: BUNDLE_PLAN, plan_expires_at: null },
        error: null,
      },
    });
    await expect(readEffectivePlan(admin, 'u1', NOW)).resolves.toBe(BUNDLE_PLAN);
  });

  it('returns free when the user has no profile row', async () => {
    const { admin } = fakeAdmin({
      [WITH_EXPIRY]: { data: null, error: null },
    });
    await expect(readEffectivePlan(admin, 'u1', NOW)).resolves.toBe(FREE_PLAN);
  });

  // An unreadable profile must not grant access.
  it('returns free on an unrelated database error', async () => {
    const { admin, selects } = fakeAdmin({
      [WITH_EXPIRY]: {
        data: null,
        error: { code: '08006', message: 'connection failure' },
      },
    });
    await expect(readEffectivePlan(admin, 'u1', NOW)).resolves.toBe(FREE_PLAN);
    // Must NOT be mistaken for a schema problem and retried.
    expect(selects).toEqual([WITH_EXPIRY]);
  });
});

// -----------------------------------------------------------------------------
// The pre-migration-015 window
// -----------------------------------------------------------------------------
//
// Without this fallback a 42703 collapses to DEFAULT_PLAN, which silently
// downgrades every paying subscriber to the free tier's 1 upload + 1 scan a day
// and stops funding their inference. Nothing errors; the numbers just change.

describe('readEffectivePlan before migration 015 is applied', () => {
  const undefinedColumn = {
    data: null,
    error: {
      code: '42703',
      message: 'column profiles.plan_expires_at does not exist',
    },
  };

  it('falls back to the plan column and keeps a subscriber paid', async () => {
    const { admin, selects } = fakeAdmin({
      [WITH_EXPIRY]: undefinedColumn,
      [PLAN_ONLY]: { data: { plan: BUNDLE_PLAN }, error: null },
    });
    await expect(readEffectivePlan(admin, 'u1', NOW)).resolves.toBe(BUNDLE_PLAN);
    expect(selects).toEqual([WITH_EXPIRY, PLAN_ONLY]);
  });

  it('still returns free for a free user', async () => {
    const { admin } = fakeAdmin({
      [WITH_EXPIRY]: undefinedColumn,
      [PLAN_ONLY]: { data: { plan: 'free' }, error: null },
    });
    await expect(readEffectivePlan(admin, 'u1', NOW)).resolves.toBe(FREE_PLAN);
  });

  it('returns free when the fallback read also fails', async () => {
    const { admin } = fakeAdmin({
      [WITH_EXPIRY]: undefinedColumn,
      [PLAN_ONLY]: { data: null, error: { code: '08006' } },
    });
    await expect(readEffectivePlan(admin, 'u1', NOW)).resolves.toBe(FREE_PLAN);
  });

  it('returns free when there is no profile row', async () => {
    const { admin } = fakeAdmin({
      [WITH_EXPIRY]: undefinedColumn,
      [PLAN_ONLY]: { data: null, error: null },
    });
    await expect(readEffectivePlan(admin, 'u1', NOW)).resolves.toBe(FREE_PLAN);
  });

  // Latching: the doomed select is attempted once per process, not per request.
  it('stops probing for the missing column after the first failure', async () => {
    const { admin, selects } = fakeAdmin({
      [WITH_EXPIRY]: undefinedColumn,
      [PLAN_ONLY]: { data: { plan: BUNDLE_PLAN }, error: null },
    });

    await readEffectivePlan(admin, 'u1', NOW);
    await readEffectivePlan(admin, 'u2', NOW);
    await readEffectivePlan(admin, 'u3', NOW);

    expect(selects).toEqual([WITH_EXPIRY, PLAN_ONLY, PLAN_ONLY, PLAN_ONLY]);
  });

  // A cold start must re-probe, so applying the migration takes effect without
  // a manual cache bust.
  it('probes again once the latch is reset', async () => {
    const first = fakeAdmin({
      [WITH_EXPIRY]: undefinedColumn,
      [PLAN_ONLY]: { data: { plan: BUNDLE_PLAN }, error: null },
    });
    await readEffectivePlan(first.admin, 'u1', NOW);
    expect(first.selects).toEqual([WITH_EXPIRY, PLAN_ONLY]);

    resetPlanSchemaProbeForTests();

    const migrated = fakeAdmin({
      [WITH_EXPIRY]: {
        data: { plan: BUNDLE_PLAN, plan_expires_at: '2026-08-01T00:00:00Z' },
        error: null,
      },
    });
    // Now the expiry is visible again, so the lapsed plan is enforced.
    await expect(readEffectivePlan(migrated.admin, 'u1', NOW)).resolves.toBe(
      FREE_PLAN
    );
    expect(migrated.selects).toEqual([WITH_EXPIRY]);
  });
});
