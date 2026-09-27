import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { SectionTabs } from '@/components/chrome/SectionTabs';
import { checkAiLimit, remainingOf } from '@/lib/plans/limits';
import { readEffectivePlan } from '@/lib/plans/read-plan';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

import { LinkedInOptimiser } from './LinkedInOptimiser';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'LinkedIn profile writer',
  description: 'A LinkedIn headline and About section written from your resume, with nothing made up.',
  robots: { index: false },
};

export default async function LinkedInPage() {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect('/login?redirectedFrom=%2Flinkedin');

  const admin = supabaseAdmin();
  const plan = await readEffectivePlan(admin, user.id);
  const [limit, latest, resume] = await Promise.all([
    checkAiLimit(admin, user.id, 'linkedin', plan),
    admin
      .from('ai_generations')
      .select('output')
      .eq('user_id', user.id)
      .eq('kind', 'linkedin')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from('resumes')
      .select('id')
      .eq('user_id', user.id)
      .eq('extraction_status', 'extracted')
      .gt('expires_at', new Date().toISOString())
      .limit(1)
      .maybeSingle(),
  ]);

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner">
          <SectionTabs section="resume" current="/linkedin" />
          <p className="eyebrow">Resume · LinkedIn</p>
          <h1 className="section-serif-em">
            A LinkedIn profile that <em>matches</em> your resume
          </h1>
          <p className="lede">
            Recruiters look you up after reading your resume. We write your
            headline and About section from what your resume already says, ready
            to copy and paste.
          </p>
          <LinkedInOptimiser
            initialDraft={(latest.data?.output as never) ?? null}
            initialRemaining={remainingOf(limit)}
            hasResume={Boolean(resume.data)}
          />
        </div>
      </section>
    </SiteShell>
  );
}
