// -----------------------------------------------------------------------------
// Plan limits for the tracker and the newer AI features
// -----------------------------------------------------------------------------
//
// Same conventions as src/lib/resume/quota.ts, and for the same reasons:
//
//   - NULL in `feature_limits` means UNLIMITED. Migration 023 sets an explicit
//     value for `free` on every column it adds.
//   - Daily caps use the UTC day, matching `utcDayWindow`.
//   - Reads FAIL OPEN on a database error: a transient outage should not tell a
//     paying user they are out of allowance. The AI provider's own rate limit is
//     the hard ceiling behind the daily caps.
// -----------------------------------------------------------------------------

import { type SupabaseClient } from '@supabase/supabase-js';

import { utcDayWindow } from '@/lib/resume/quota';

export interface LimitVerdict {
  allowed: boolean;
  /** null when unlimited. */
  cap: number | null;
  used: number;
}

type CapColumn = 'max_tracked_jobs' | 'max_linkedin_per_day' | 'max_interview_per_day';

async function readCap(
  admin: SupabaseClient,
  plan: string,
  column: CapColumn
): Promise<number | null> {
  const { data, error } = await admin
    .from('feature_limits')
    .select(column)
    .eq('plan', plan)
    .maybeSingle();
  if (error || !data) return null;
  const value = (data as Record<string, unknown>)[column];
  return typeof value === 'number' ? value : null;
}

/**
 * Whether the user may save one more job. Counts every row in their tracker,
 * whatever its stage: archiving a job does not free a slot, deleting it does.
 * That keeps the rule one sentence long ("up to 50 saved jobs").
 */
export async function checkTrackerLimit(
  admin: SupabaseClient,
  userId: string,
  plan: string
): Promise<LimitVerdict> {
  const cap = await readCap(admin, plan, 'max_tracked_jobs');
  if (cap === null) return { allowed: true, cap: null, used: 0 };

  const { count, error } = await admin
    .from('tracked_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) return { allowed: true, cap, used: 0 };

  const used = count ?? 0;
  return { allowed: used < cap, cap, used };
}

/** The AI features metered through `ai_generations`. */
export type AiFeature = 'linkedin' | 'interview';

const AI_FEATURES: Record<AiFeature, { column: CapColumn; kind: string }> = {
  linkedin: { column: 'max_linkedin_per_day', kind: 'linkedin' },
  // One interview session = one question set. Feedback on the answers inside a
  // session is not counted separately; it is bounded by the number of questions.
  interview: { column: 'max_interview_per_day', kind: 'interview_questions' },
};

/** Whether the user may run one more of an AI feature today. */
export async function checkAiLimit(
  admin: SupabaseClient,
  userId: string,
  feature: AiFeature,
  plan: string
): Promise<LimitVerdict> {
  const { column, kind } = AI_FEATURES[feature];
  const cap = await readCap(admin, plan, column);
  if (cap === null) return { allowed: true, cap: null, used: 0 };

  const { start, end } = utcDayWindow(new Date());
  const { count, error } = await admin
    .from('ai_generations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', kind)
    .gte('created_at', start)
    .lt('created_at', end);
  if (error) return { allowed: true, cap, used: 0 };

  const used = count ?? 0;
  return { allowed: used < cap, cap, used };
}

/** "3 of 50" style remaining count for the UI; null when unlimited. */
export function remainingOf(verdict: LimitVerdict): number | null {
  return verdict.cap === null ? null : Math.max(0, verdict.cap - verdict.used);
}
