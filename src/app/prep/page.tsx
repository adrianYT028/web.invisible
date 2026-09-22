import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { ServicePaywall } from '@/components/sections/ServicePaywall';
import { userHasService } from '@/lib/plans/guard';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

import { PrepFlow } from './PrepFlow';

/**
 * `/prep` — the whole application loop in one action.
 *
 * Replaces: find a job, read the JD, guess the fit, rewrite the resume, hunt for
 * someone to email. That loop is where a student's hours go, and every piece of it
 * already exists here separately — this page is the part that chains them.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Prepare applications',
  description:
    'Find matching roles, tailor your resume to each, and get a ready-to-send email — in one pass.',
  alternates: { canonical: '/prep' },
  robots: { index: false },
};

export default async function PrepPage() {
  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login?redirectedFrom=%2Fprep');

  // Presentation only — /api/prep and /api/prep/[id] gate themselves, so this
  // cannot be bypassed by skipping the page.
  const entitled = await userHasService(user.id, 'outreach');

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Prepare</p>
          <h1 className="section-serif-em">
            Stop doing this <em>one job at a time</em>
          </h1>
          <p className="lede">
            Pick a number. We find the roles that match your resume, score each one,
            tailor your bullets toward it, and write the email. You read, then send.
          </p>

          {entitled ? (
            <PrepFlow />
          ) : (
            <ServicePaywall
              service="outreach"
              blurb="Prepare a batch of applications in one action: each job scored against your resume, your bullets tailored toward it, a cold email drafted, and the contact found where the posting publishes one."
            />
          )}
        </div>
      </section>
    </SiteShell>
  );
}
