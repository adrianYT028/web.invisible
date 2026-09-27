import { trackEvent } from '@/lib/analytics/track';
import { jsonError } from '@/lib/http';
import { exportFilename } from '@/lib/resume/export/document';
import { buildDocx } from '@/lib/resume/export/docx';
import { loadTailoredResume } from '@/lib/resume/export/load';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// GET /api/resume/export/[scanId] — the tailored resume as a Word file
//
// Not entitlement-gated and not metered: it spends no AI and creates nothing
// new, it only re-assembles a scan the user already ran from their own resume.
// The PDF version is the print page at /resume/print/[scanId].
// -----------------------------------------------------------------------------

export async function GET(
  _request: Request,
  context: { params: Promise<{ scanId: string }> }
) {
  const { scanId } = await context.params;

  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  const loaded = await loadTailoredResume(user.id, scanId);
  if (!loaded) return jsonError(404, 'resume_not_found');

  const file = await buildDocx(loaded.doc);
  await trackEvent('resume_exported', user.id, { format: 'docx', rewrites: loaded.doc.rewritesApplied });

  return new Response(new Uint8Array(file), {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${exportFilename(loaded.doc.name, loaded.company, 'docx')}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
