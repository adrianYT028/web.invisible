import { jsonError, logSafe } from '@/lib/http';
import {
  prepCsvFilename,
  prepRunToCsv,
  type ExportablePrepItem,
} from '@/lib/jobs/prep-csv';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// GET /api/prep/[id]/export — one prep run as a CSV download
//
// A finished run held the draft email, the contact, the tailored bullets and the
// per-item outcome, and none of it could leave the browser tab it was rendered in.
// `/api/jobs/export` did not cover it: a prep run writes no `tracked_jobs` rows, so
// the tracker export cannot see a single field a run produces.
//
// Column choice and the one-row-per-job decision live in src/lib/jobs/prep-csv.ts.
// -----------------------------------------------------------------------------

/**
 * Includes the failed and skipped items, not only the ready ones — the export is a
 * record of what the run did, and an item that produced nothing still needs a row
 * saying so.
 *
 * `resume_scans(report)` is the embed that carries the tailored bullets; the prep
 * item itself stores only the score and the email.
 */
const EXPORT_SELECT =
  'status, error, match_score, email_subject, email_body, contact_hint, completed_at, ' +
  'job_postings(title, location, is_remote, url, job_companies(name)), ' +
  'resume_scans(report)';

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  // DELIBERATELY NOT ENTITLEMENT-GATED, matching GET /api/prep/[id] and
  // /api/jobs/export.
  //
  // The run was already paid for: POST /api/prep is gated and POST /api/prep/[id]
  // is gated, so no inference is spent here and nothing new is created. This reads
  // back results the caller already generated. Withholding a copy of your own
  // output because a plan lapsed is a data-portability problem, not a paywall.
  //
  // `.eq('user_id', user.id)` on both queries below is what keeps it to the
  // caller's own rows.

  const admin = supabaseAdmin();

  // Ownership is established before the items are read, so a run id belonging to
  // someone else is a 404 rather than an empty file. An empty CSV would be a
  // quieter answer, but it would also confirm nothing about whether the id exists —
  // and this route is only reachable for ids the caller can already see.
  const { data: run } = await admin
    .from('prep_run_progress')
    .select('run_id, status')
    .eq('run_id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!run) return jsonError(404, 'job_not_found');

  const { data, error } = await admin
    .from('prep_items')
    .select(EXPORT_SELECT)
    .eq('run_id', id)
    .eq('user_id', user.id)
    // Best matches first: the sheet should open on the jobs worth applying to.
    // `nullsFirst: false` keeps the scoreless failed and skipped rows at the
    // bottom instead of at the top.
    .order('match_score', { ascending: false, nullsFirst: false });

  if (error) {
    logSafe('prep_export_failed', {
      user_id: user.id,
      run_id: id,
      error: error.message,
    });
    return jsonError(500, 'internal_error');
  }

  // Cast required because the typed client cannot infer a nested relation select
  // and widens it to an error union — same reason as GET /api/prep/[id].
  const items = (data ?? []) as unknown as ExportablePrepItem[];

  const csv = prepRunToCsv(items);
  const filename = prepCsvFilename(id);

  return new Response(csv, {
    status: 200,
    headers: {
      // `charset=utf-8` for tools that read the header, plus the BOM the serialiser
      // writes for Excel, which does not.
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // This file contains the user's resume content and third-party contact
      // addresses. It must never sit in a shared or browser cache.
      'cache-control': 'no-store, private',
    },
  });
}
