import { NextResponse } from 'next/server';

import { jsonError, logSafe } from '@/lib/http';
import { isJobStatus, appliedAtFor, type JobStatus } from '@/lib/resume/job-status';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { requireService } from '@/lib/plans/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// /api/jobs — the tracker
//
//   GET   list the caller's tracked jobs        -> 200 { jobs: [...] }
//   POST  add one                               -> 201 { job }
//
// Reads and writes both go through the service-role client with an explicit
// `user_id` filter. RLS grants read-own, but the service-role key bypasses RLS, so
// the filter in each query IS the access control — not a redundant belt.
// -----------------------------------------------------------------------------

/** Columns the client is allowed to see. `jd_text` is deliberately excluded. */
const SELECT =
  'id, source, external_id, company, job_title, location, is_remote, url, status, scan_id, match_score, notes, applied_at, created_at';

const MAX_NOTES = 4000;
const MAX_JD = 20_000;
const MAX_FIELD = 300;

export async function GET(request: Request) {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  // Not entitlement-gated: this reads only the caller's own rows.
  // Full access buys creating and discovering new work, not reading back
  // what you already have. See src/lib/plans/guard.ts.

  const status = new URL(request.url).searchParams.get('status');

  let query = supabaseAdmin()
    .from('tracked_jobs')
    .select(SELECT)
    .eq('user_id', user.id);

  // An unrecognised status is ignored rather than erroring: a stale bookmark
  // should show the full list, not a failure.
  if (status && isJobStatus(status)) query = query.eq('status', status);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    logSafe('jobs_list_failed', { user_id: user.id, error: error.message });
    return jsonError(500, 'internal_error');
  }

  return NextResponse.json({ jobs: data ?? [] });
}

export async function POST(request: Request) {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  // Entitlement gate (the job tracker). Gating the API and not only the page is
  // the point: a page check alone is bypassed by calling this endpoint
  // directly.
  const gate = await requireService(user.id, 'jobs');
  if (gate) return gate;

  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return jsonError(400, 'invalid_input');

  const company = trimmed(body.company, MAX_FIELD);
  const jobTitle = trimmed(body.job_title, MAX_FIELD);
  if (!company || !jobTitle) {
    return jsonError(
      400,
      'invalid_input',
      'A company and a role title are both required.'
    );
  }

  const status: JobStatus = isJobStatus(body.status) ? body.status : 'saved';

  // `scan_id` and `match_score` travel together — migration 012 rejects one
  // without the other. The score is re-read from the scan rather than taken from
  // the request, because a client-supplied score is a client-fabricated score.
  let scanId: string | null = null;
  let matchScore: number | null = null;
  if (typeof body.scan_id === 'string' && body.scan_id.length > 0) {
    const { data: scan } = await supabaseAdmin()
      .from('resume_scans')
      .select('id, overall_score')
      .eq('id', body.scan_id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (scan) {
      scanId = scan.id as string;
      matchScore = scan.overall_score as number;
    }
  }

  const row = {
    user_id: user.id,
    source: typeof body.source === 'string' ? body.source : 'manual',
    external_id: trimmed(body.external_id, MAX_FIELD),
    company,
    job_title: jobTitle,
    location: trimmed(body.location, MAX_FIELD),
    is_remote: body.is_remote === true,
    url: trimmed(body.url, 2000),
    jd_text: trimmed(body.jd_text, MAX_JD),
    status,
    scan_id: scanId,
    match_score: matchScore,
    notes: trimmed(body.notes, MAX_NOTES),
    // Kept consistent with the status — see src/lib/resume/job-status.ts.
    applied_at: appliedAtFor(status, null),
  };

  const { data, error } = await supabaseAdmin()
    .from('tracked_jobs')
    .insert(row)
    .select(SELECT)
    .single();

  if (error) {
    // 23505 is unique_violation: the partial index on
    // (user_id, source, external_id) already holds this posting.
    if (error.code === '23505') return jsonError(409, 'duplicate_job');
    logSafe('jobs_create_failed', { user_id: user.id, error: error.message });
    return jsonError(500, 'internal_error');
  }

  return NextResponse.json({ job: data }, { status: 201 });
}

/** Trim to a maximum length, mapping blank to null. */
function trimmed(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, max);
  return text.length > 0 ? text : null;
}
