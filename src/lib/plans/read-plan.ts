// -----------------------------------------------------------------------------
// Reading the plan in force
// -----------------------------------------------------------------------------
//
// One function, used by every caller that needs to know what a user is entitled
// to. It previously existed twice — privately in `src/app/api/ai/_shared.ts` and
// exported from `src/lib/resume/quota.ts` — with identical bodies, which is how
// the expiry check would have ended up applied in one place and not the other.
//
// ---------------------------------------------------------------------------
// WHY THIS TOLERATES A MISSING COLUMN
//
// `profiles.plan_expires_at` is added by migration 015. Applying a migration and
// shipping the code that depends on it are two separate acts that cannot be made
// atomic, and this project has a single Supabase project shared by local
// development and production — so there is a real window in which the code
// expects a column the database does not have.
//
// PostgREST answers a select for an unknown column with HTTP 400 and SQLSTATE
// 42703. Both existing callers collapse any error to `DEFAULT_PLAN`, so without
// this fallback that window silently downgrades EVERY user to `free`: paying
// subscribers lose platform-funded inference and drop to the free tier's caps of
// one upload and one scan per day. Failing that way is worse than not shipping
// the feature, and it is invisible — nothing errors, the numbers just quietly
// change.
//
// So a 42703 is treated as "this database predates migration 015", which means
// no plan has an expiry, which means the plan column alone is the whole answer.
// That is exactly the behaviour before this feature existed. Every other error
// still falls back to `free`, because an unreadable profile must not grant
// access.
//
// This fallback becomes dead code once migration 015 is applied everywhere. It is
// cheap to keep and expensive to have needed and not had.

import { type SupabaseClient } from '@supabase/supabase-js';

import { DEFAULT_PLAN } from '@/lib/ai/plans';
import { logSafe } from '@/lib/http';

import { resolveEffectivePlan } from './services';

/** PostgREST/PostgreSQL `undefined_column`. */
const UNDEFINED_COLUMN = '42703';

/**
 * Remembers that this database has no `plan_expires_at`, so the probing select
 * is attempted once per process rather than on every request.
 *
 * Deliberately not persisted anywhere: a cold start re-probes, so applying the
 * migration takes effect without a manual cache bust or a redeploy.
 */
let expiryColumnAbsent = false;

interface ProfileRow {
  plan?: unknown;
  plan_expires_at?: unknown;
}

/** Narrow the column values, which arrive as `unknown` from the client. */
function resolveRow(row: ProfileRow, now?: Date): string {
  const plan = typeof row.plan === 'string' ? row.plan : null;
  const expiresAt =
    typeof row.plan_expires_at === 'string' ? row.plan_expires_at : null;
  return resolveEffectivePlan(plan, expiresAt, now ?? new Date());
}

/**
 * The plan IN FORCE for a user: `profiles.plan` resolved against its expiry.
 *
 * Returns `free` when there is no profile row, when the row cannot be read, or
 * when a paid plan's expiry has passed. Never throws — callers use this to make
 * a gating decision, and an exception on a plan lookup would turn a routine
 * database hiccup into a failed request.
 *
 * `now` is injectable for tests.
 */
export async function readEffectivePlan(
  admin: SupabaseClient,
  userId: string,
  now?: Date
): Promise<string> {
  if (!expiryColumnAbsent) {
    const { data, error } = await admin
      .from('profiles')
      .select('plan, plan_expires_at')
      .eq('id', userId)
      .maybeSingle();

    if (!error) {
      if (!data) return DEFAULT_PLAN;
      return resolveRow(data as ProfileRow, now);
    }

    if (error.code !== UNDEFINED_COLUMN) return DEFAULT_PLAN;

    // Pre-migration-015 database. Latch and fall through to the plan-only read.
    expiryColumnAbsent = true;
    logSafe('plan_expiry_column_absent', {
      detail: 'profiles.plan_expires_at missing; apply migration 015. Plan '
        + 'expiry is not being enforced until it is applied.',
    });
  }

  const { data, error } = await admin
    .from('profiles')
    .select('plan')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) return DEFAULT_PLAN;
  // No expiry column, so nothing can have lapsed: the stored plan is in force.
  return resolveRow({ plan: (data as ProfileRow).plan }, now);
}

/** Test seam: forget the latched schema state between cases. */
export function resetPlanSchemaProbeForTests(): void {
  expiryColumnAbsent = false;
}
