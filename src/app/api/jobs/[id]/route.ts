import { NextResponse } from 'next/server';

import { jsonError, logSafe } from '@/lib/http';
import { appliedAtFor, isJobStatus } from '@/lib/resume/job-status';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// /api/jobs/[id]
//
//   PATCH  move a job's stage, or edit its notes  -> 200 { job }
//   DELETE remove it from the tracker             -> 200 { ok: true }
// -----------------------------------------------------------------------------

const SELECT =
  'id, source, external_id, company, job_title, location, is_remote, url, status, scan_id, match_score, notes, applied_at, created_at';

const MAX_NOTES = 4000;

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  // Not entitlement-gated: this edits only the caller's own rows.
  // Full access buys creating and discovering new work, not reading back
  // what you already have. See src/lib/plans/guard.ts.

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return jsonError(400, 'invalid_input');

  const admin = supabaseAdmin();

  // The existing row is needed for its `applied_at`: advancing from 'applied' to
  // 'interviewing' must PRESERVE the original application date, so the new value
  // cannot be computed from the request alone. Scoped by user_id — the
  // service-role client bypasses RLS.
  const { data: existing, error: readError } = await admin
    .from('tracked_jobs')
    .select('id, status, applied_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (readError || !existing) return jsonError(404, 'job_not_found');

  const update: Record<string, unknown> = {};

  if (body.status !== undefined) {
    if (!isJobStatus(body.status)) {
      return jsonError(400, 'invalid_input', 'That is not a valid stage.');
    }
    update.status = body.status;
    // Moved in lockstep with the status or migration 012's CHECK rejects the
    // UPDATE, which would surface to the user as a failed dropdown change.
    update.applied_at = appliedAtFor(
      body.status,
      existing.applied_at as string | null
    );
  }

  if (body.notes !== undefined) {
    update.notes =
      typeof body.notes === 'string' && body.notes.trim().length > 0
        ? body.notes.trim().slice(0, MAX_NOTES)
        : null;
  }

  if (Object.keys(update).length === 0) {
    return jsonError(400, 'invalid_input', 'Nothing to update.');
  }

  const { data, error } = await admin
    .from('tracked_jobs')
    .update(update)
    .eq('id', id)
    .eq('user_id', user.id)
    .select(SELECT)
    .single();

  if (error) {
    logSafe('jobs_update_failed', { user_id: user.id, error: error.message });
    return jsonError(500, 'internal_error');
  }

  return NextResponse.json({ job: data });
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  // Not entitlement-gated: this removes the caller's own data, which must never be withheld.
  // Full access buys creating and discovering new work, not reading back
  // what you already have. See src/lib/plans/guard.ts.

  const { error } = await supabaseAdmin()
    .from('tracked_jobs')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);

  if (error) {
    logSafe('jobs_delete_failed', { user_id: user.id, error: error.message });
    return jsonError(500, 'internal_error');
  }

  // Idempotent: deleting an already-deleted row is a success, so a double-click
  // does not produce an error the user has to think about.
  return NextResponse.json({ ok: true });
}
