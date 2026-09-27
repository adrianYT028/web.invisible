import { NextResponse } from 'next/server';
import { type SupabaseClient } from '@supabase/supabase-js';

import { logSafe } from '@/lib/http';

// -----------------------------------------------------------------------------
// Fair use: a timeout for excessive AI use
// -----------------------------------------------------------------------------
//
// Full access is one ₹99 payment and we pay for every AI call after it. The
// per-feature daily caps (feature_limits) stop any ONE feature running away;
// this stops the TOTAL. It counts the user's AI calls in `api_usage` (every call
// is logged there already) over the last hour and the last 24 hours.
//
// The limits are set far above what a real person does, so normal use never
// meets them. For scale, a heavy but genuine day on the website is about:
//   40 resume scans x 2-3 calls + a 20-job bulk prep x 3 calls + a few interview
//   sessions ~= 200 calls.
// The web limit is double that. A pause means something is automated or shared.
//
// Crossing a limit writes a timeout to `usage_cooldowns` (migration 024):
//   1st time in 24h: 1 hour · 2nd: 6 hours · 3rd and later: 24 hours.
// During a timeout AI features return 429 with a plain message and a
// Retry-After. The tracker, saved data and downloads keep working.
//
// FAILS OPEN on a database error, like every other limit here: a Supabase blip
// must not lock out paying users. The AI provider's own rate limit is the hard
// ceiling behind it.
// -----------------------------------------------------------------------------

/** `api_usage.endpoint` values written by the website's AI features. */
export const WEB_AI_ENDPOINTS = [
  'resume_profile_extract',
  'resume_jd_extract',
  'resume_rewrite',
  'resume_outreach',
  'linkedin_optimise',
  'interview_questions',
  'interview_feedback',
] as const;

/** `api_usage.endpoint` values written by the desktop AI proxy. */
export const DESKTOP_AI_ENDPOINTS = ['chat', 'transcribe', 'vision'] as const;

export type FairUseScope = 'web' | 'desktop';

export const FAIR_USE_LIMITS: Record<
  FairUseScope,
  { perHour: number; perDay: number; endpoints: readonly string[] }
> = {
  web: { perHour: 150, perDay: 400, endpoints: WEB_AI_ENDPOINTS },
  // The desktop app transcribes audio in short chunks, so a genuine one-hour
  // interview can be several hundred calls. Only reached by continuous,
  // around-the-clock use. Checked only when the request would run on OUR key.
  desktop: { perHour: 1500, perDay: 6000, endpoints: DESKTOP_AI_ENDPOINTS },
};

/** Timeout length by strike number within 24 hours (1-based; last value repeats). */
export const COOLDOWN_MINUTES = [60, 6 * 60, 24 * 60] as const;

export type FairUseVerdict =
  | { allowed: true }
  | { allowed: false; until: Date; retryAfterSeconds: number; firstStrike: boolean };

export function cooldownMinutesFor(strike: number): number {
  const i = Math.min(Math.max(strike, 1), COOLDOWN_MINUTES.length) - 1;
  return COOLDOWN_MINUTES[i];
}

async function countSince(
  admin: SupabaseClient,
  userId: string,
  endpoints: readonly string[],
  since: Date
): Promise<number | null> {
  const { count, error } = await admin
    .from('api_usage')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('endpoint', endpoints as string[])
    .gte('occurred_at', since.toISOString());
  return error ? null : (count ?? 0);
}

/**
 * Whether this user may make another AI call right now. Call it BEFORE spending
 * inference. It may record a new timeout as a side effect.
 */
export async function checkFairUse(
  admin: SupabaseClient,
  userId: string,
  scope: FairUseScope,
  now: Date = new Date()
): Promise<FairUseVerdict> {
  try {
    const { data: existing } = await admin
      .from('usage_cooldowns')
      .select('until, strikes, last_strike_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (existing && new Date(existing.until as string).getTime() > now.getTime()) {
      const until = new Date(existing.until as string);
      return {
        allowed: false,
        until,
        retryAfterSeconds: Math.ceil((until.getTime() - now.getTime()) / 1000),
        firstStrike: (existing.strikes as number) <= 1,
      };
    }

    const limits = FAIR_USE_LIMITS[scope];
    const [hour, day] = await Promise.all([
      countSince(admin, userId, limits.endpoints, new Date(now.getTime() - 3_600_000)),
      countSince(admin, userId, limits.endpoints, new Date(now.getTime() - 86_400_000)),
    ]);
    if (hour === null || day === null) return { allowed: true };

    const overHour = hour >= limits.perHour;
    const overDay = day >= limits.perDay;
    if (!overHour && !overDay) return { allowed: true };

    // Strikes count up only while they are within 24 hours of each other.
    const recent =
      existing &&
      now.getTime() - new Date(existing.last_strike_at as string).getTime() < 86_400_000;
    const strikes = recent ? (existing.strikes as number) + 1 : 1;
    const until = new Date(now.getTime() + cooldownMinutesFor(strikes) * 60_000);

    await admin.from('usage_cooldowns').upsert(
      {
        user_id: userId,
        until: until.toISOString(),
        strikes,
        last_strike_at: now.toISOString(),
        reason: `${scope}_${overHour ? 'hour' : 'day'}`,
        hour_count: hour,
        day_count: day,
      },
      { onConflict: 'user_id' }
    );
    logSafe('fair_use_cooldown_started', {
      user_id: userId,
      scope,
      strikes,
      hour_count: hour,
      day_count: day,
      minutes: cooldownMinutesFor(strikes),
    });

    return {
      allowed: false,
      until,
      retryAfterSeconds: Math.ceil((until.getTime() - now.getTime()) / 1000),
      firstStrike: strikes === 1,
    };
  } catch {
    return { allowed: true };
  }
}

/** "about 45 minutes", "about 6 hours". */
function roughly(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/** The 429 the website's AI routes return during a timeout. */
export function fairUseResponse(verdict: Extract<FairUseVerdict, { allowed: false }>) {
  return NextResponse.json(
    {
      code: 'fair_use_cooldown',
      message: `You have used a lot of AI features in a short time, so they are paused for ${roughly(
        verdict.retryAfterSeconds
      )}. Your tracker and saved work are not affected. If you think this is a mistake, email us.`,
      retryAfterSeconds: verdict.retryAfterSeconds,
      until: verdict.until.toISOString(),
    },
    { status: 429, headers: { 'retry-after': String(verdict.retryAfterSeconds) } }
  );
}
