import { supabaseAdmin } from '@/lib/supabase/admin';

// -----------------------------------------------------------------------------
// trackEvent — first-party product analytics
// -----------------------------------------------------------------------------
//
// Writes one row to `funnel_events` (migration 023) so we can answer the basic
// questions: how many people sign up, scan a resume, save a job, use the
// extension, and pay. Query it with `node scripts/funnel-report.mjs`.
//
// Rules:
//   - NEVER throws and never blocks the request it is called from. Analytics
//     must not be able to break a product action.
//   - Props are for counts and splits only (source, plan, reused). Never put
//     resume text, job text, emails or anything personal in them.
//   - Event names are a closed list, so the report and the database agree.
// -----------------------------------------------------------------------------

export const FUNNEL_EVENTS = [
  'signup',
  'resume_uploaded',
  'resume_scanned',
  'resume_exported',
  'job_saved',
  'ats_check_public',
  'linkedin_generated',
  'interview_started',
  'interview_answer_scored',
  'extension_connected',
  'checkout_started',
  'payment_captured',
  'email_sent',
] as const;

export type FunnelEvent = (typeof FUNNEL_EVENTS)[number];

type Props = Record<string, string | number | boolean | null>;

export async function trackEvent(
  event: FunnelEvent,
  userId: string | null,
  props: Props = {}
): Promise<void> {
  try {
    await supabaseAdmin()
      .from('funnel_events')
      .insert({ event, user_id: userId, props });
  } catch {
    // Swallowed on purpose; see the rules above.
  }
}
