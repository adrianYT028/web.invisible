import { NextResponse } from 'next/server';

import { requireCronSecret } from '@/lib/cron/auth';
import { sendFollowUpReminders, sendWeeklyDigest } from '@/lib/email/lifecycle';
import { logSafe } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

// -----------------------------------------------------------------------------
// GET /api/cron/emails — daily lifecycle emails (Vercel Cron, see vercel.json)
//
// Every day: follow-up reminders for tracker jobs due today.
// Mondays (UTC): the weekly matching-jobs digest.
//
// Authenticated with CRON_SECRET like the other cron routes. Safe to re-run:
// each send is claimed in `email_log` first, so a retry sends nothing twice.
// With email not configured it does nothing and says so.
// -----------------------------------------------------------------------------

export async function GET(request: Request) {
  const denied = requireCronSecret(request, 'cron_emails');
  if (denied) return denied;

  const now = new Date();
  const reminders = await sendFollowUpReminders(now);
  const digest = now.getUTCDay() === 1 ? await sendWeeklyDigest(now) : 0;

  // Housekeeping that rides on the daily run: AI outputs (LinkedIn drafts,
  // interview sessions) are kept 30 days (migration 023), then deleted.
  await supabaseAdmin().from('ai_generations').delete().lt('expires_at', now.toISOString());

  logSafe('cron_emails_done', { reminders, digest });
  return NextResponse.json({ ok: true, reminders, digest });
}
