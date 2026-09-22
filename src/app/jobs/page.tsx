import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { userHasService } from '@/lib/plans/guard';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

import { JobTracker, type TrackedJob } from './JobTracker';

/**
 * `/jobs` — the application tracker.
 *
 * Server-rendered with the first page of jobs already in the markup, rather than
 * fetching on mount. The list is the entire content of this page, so a
 * client-side fetch would guarantee a visible empty flash on every visit for data
 * the server already has.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Job tracker',
  description:
    'Every role you are pursuing, with its match score, stage, and notes — exportable to a spreadsheet.',
  alternates: { canonical: '/jobs' },
  robots: { index: false },
};

export default async function JobsPage() {
  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login?redirectedFrom=%2Fjobs');

  // The tracker itself is NOT paywalled: these are the user's own rows, and
  // reading, editing, exporting or deleting them stays available whatever their
  // plan. What full access buys is SAVING NEW roles and discovering them, which is
  // gated in `/api/jobs` (POST) and `/api/jobs/discover`.
  const entitled = await userHasService(user.id, 'jobs');

  const { data } = await supabaseAdmin()
    .from('tracked_jobs')
    .select(
      'id, source, company, job_title, location, is_remote, url, status, scan_id, match_score, notes, applied_at, created_at'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(500);

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Tracker</p>
          <h1 className="section-serif-em">
            Everything you are <em>pursuing</em>
          </h1>
          <p className="lede">
            Each role with its match score, current stage, and your notes. Export
            the whole thing to a spreadsheet whenever you want it elsewhere.
          </p>

          <JobTracker initialJobs={(data ?? []) as TrackedJob[]} />

          {entitled ? null : (
            <p className="download-note">
              Your saved roles stay here, and you can still edit, export or delete
              them. Adding new ones and{' '}
              <a href="/jobs/discover">discovering openings</a> needs full access
              — <a href="/pricing">see pricing</a>.
            </p>
          )}
        </div>
      </section>
    </SiteShell>
  );
}
