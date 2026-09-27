import { NextResponse } from 'next/server';

import { resolveRequestUser } from '@/lib/auth/request-user';
import { jsonError, logSafe } from '@/lib/http';
import {
  appliedAtFor,
  dateInDays,
  DEFAULT_FOLLOW_UP_DAYS,
  isJobStatus,
} from '@/lib/resume/job-status';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// /api/jobs/[id]
//
//   GET    one job, including the saved job description -> 200 { job }
//   PATCH  change stage, notes or follow-up date         -> 200 { job }
//   DELETE remove it from the tracker                    -> 200 { ok: true }
//
// Cookie or bearer (browser extension) auth, via resolveRequestUser.
// -----------------------------------------------------------------------------

const SELECT =
  'id, source, external_id, company, job_title, location, is_remote, url, status, scan_id, match_score, notes, follow_up_at, applied_at, created_at';

const MAX_NOTES = 4000;

/** A calendar date the user picked, or null to clear it. Undefined = invalid. */
function parseFollowUp(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const t = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(t)) return undefined;
  // Within a sane window: not years in the past or future.
  const days = (t - Date.now()) / 86_400_000;
  return days > -366 && days < 366 ? value : undefined;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const auth = await resolveRequestUser(request);
  if (!auth.ok) return jsonError(401, auth.code);

  // Not entitlement-gated: reads only the caller's own row, including the job
  // description they saved (not_authenticated otherwise).
  const { data, error } = await supabaseAdmin()
    .from('tracked_jobs')
    .select(`${SELECT}, jd_text`)
    .eq('id', id)
    .eq('user_id', auth.userId)
    .maybeSingle();

  if (error || !data) return jsonError(404, 'job_not_found');
  return NextResponse.json({ job: data });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const auth = await resolveRequestUser(request);
  if (!auth.ok) return jsonError(401, auth.code);
  const user = { id: auth.userId };

  // Not entitlement-gated: this edits only the caller's own rows
  // (not_authenticated otherwise). See src/lib/plans/guard.ts.

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
    .select('id, status, applied_at, follow_up_at')
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

    // Moving a job to "Applied" suggests a follow-up a week later, unless the
    // user already set one (or is setting one in this same request). They can
    // change or clear it in the tracker; the reminder email uses it.
    if (
      body.status === 'applied' &&
      existing.status !== 'applied' &&
      existing.follow_up_at === null &&
      body.follow_up_at === undefined
    ) {
      update.follow_up_at = dateInDays(DEFAULT_FOLLOW_UP_DAYS);
    }
    // Closed-out jobs need no reminder.
    if (['offer', 'rejected', 'archived'].includes(body.status)) {
      update.follow_up_at = null;
    }
  }

  if (body.follow_up_at !== undefined) {
    const parsed = parseFollowUp(body.follow_up_at);
    if (parsed === undefined) {
      return jsonError(400, 'invalid_input', 'Pick a follow-up date within the next year.');
    }
    update.follow_up_at = parsed;
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
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const auth = await resolveRequestUser(request);
  if (!auth.ok) return jsonError(401, auth.code);
  const user = { id: auth.userId };

  // Not entitlement-gated: this removes the caller's own data, which must
  // never be withheld (not_authenticated otherwise).

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
