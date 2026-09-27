import { NextResponse } from 'next/server';

import { resolveRequestUser } from '@/lib/auth/request-user';
import { jsonError, logSafe } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// GET /api/resume/latest — the caller's most recent scannable resume
// -----------------------------------------------------------------------------
//
// Exists for the browser extension, which cannot hold the `resumeId` the
// /resume page keeps in client state after an upload. The extension asks for the
// latest readable resume and scans the job on the current tab against it.
//
// Returns 200 { resume: { id, fileName, parseIntegrity, createdAt } | null }.
// `null` (not 404) when there is none yet, because "upload a resume first" is an
// expected state, not an error. Only metadata is returned: never the extracted
// text, the storage path, or the profile.
//
// Scoped by user_id explicitly: the service-role client bypasses RLS, so that
// filter IS the access control. Expired rows are skipped even before the reaper
// cron deletes them, so the extension never offers a resume that is about to
// vanish mid-scan.
// -----------------------------------------------------------------------------

export async function GET(request: Request) {
  const auth = await resolveRequestUser(request);
  if (!auth.ok) return jsonError(401, auth.code);

  const { data, error } = await supabaseAdmin()
    .from('resumes')
    .select('id, original_filename, parse_integrity, created_at')
    .eq('user_id', auth.userId)
    .eq('extraction_status', 'extracted')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logSafe('resume_latest_failed', { user_id: auth.userId, error: error.message });
    return jsonError(500, 'internal_error');
  }

  return NextResponse.json({
    resume: data
      ? {
          id: data.id as string,
          fileName: data.original_filename as string,
          parseIntegrity:
            typeof data.parse_integrity === 'number' ? data.parse_integrity : null,
          createdAt: data.created_at as string,
        }
      : null,
  });
}
