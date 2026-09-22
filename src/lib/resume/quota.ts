// -----------------------------------------------------------------------------
// Resume quotas — the only thing bounding platform-funded inference
// -----------------------------------------------------------------------------
//
// Resume inference is paid for by us on every plan, including free (see
// src/lib/resume/ai/client.ts for why the free taster cannot be bring-your-own-
// key). That makes this module the cost control for the whole feature: without it
// a single account, shared or scripted, runs an unbounded bill.
//
// TWO CONVENTIONS INHERITED FROM `feature_limits`, BOTH EASY TO GET WRONG:
//
//   NULL MEANS UNLIMITED, not zero. A missing row or a missing column therefore
//   grants unlimited access. Migration 011 carries a loud warning about this and
//   explicitly UPDATEs the `free` row, because adding nullable columns would
//   otherwise have shipped the paid feature free to everyone.
//
//   THE DAY WINDOW IS UTC, matching `public.utc_date()` and the day index on
//   `api_usage`. Not the user's local midnight — a user in IST would otherwise get
//   two allowances on the day the windows disagree.

import { type SupabaseClient } from '@supabase/supabase-js';

import { readEffectivePlan } from '@/lib/plans/read-plan';

/** Which resume action is being metered. */
export type ResumeAction = 'upload' | 'scan';

interface ActionConfig {
  /** Column on `feature_limits`. */
  capColumn: 'max_resume_uploads_per_day' | 'max_resume_scans_per_day';
  /** Table whose rows created today count against the cap. */
  table: 'resumes' | 'resume_scans';
}

/**
 * Rows are counted rather than attempts, which makes the cap forgiving in exactly
 * the right way: re-uploading an identical file is idempotent on
 * `(user_id, content_hash)` and re-scanning the same resume against the same job
 * returns the stored report, so neither consumes a fresh allowance. A user who
 * refreshes the page has not spent their daily scan.
 */
const ACTIONS: Record<ResumeAction, ActionConfig> = {
  upload: { capColumn: 'max_resume_uploads_per_day', table: 'resumes' },
  scan: { capColumn: 'max_resume_scans_per_day', table: 'resume_scans' },
};

export interface QuotaVerdict {
  allowed: boolean;
  /** The plan the verdict was computed for. */
  plan: string;
  /** null when unlimited. */
  cap: number | null;
  /** Rows already created in the current UTC day. */
  used: number;
}

/**
 * The caller's plan IN FORCE, defaulting to `free` when no profile row exists.
 *
 * An alias for `readEffectivePlan`, so a lapsed subscriber is metered as `free`.
 * Kept as a named export here because the resume routes already import
 * `readPlan` from this module; the implementation is shared with the AI proxy so
 * the expiry rule cannot be applied in one place and forgotten in the other.
 */
export const readPlan = readEffectivePlan;

/**
 * Whether the caller may perform a resume action right now.
 *
 * Fails OPEN on a database error — a `feature_limits` read failure returns
 * unlimited rather than blocking. That is the deliberate trade: a transient
 * outage briefly costing us inference is better than telling paying subscribers
 * their quota is exhausted when it is not. The hard ceiling behind this is the
 * Groq rate limit, which fails closed on its own.
 */
export async function checkResumeQuota(
  admin: SupabaseClient,
  userId: string,
  action: ResumeAction,
  plan?: string
): Promise<QuotaVerdict> {
  const resolvedPlan = plan ?? (await readPlan(admin, userId));
  const config = ACTIONS[action];

  const { data, error } = await admin
    .from('feature_limits')
    .select(config.capColumn)
    .eq('plan', resolvedPlan)
    .maybeSingle();

  // Missing row or NULL column both mean unlimited.
  const capValue =
    error || !data
      ? null
      : (data as Record<string, unknown>)[config.capColumn];
  const cap = typeof capValue === 'number' ? capValue : null;

  if (cap === null) {
    return { allowed: true, plan: resolvedPlan, cap: null, used: 0 };
  }

  const { start, end } = utcDayWindow(new Date());
  const { count, error: countError } = await admin
    .from(config.table)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', start)
    .lt('created_at', end);

  // Fail open — see the note above.
  if (countError) {
    return { allowed: true, plan: resolvedPlan, cap, used: 0 };
  }

  const used = count ?? 0;
  return { allowed: used < cap, plan: resolvedPlan, cap, used };
}

/**
 * The current UTC day as ISO bounds: `[00:00:00.000Z, next 00:00:00.000Z)`.
 * Equivalent to `public.utc_date(created_at) = public.utc_date(now())`.
 */
export function utcDayWindow(now: Date): { start: string; end: string } {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}
