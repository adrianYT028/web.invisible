import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the plan-based half of the entitlement layer.
 *
 * The behaviour under test is not a status code, it is WHICH database operation
 * is issued. `grantBundleAccess` must UPSERT rather than UPDATE, because an
 * UPDATE against a user with no `profiles` row affects zero rows and reports
 * success — the customer is charged and receives nothing, silently. 60 of 97
 * accounts on this database have no profile row (they predate migration 001's
 * trigger), four of them paying, so this is a live condition rather than a
 * theoretical one.
 */

interface Call {
  table: string;
  op: 'upsert' | 'update';
  payload: Record<string, unknown>;
  opts?: unknown;
  filters: Record<string, unknown>;
}

const calls: Call[] = [];
let failNext = false;

function fakeAdmin() {
  return {
    from(table: string) {
      const call: Call = {
        table,
        op: 'update',
        payload: {},
        filters: {},
      };
      const builder = {
        upsert(payload: Record<string, unknown>, opts?: unknown) {
          call.op = 'upsert';
          call.payload = payload;
          call.opts = opts;
          calls.push(call);
          return Promise.resolve({
            error: failNext ? { message: 'boom' } : null,
          });
        },
        update(payload: Record<string, unknown>) {
          call.op = 'update';
          call.payload = payload;
          calls.push(call);
          return {
            eq(col: string, val: unknown) {
              call.filters[col] = val;
              return Promise.resolve({
                error: failNext ? { message: 'boom' } : null,
              });
            },
          };
        },
      };
      return builder;
    },
  };
}

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => fakeAdmin() }));
vi.mock('@/lib/http', () => ({ logSafe: () => {} }));

import { BUNDLE_PLAN, FREE_PLAN } from '@/lib/plans/services';
import { grantBundleAccess, revokeBundleAccess } from './entitlements';

beforeEach(() => {
  calls.length = 0;
  failNext = false;
});

describe('grantBundleAccess', () => {
  // The whole point. An UPDATE would be a silent no-op for a user with no
  // profiles row, and the caller would report a successful purchase.
  it('upserts rather than updating, so a missing profile cannot swallow a purchase', async () => {
    await expect(grantBundleAccess('u1', 'pay1')).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('profiles');
    expect(calls[0].op).toBe('upsert');
    expect(calls[0].opts).toEqual({ onConflict: 'id' });
  });

  it('writes the id, the paid plan, and an explicitly null expiry', async () => {
    await grantBundleAccess('u1', 'pay1');
    expect(calls[0].payload).toEqual({
      // Required for an upsert to be able to INSERT.
      id: 'u1',
      plan: BUNDLE_PLAN,
      // Explicit, so a stale expiry from an earlier time-limited grant cannot
      // survive and lapse a perpetual purchase.
      plan_expires_at: null,
    });
  });

  // Writing only the plan columns leaves display_name intact on an existing row.
  it('does not touch any column other than the plan pair', async () => {
    await grantBundleAccess('u1', null);
    expect(Object.keys(calls[0].payload).sort()).toEqual([
      'id',
      'plan',
      'plan_expires_at',
    ]);
  });

  it('reports failure when the write fails', async () => {
    failNext = true;
    await expect(grantBundleAccess('u1', 'pay1')).resolves.toBe(false);
  });
});

describe('revokeBundleAccess', () => {
  it('sets the plan back to free and clears the expiry together', async () => {
    await expect(revokeBundleAccess('u1', 'refund:x')).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('profiles');
    // Migration 015 CHECKs that a free plan carries no expiry, so writing one
    // without the other is rejected by the database.
    expect(calls[0].payload).toEqual({ plan: FREE_PLAN, plan_expires_at: null });
    expect(calls[0].filters).toEqual({ id: 'u1' });
  });

  // Deliberately an UPDATE. A user with no profiles row has no plan to revoke, so
  // affecting zero rows is the correct outcome — unlike the grant, where it would
  // mean losing a purchase.
  it('stays an update, since there is nothing to create when revoking', async () => {
    await revokeBundleAccess('u1', 'refund:x');
    expect(calls[0].op).toBe('update');
  });

  it('reports failure when the write fails', async () => {
    failNext = true;
    await expect(revokeBundleAccess('u1', 'refund:x')).resolves.toBe(false);
  });
});
