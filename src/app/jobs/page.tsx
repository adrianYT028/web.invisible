import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { SectionTabs } from '@/components/chrome/SectionTabs';
import { userHasService } from '@/lib/plans/guard';
import { checkTrackerLimit, remainingOf } from '@/lib/plans/limits';
import { readEffectivePlan } from '@/lib/plans/read-plan';
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

  // The tracker is free on every plan (migration 023), up to
  // `feature_limits.max_tracked_jobs` saved jobs on the free plan. `entitled`
  // stays as a guard in case a future plan has no tracker at all.
  const admin = supabaseAdmin();
  const [entitled, plan] = await Promise.all([
    userHasService(user.id, 'jobs'),
    readEffectivePlan(admin, user.id),
  ]);
  const limit = await checkTrackerLimit(admin, user.id, plan);
  const left = remainingOf(limit);

  const { data } = await admin
    .from('tracked_jobs')
    .select(
      'id, source, company, job_title, location, is_remote, url, status, scan_id, match_score, notes, follow_up_at, applied_at, created_at'
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(500);

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner">
          <SectionTabs section="jobs" current="/jobs" />
          <p className="eyebrow">Tracker</p>
          <h1 className="section-serif-em">
            Everything you are <em>pursuing</em>
          </h1>
          <p className="lede">
            Each role with its match score, current stage, and your notes. Export
            the whole thing to a spreadsheet whenever you want it elsewhere.
          </p>

          <JobTracker initialJobs={(data ?? []) as TrackedJob[]} />

          {entitled && left !== null ? (
            <p className="download-note">
              Free plan: {limit.used} of {limit.cap} saved jobs used.{' '}
              {left === 0
                ? 'Remove jobs you no longer need to save more, or '
                : 'For unlimited saves, '}
              <a href="/pricing">get full access</a>.
            </p>
          ) : null}
        </div>
      </section>
    </SiteShell>
  );
}
