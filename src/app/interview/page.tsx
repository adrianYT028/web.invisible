import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { SectionTabs } from '@/components/chrome/SectionTabs';
import { checkAiLimit, remainingOf } from '@/lib/plans/limits';
import { readEffectivePlan } from '@/lib/plans/read-plan';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

import { InterviewPractice } from './InterviewPractice';

/**
 * `/interview` — mock interview practice on the website.
 *
 * Practice before the real thing. The desktop app, for live help during a call,
 * is linked at the bottom as the other half of the "Interview" section.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Interview practice',
  description: 'Practise interview questions for a real job, and get feedback on every answer.',
  robots: { index: false },
};

export default async function InterviewPage() {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) redirect('/login?redirectedFrom=%2Finterview');

  const admin = supabaseAdmin();
  const plan = await readEffectivePlan(admin, user.id);
  const [limit, jobs, resume] = await Promise.all([
    checkAiLimit(admin, user.id, 'interview', plan),
    admin
      .from('tracked_jobs')
      .select('id, job_title, company')
      .eq('user_id', user.id)
      .in('status', ['saved', 'applied', 'interviewing'])
      .order('updated_at', { ascending: false })
      .limit(30),
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
          <SectionTabs section="interview" current="/interview" />
          <p className="eyebrow">Interview</p>
          <h1 className="section-serif-em">
            Practise before it <em>counts</em>
          </h1>
          <p className="lede">
            Five questions for the job you want, one at a time. Answer by typing or
            speaking, and get honest feedback on each answer.
          </p>

          <InterviewPractice
            jobs={(jobs.data ?? []) as { id: string; job_title: string; company: string }[]}
            remaining={remainingOf(limit)}
            hasResume={Boolean(resume.data)}
          />

          <p className="download-note">
            Want notes on screen during the real interview? That is the{' '}
            <Link href="/download">Unviewable desktop app</Link>.
          </p>
        </div>
      </section>
    </SiteShell>
  );
}
