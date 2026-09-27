import { NextResponse } from 'next/server';

import { trackEvent } from '@/lib/analytics/track';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { aiErrorResponse, limitReached, loadCareerProfile, recordGeneration } from '@/lib/career/shared';
import { generateLinkedInDraft } from '@/lib/career/linkedin';
import { jsonError } from '@/lib/http';
import { checkAiLimit, remainingOf } from '@/lib/plans/limits';
import { checkFairUse, fairUseResponse } from '@/lib/plans/fair-use';
import { readEffectivePlan } from '@/lib/plans/read-plan';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// -----------------------------------------------------------------------------
// /api/linkedin — LinkedIn headline + About from the user's resume
//
//   GET   the latest draft (kept 30 days) and today's remaining allowance
//   POST  { targetRole?: string } -> a new draft
//
// Metered by feature_limits.max_linkedin_per_day (free 1, full access 10).
// -----------------------------------------------------------------------------

export async function GET(request: Request) {
  const auth = await resolveRequestUser(request);
  if (!auth.ok) return jsonError(401, auth.code);

  const admin = supabaseAdmin();
  const plan = await readEffectivePlan(admin, auth.userId);
  const [limit, latest] = await Promise.all([
    checkAiLimit(admin, auth.userId, 'linkedin', plan),
    admin
      .from('ai_generations')
      .select('output, created_at')
      .eq('user_id', auth.userId)
      .eq('kind', 'linkedin')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return NextResponse.json({
    draft: latest.data?.output ?? null,
    createdAt: latest.data?.created_at ?? null,
    remaining: remainingOf(limit),
    plan,
  });
}

export async function POST(request: Request) {
  const auth = await resolveRequestUser(request);
  if (!auth.ok) return jsonError(401, auth.code);
  const userId = auth.userId;

  const body = (await request.json().catch(() => null)) as { targetRole?: unknown } | null;
  const targetRole =
    typeof body?.targetRole === 'string' && body.targetRole.trim()
      ? body.targetRole.trim().slice(0, 120)
      : null;

  const admin = supabaseAdmin();
  const plan = await readEffectivePlan(admin, userId);
  const limit = await checkAiLimit(admin, userId, 'linkedin', plan);
  if (!limit.allowed) return limitReached('linkedin', limit, plan);
  const fair = await checkFairUse(admin, userId, 'web');
  if (!fair.allowed) return fairUseResponse(fair);

  try {
    const source = await loadCareerProfile(userId);
    if (!source) return jsonError(400, 'no_resume', 'Upload your resume first, then come back here.');

    const draft = await generateLinkedInDraft(userId, source, targetRole);
    await recordGeneration(userId, 'linkedin', { ...draft });
    await trackEvent('linkedin_generated', userId, { plan, removed: draft.removed });

    return NextResponse.json({
      draft,
      remaining: limit.cap === null ? null : Math.max(0, limit.cap - limit.used - 1),
    });
  } catch (err) {
    return aiErrorResponse(err, 'linkedin_generate_failed', userId);
  }
}
