import { NextResponse } from 'next/server';

import { trackEvent } from '@/lib/analytics/track';
import { resolveRequestUser } from '@/lib/auth/request-user';
import { generateQuestions } from '@/lib/career/interview';
import { aiErrorResponse, limitReached, loadCareerProfile, recordGeneration } from '@/lib/career/shared';
import { jsonError, logSafe } from '@/lib/http';
import { checkAiLimit } from '@/lib/plans/limits';
import { checkFairUse, fairUseResponse } from '@/lib/plans/fair-use';
import { readEffectivePlan } from '@/lib/plans/read-plan';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// -----------------------------------------------------------------------------
// POST /api/interview — start a practice session
//
// Body: { jobId?: string }  a job from the user's tracker (uses its saved
//                           description), or
//       { role: string, company?: string, jdText?: string }
//
// Returns { sessionId, role, company, questions }. One session counts once
// against feature_limits.max_interview_per_day (free 1, full access 10).
// -----------------------------------------------------------------------------

export async function POST(request: Request) {
  const auth = await resolveRequestUser(request);
  if (!auth.ok) return jsonError(401, auth.code);
  const userId = auth.userId;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return jsonError(400, 'invalid_input');

  const admin = supabaseAdmin();

  let role = typeof body.role === 'string' ? body.role.trim().slice(0, 120) : '';
  let company = typeof body.company === 'string' ? body.company.trim().slice(0, 120) || null : null;
  let jdText = typeof body.jdText === 'string' ? body.jdText.trim().slice(0, 20_000) || null : null;

  if (typeof body.jobId === 'string' && body.jobId) {
    const { data: job } = await admin
      .from('tracked_jobs')
      .select('job_title, company, jd_text')
      .eq('id', body.jobId)
      .eq('user_id', userId)
      .maybeSingle();
    if (!job) return jsonError(404, 'job_not_found');
    role = job.job_title as string;
    company = (job.company as string) ?? null;
    jdText = (job.jd_text as string | null) ?? null;
  }

  if (role.length < 2) {
    return jsonError(400, 'invalid_input', 'Pick a job from your tracker or type the role you are preparing for.');
  }

  const plan = await readEffectivePlan(admin, userId);
  const limit = await checkAiLimit(admin, userId, 'interview', plan);
  if (!limit.allowed) return limitReached('interview', limit, plan);
  const fair = await checkFairUse(admin, userId, 'web');
  if (!fair.allowed) return fairUseResponse(fair);

  try {
    // A resume makes the questions personal, but practice works without one.
    const resume = await loadCareerProfile(userId).catch(() => null);
    const session = await generateQuestions(userId, { role, company, jdText, resume });

    const sessionId = await recordGeneration(userId, 'interview_questions', { ...session });
    if (!sessionId) return jsonError(500, 'internal_error');

    await trackEvent('interview_started', userId, { plan, from_tracker: typeof body.jobId === 'string', has_resume: resume !== null });
    return NextResponse.json({ sessionId, ...session });
  } catch (err) {
    logSafe('interview_start_failed', { user_id: userId });
    return aiErrorResponse(err, 'interview_start_failed', userId);
  }
}
