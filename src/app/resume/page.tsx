import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import {
  FULL_ACCESS_PRICE,
  formatPriceDisclosure,
} from '@/lib/payments/pricing';
import { isBundlePlan } from '@/lib/plans/services';
import { checkResumeQuota, readPlan } from '@/lib/resume/quota';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

import { ResumeAnalyser } from './ResumeAnalyser';

/**
 * `/resume` — the resume analyser.
 *
 * NOT behind an access paywall, deliberately. `free` gets one upload and one scan
 * per day (seeded in migration 011), which is enough to see a real parse verdict
 * and a real match report against one job. The limit is VOLUME, not a blurred
 * result: hiding the output would remove the only thing that demonstrates the
 * product is worth paying for, and a paywalled preview of a score nobody can read
 * converts far worse than one honest complete answer.
 *
 * So the gate is quota plus an upsell, and this page renders the caller's
 * remaining allowance up front rather than letting them hit a 429 after doing the
 * work of pasting a job description.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Resume Analyser',
  description:
    'Check whether your resume actually parses, and see which of a job’s requirements it evidences.',
  alternates: { canonical: '/resume' },
};

export default async function ResumePage() {
  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Same redirect contract as /account — `%2F` is the encoded leading slash so
    // LoginClient reads the original path back unchanged.
    redirect('/login?redirectedFrom=%2Fresume');
  }

  const admin = supabaseAdmin();
  const plan = await readPlan(admin, user.id);
  const [uploadQuota, scanQuota] = await Promise.all([
    checkResumeQuota(admin, user.id, 'upload', plan),
    checkResumeQuota(admin, user.id, 'scan', plan),
  ]);

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Resume</p>
          {/* `.section-serif-em` styles a descendant `em`, so the class belongs
              on the heading rather than on the emphasised word itself. */}
          <h1 className="section-serif-em">
            Does your resume <em>survive</em> being read?
          </h1>
          <p className="lede">
            Most resume tools grade your wording. This one first checks whether a
            parser can read your file at all — then shows, requirement by
            requirement, what the job asks for and what your resume actually
            evidences.
          </p>

          <ResumeAnalyser
            plan={plan}
            uploadsLeft={remaining(uploadQuota.cap, uploadQuota.used)}
            scansLeft={remaining(scanQuota.cap, scanQuota.used)}
            upgradePrice={formatPriceDisclosure(FULL_ACCESS_PRICE)}
          />

          {/* The price was previously rendered inside the analyser as plain text
              with nothing to click, so a user who wanted more scans had no route
              to buy them. */}
          {isBundlePlan(plan) ? null : (
            <p className="download-note">
              The free tier is one upload and one scan a day. Full access lifts
              that and adds job openings and auto-apply —{' '}
              <a href="/pricing">see pricing</a>.
            </p>
          )}
        </div>
      </section>
    </SiteShell>
  );
}

/** null means unlimited, matching the `feature_limits` convention. */
function remaining(cap: number | null, used: number): number | null {
  if (cap === null) return null;
  return Math.max(cap - used, 0);
}
