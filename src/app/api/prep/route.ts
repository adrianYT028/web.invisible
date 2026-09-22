import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/http';
import { MAX_RUN_SIZE, startPrepRun } from '@/lib/jobs/prep';
import { checkResumeQuota, readPlan } from '@/lib/resume/quota';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { requireService } from '@/lib/plans/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// POST /api/prep — start a run
//
// Returns immediately with a run id. No inference happens here: job selection is
// deterministic ranking, so starting is fast. The work happens in ticks.
//
// QUOTA IS CHECKED AGAINST THE WHOLE RUN, not per item. Each item costs a scan, so
// a ten-job run needs ten scans of allowance. Discovering that at item four would
// leave the user with a half-prepared run and no way to know why it stopped.
// -----------------------------------------------------------------------------

export async function POST(request: Request) {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  // Entitlement gate (starting a prep run). Gating the API and not only the page is
  // the point: a page check alone is bypassed by calling this endpoint
  // directly.
  const gate = await requireService(user.id, 'outreach');
  if (gate) return gate;

  const body = (await request.json().catch(() => null)) as {
    count?: unknown;
    indiaOnly?: unknown;
  } | null;

  const requested =
    typeof body?.count === 'number' && Number.isFinite(body.count)
      ? Math.max(1, Math.min(Math.floor(body.count), MAX_RUN_SIZE))
      : 5;

  const admin = supabaseAdmin();
  const plan = await readPlan(admin, user.id);
  const quota = await checkResumeQuota(admin, user.id, 'scan', plan);

  // A NULL cap means unlimited (the `feature_limits` convention).
  if (quota.cap !== null) {
    const left = Math.max(quota.cap - quota.used, 0);
    if (left < requested) {
      return NextResponse.json(
        {
          code: 'quota_exceeded',
          message:
            left === 0
              ? 'You have used your scans for today.'
              : `This run needs ${requested} scans and you have ${left} left today.`,
          cap: quota.cap,
          used: quota.used,
          available: left,
          plan: quota.plan,
        },
        { status: 429 }
      );
    }
  }

  const result = await startPrepRun(admin, {
    userId: user.id,
    requested,
    indiaOnly: body?.indiaOnly !== false,
  });

  if (result.error) {
    const status =
      result.error === 'no_resume' || result.error === 'parse_quality_too_low'
        ? 422
        : result.error === 'no_postings'
          ? 404
          : 500;
    return NextResponse.json({ code: result.error }, { status });
  }

  return NextResponse.json(
    { runId: result.runId, items: result.itemCount },
    { status: 201 }
  );
}
