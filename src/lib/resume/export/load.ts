import { PROFILE_SCHEMA_VERSION, type MatchReport, type ResumeProfile } from '@/lib/resume/schema';
import { supabaseAdmin } from '@/lib/supabase/admin';

import { buildTailoredResume, type ResumeDoc } from './document';

/**
 * Load one of the caller's scans and build its tailored resume.
 *
 * Returns null when the scan does not exist, is not the caller's, or its resume
 * has expired (90-day retention) or has no usable profile. Scoped by user_id on
 * both reads: the service-role client bypasses RLS, so those filters are the
 * access control.
 */
export async function loadTailoredResume(
  userId: string,
  scanId: string
): Promise<{ doc: ResumeDoc; company: string | null } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(scanId)) return null;
  const admin = supabaseAdmin();

  const { data: scan } = await admin
    .from('resume_scans')
    .select('id, resume_id, report, jd_company')
    .eq('id', scanId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!scan) return null;

  const { data: resume } = await admin
    .from('resumes')
    .select('profile, profile_schema_version')
    .eq('id', scan.resume_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!resume?.profile || resume.profile_schema_version !== PROFILE_SCHEMA_VERSION) return null;

  const report = (scan.report ?? {}) as Partial<MatchReport>;
  const doc = buildTailoredResume(resume.profile as ResumeProfile, report.rewrite ?? []);
  return { doc, company: (scan.jd_company as string | null) ?? null };
}
