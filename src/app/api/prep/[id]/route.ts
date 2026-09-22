import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/http';
import { gmailComposeUrl, mailtoUrl } from '@/lib/jobs/contacts';
import { tickPrepRun } from '@/lib/jobs/prep';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { requireService } from '@/lib/plans/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** Two items of model work per tick. The default would be tight. */
export const maxDuration = 120;

// -----------------------------------------------------------------------------
// /api/prep/[id]
//
//   GET   progress + prepared items   -> 200
//   POST  process the next few items  -> 200
//
// The client polls GET and calls POST while a run is unfinished. Splitting them
// means a slow tick never blocks the progress display.
// -----------------------------------------------------------------------------

const ITEM_SELECT =
  'id, status, error, match_score, email_subject, email_body, contact_hint, scan_id, completed_at, ' +
  'job_postings(id, title, location, is_remote, url, job_companies(name))';

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

  // Not entitlement-gated: this reads only the caller's own rows.
  // Full access buys creating and discovering new work, not reading back
  // what you already have. See src/lib/plans/guard.ts.

  const admin = supabaseAdmin();

  // The progress view counts rows rather than reading counters, so it cannot drift
  // out of step with the items.
  const { data: progress } = await admin
    .from('prep_run_progress')
    .select('*')
    .eq('run_id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!progress) return jsonError(404, 'job_not_found');

  const { data: items } = await admin
    .from('prep_items')
    .select(ITEM_SELECT)
    .eq('run_id', id)
    .eq('user_id', user.id)
    .order('match_score', { ascending: false, nullsFirst: false });

  // Cast required because the typed client cannot infer a nested relation select
  // (`job_postings(... job_companies(name))`) and widens it to an error union.
  const rows = (items ?? []) as unknown as Array<Record<string, unknown>>;

  return NextResponse.json({
    run: {
      id: progress.run_id,
      status: progress.status,
      requested: progress.requested,
      done: progress.done,
      failed: progress.failed,
      skipped: progress.skipped,
      queued: progress.queued,
      tokensUsed: progress.tokens_used,
    },
    items: rows.map(shapeItem),
  });
}

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  // Entitlement gate (reading a prep run). Gating the API and not only the page is
  // the point: a page check alone is bypassed by calling this endpoint
  // directly.
  const gate = await requireService(user.id, 'outreach');
  if (gate) return gate;

  const result = await tickPrepRun(supabaseAdmin(), id, user.id);
  return NextResponse.json(result);
}

/** Shape one prepared item for the client, including ready-to-open mail links. */
function shapeItem(row: Record<string, unknown>) {
  const posting = row.job_postings as {
    id?: string;
    title?: string;
    location?: string | null;
    is_remote?: boolean;
    url?: string;
    job_companies?: { name?: string } | null;
  } | null;

  const subject = (row.email_subject as string | null) ?? null;
  const body = (row.email_body as string | null) ?? null;
  const contact = (row.contact_hint as string | null) ?? null;

  // Only build a send link when there is BOTH an address and a draft. `contact_hint`
  // holds guidance text rather than an address when the posting published none, so
  // the `@` check is what distinguishes them.
  const hasAddress = contact !== null && contact.includes('@') && !contact.includes(' ');
  const canSend = hasAddress && subject !== null && body !== null;

  return {
    id: row.id,
    status: row.status,
    error: row.error,
    matchScore: row.match_score,
    scanId: row.scan_id,
    job: {
      id: posting?.id ?? null,
      title: posting?.title ?? null,
      company: posting?.job_companies?.name ?? null,
      location: posting?.location ?? null,
      isRemote: posting?.is_remote ?? false,
      url: posting?.url ?? null,
    },
    email:
      subject && body
        ? {
            subject,
            body,
            to: hasAddress ? contact : null,
            // Guidance shown when there is no address to send to.
            guidance: hasAddress ? null : contact,
            gmailUrl: canSend
              ? gmailComposeUrl({ to: contact, subject, body })
              : null,
            mailtoUrl: canSend ? mailtoUrl({ to: contact, subject, body }) : null,
          }
        : null,
  };
}
