import { NextResponse } from 'next/server';

import { trackEvent } from '@/lib/analytics/track';
import { resolveRequestUser } from '@/lib/auth/request-user';
import {
  MAX_ANSWER_CHARS,
  scoreAnswer,
  type InterviewSession,
} from '@/lib/career/interview';
import { aiErrorResponse, loadCareerProfile, recordGeneration } from '@/lib/career/shared';
import { jsonError } from '@/lib/http';
import { checkFairUse, fairUseResponse } from '@/lib/plans/fair-use';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// -----------------------------------------------------------------------------
// POST /api/interview/feedback — feedback on one practice answer
//
// Body: { sessionId, questionId, answer }
//
// Not counted against the daily cap on its own: a session is the unit. Bounded
// instead by allowing at most two attempts per question per session, so a
// session can never turn into unlimited AI calls.
// -----------------------------------------------------------------------------

const MAX_ATTEMPTS_PER_QUESTION = 2;

export async function POST(request: Request) {
  const auth = await resolveRequestUser(request);
  if (!auth.ok) return jsonError(401, auth.code);
  const userId = auth.userId;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
  const questionId = typeof body?.questionId === 'string' ? body.questionId : '';
  const answer = typeof body?.answer === 'string' ? body.answer.trim() : '';

  if (!/^[0-9a-f-]{36}$/i.test(sessionId) || !questionId) return jsonError(400, 'invalid_input');
  if (answer.length < 15) {
    return jsonError(400, 'invalid_input', 'Write or say a little more, a few sentences at least, then ask for feedback.');
  }
  if (answer.length > MAX_ANSWER_CHARS) {
    return jsonError(400, 'invalid_input', 'That answer is very long. Aim for about two minutes of speaking.');
  }

  const admin = supabaseAdmin();
  const { data: row } = await admin
    .from('ai_generations')
    .select('output')
    .eq('id', sessionId)
    .eq('user_id', userId)
    .eq('kind', 'interview_questions')
    .maybeSingle();
  if (!row) return jsonError(404, 'invalid_input', 'That practice session has ended. Start a new one.');

  const session = row.output as InterviewSession;
  const question = session.questions?.find((q) => q.id === questionId);
  if (!question) return jsonError(400, 'invalid_input');

  const { count } = await admin
    .from('ai_generations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', 'interview_feedback')
    .eq('output->>sessionId', sessionId)
    .eq('output->>questionId', questionId);
  if ((count ?? 0) >= MAX_ATTEMPTS_PER_QUESTION) {
    return NextResponse.json(
      { code: 'quota_exceeded', message: 'You have had feedback on this question twice. Move on to the next one.' },
      { status: 429 }
    );
  }

  const fair = await checkFairUse(admin, userId, 'web');
  if (!fair.allowed) return fairUseResponse(fair);

  try {
    const resume = await loadCareerProfile(userId).catch(() => null);
    const feedback = await scoreAnswer(userId, session, question, answer, resume);
    // Only the score is kept: the answer itself is not stored.
    await recordGeneration(userId, 'interview_feedback', { sessionId, questionId, score: feedback.score });
    await trackEvent('interview_answer_scored', userId, { score: feedback.score });
    return NextResponse.json({ feedback });
  } catch (err) {
    return aiErrorResponse(err, 'interview_feedback_failed', userId);
  }
}
