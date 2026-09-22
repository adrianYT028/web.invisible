import { jsonError, logSafe } from '@/lib/http';
import { csvFilename, jobsToCsv, type ExportableJob } from '@/lib/resume/csv';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// GET /api/jobs/export — the tracker as a CSV download
//
// Opens directly in Excel, Numbers and Google Sheets, which is what "record it
// somewhere I can see everything" actually needs. Every cell is escaped against
// spreadsheet formula injection — see src/lib/resume/csv.ts for why that is not
// optional when the data comes from third-party job boards.
// -----------------------------------------------------------------------------

export async function GET() {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  // DELIBERATELY NOT ENTITLEMENT-GATED.
  //
  // Every other tracker endpoint requires full access, and this one briefly did
  // too. That was wrong: the rows returned here are the user's OWN data, entered
  // by them. Withholding a copy of your own records because a plan lapsed is a
  // data-portability problem rather than a paywall, and it is the kind of thing
  // that turns a cancellation into a complaint.
  //
  // So reading and exporting what you already have stays available; CREATING and
  // discovering more is what full access buys. `.eq('user_id', ...)` below is what
  // keeps it to the caller's own rows.

  const { data, error } = await supabaseAdmin()
    .from('tracked_jobs')
    .select(
      'company, job_title, location, is_remote, status, match_score, url, notes, applied_at, created_at, source'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    logSafe('jobs_export_failed', { user_id: user.id, error: error.message });
    return jsonError(500, 'internal_error');
  }

  const csv = jobsToCsv((data ?? []) as ExportableJob[]);
  const filename = csvFilename();

  return new Response(csv, {
    status: 200,
    headers: {
      // `charset=utf-8` alongside the BOM the serialiser writes: the header covers
      // tools that read it, the BOM covers Excel, which does not.
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // A personal data export must never sit in a shared or browser cache.
      'cache-control': 'no-store, private',
    },
  });
}
