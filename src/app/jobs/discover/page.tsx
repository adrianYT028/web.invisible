import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { ServicePaywall } from '@/components/sections/ServicePaywall';
import { userHasService } from '@/lib/plans/guard';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

import { DiscoverClient } from './DiscoverClient';

/**
 * `/jobs/discover` — browse the job index.
 *
 * The list is client-fetched, unlike `/jobs`: filters drive the query and the
 * server ranks against the profile, so the first render has nothing useful to
 * prerender.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Find roles',
  description:
    'Open roles from company job boards, ordered by how well they match your resume.',
  alternates: { canonical: '/jobs/discover' },
  robots: { index: false },
};

export default async function DiscoverPage() {
  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login?redirectedFrom=%2Fjobs%2Fdiscover');

  // Presentation only — /api/jobs/discover gates itself.
  const entitled = await userHasService(user.id, 'jobs');

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Discover</p>
          <h1 className="section-serif-em">
            Roles worth <em>your</em> time
          </h1>
          <p className="lede">
            Pulled straight from company job boards, ordered by how much of your
            resume they actually ask for. Save one to your tracker, then scan it
            against your resume for the full report.
          </p>

          {entitled ? (
            <DiscoverClient />
          ) : (
            <ServicePaywall
              service="jobs"
              blurb="Live openings pulled straight from company job boards, ranked by how much of your resume they actually ask for."
            />
          )}
        </div>
      </section>
    </SiteShell>
  );
}
