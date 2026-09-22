import { NextResponse } from 'next/server';

import { requireCronSecret } from '@/lib/cron/auth';
import { syncJobIndex } from '@/lib/jobs/sync';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** Polls up to 25 boards. Comfortably inside this; the default would be tight. */
export const maxDuration = 300;

// -----------------------------------------------------------------------------
// POST /api/jobs/sync — refresh the job index
//
// Called by a schedule, not by a user. Add to vercel.json:
//
//   { "crons": [{ "path": "/api/jobs/sync", "schedule": "0 2 * * *" }] }
//
// FAILS CLOSED WITHOUT A SECRET. If `CRON_SECRET` is unset the route refuses
// rather than running: an open endpoint that makes dozens of outbound requests is
// a free denial-of-service amplifier pointed at other people's APIs.
// -----------------------------------------------------------------------------

export async function POST(request: Request) {
  // The secret check and its constant-time comparison now live in
  // `@/lib/cron/auth`, shared with the resume reaper. Two hand-rolled copies of a
  // timing-safe compare is how one of them ends up using `===`.
  const denied = requireCronSecret(request, 'job_sync');
  if (denied) return denied;

  const report = await syncJobIndex(supabaseAdmin());
  return NextResponse.json(report);
}

/**
 * VERCEL CRON INVOKES WITH GET, NOT POST.
 *
 * Same defect as /api/cron/reap-resumes: this exported only `POST`, so the
 * `0 2 * * *` entry in vercel.json got `405 Method Not Allowed` and the job index
 * has never been refreshed on a schedule. Vercel's documentation states it makes an
 * HTTP GET request to trigger a cron job.
 *
 * Aliased rather than duplicated so the two entry points cannot drift. The
 * `CRON_SECRET` bearer check still guards it, so this does not widen access.
 */
export const GET = POST;
