import { trackEvent } from '@/lib/analytics/track';
import { env, isEmailConfigured } from '@/lib/env';
import { logSafe } from '@/lib/http';
import { rankPostings, type IndexedPosting } from '@/lib/jobs/match';
import { PROFILE_SCHEMA_VERSION, type ResumeProfile } from '@/lib/resume/schema';
import { supabaseAdmin } from '@/lib/supabase/admin';

import { button, esc, layout, para, sendEmail, textFooter } from './send';
import { unsubscribeUrl } from './unsubscribe';

// -----------------------------------------------------------------------------
// The three lifecycle emails
// -----------------------------------------------------------------------------
//
//   welcome   once, right after signup
//   reminder  daily, for tracker jobs whose follow-up date is today
//   digest    weekly (Mondays), the best-matching new openings
//
// Every send is claimed in `email_log` BEFORE it is sent, keyed by a dedupe key
// (unique index). A cron that runs twice, or two tabs racing on signup, cannot
// send the same email twice: the second insert fails and that send is skipped.
// -----------------------------------------------------------------------------

const site = () => env.siteUrl.replace(/\/$/, '');

type Kind = 'welcome' | 'reminder' | 'digest';

/** Claim a send. False when it was already claimed (already sent). */
async function claim(userId: string, kind: Kind, dedupeKey: string): Promise<boolean> {
  const { error } = await supabaseAdmin()
    .from('email_log')
    .insert({ user_id: userId, kind, dedupe_key: dedupeKey });
  return !error;
}

/** Release a claim when the provider rejected the send, so a later run retries. */
async function release(dedupeKey: string): Promise<void> {
  await supabaseAdmin().from('email_log').delete().eq('dedupe_key', dedupeKey);
}

interface Prefs {
  reminders: boolean;
  digest: boolean;
  unsubscribed: boolean;
}

async function prefsFor(userIds: string[]): Promise<Map<string, Prefs>> {
  const map = new Map<string, Prefs>();
  if (userIds.length === 0) return map;
  const { data } = await supabaseAdmin()
    .from('email_prefs')
    .select('user_id, reminders, digest, unsubscribed_at')
    .in('user_id', userIds);
  for (const row of data ?? []) {
    map.set(row.user_id as string, {
      reminders: row.reminders !== false,
      digest: row.digest !== false,
      unsubscribed: row.unsubscribed_at !== null,
    });
  }
  return map;
}

async function emailOf(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin().auth.admin.getUserById(userId);
  return data?.user?.email ?? null;
}

// --- welcome -------------------------------------------------------------------

/**
 * Send the welcome email once. Returns true only the first time it is called for
 * this user, which is also what the signup analytics event keys off.
 */
export async function sendWelcomeEmail(
  userId: string,
  email: string,
  name: string
): Promise<boolean> {
  const key = `welcome:${userId}`;
  if (!(await claim(userId, 'welcome', key))) return false;
  if (!isEmailConfigured()) return true;

  const unsub = unsubscribeUrl(userId, 'all');
  const first = name.split(/\s+/)[0] || 'there';
  const html = layout({
    preheader: 'Three things to do first, all free.',
    heading: `Welcome to Unviewable, ${first}`,
    bodyHtml:
      para('Here is the quickest way to get value from your account:') +
      para(
        '<strong>1. Check your resume.</strong> Upload it and paste a job description. You will see what the job asks for that your resume does not show.'
      ) +
      para(
        '<strong>2. Save jobs you like.</strong> Your tracker is free for up to 50 jobs. The browser extension saves a job from any site in one click.'
      ) +
      para('<strong>3. Practise an interview.</strong> One free practice session a day, with feedback on every answer.') +
      button('Check my resume', `${site()}/resume`),
    unsubscribeUrl: unsub,
    why: 'You are getting this because you just created an Unviewable account.',
  });
  const text =
    `Welcome to Unviewable, ${first}.\n\n` +
    '1. Check your resume against a job description: ' + `${site()}/resume\n` +
    '2. Save jobs to your free tracker (up to 50): ' + `${site()}/jobs\n` +
    '3. Practise an interview: ' + `${site()}/interview` +
    textFooter('You are getting this because you just created an Unviewable account.', unsub);

  const result = await sendEmail({ to: email, subject: 'Welcome to Unviewable', html, text, unsubscribeUrl: unsub });
  if (result === 'sent') await trackEvent('email_sent', userId, { kind: 'welcome' });
  return true;
}

// --- follow-up reminders ------------------------------------------------------

/** Email everyone whose tracker has jobs to follow up on today (UTC date). */
export async function sendFollowUpReminders(now: Date = new Date()): Promise<number> {
  if (!isEmailConfigured()) return 0;
  const today = now.toISOString().slice(0, 10);

  const { data, error } = await supabaseAdmin()
    .from('tracked_jobs')
    .select('user_id, company, job_title')
    .eq('follow_up_at', today)
    .in('status', ['applied', 'interviewing'])
    .limit(2000);
  if (error || !data) {
    logSafe('email_reminders_query_failed', { error: error?.message ?? 'none' });
    return 0;
  }

  const byUser = new Map<string, { company: string; job_title: string }[]>();
  for (const row of data) {
    const list = byUser.get(row.user_id as string) ?? [];
    list.push({ company: row.company as string, job_title: row.job_title as string });
    byUser.set(row.user_id as string, list);
  }
  const prefs = await prefsFor([...byUser.keys()]);

  let sent = 0;
  for (const [userId, jobs] of byUser) {
    const p = prefs.get(userId);
    if (p && (p.unsubscribed || !p.reminders)) continue;
    const key = `reminder:${userId}:${today}`;
    if (!(await claim(userId, 'reminder', key))) continue;
    const to = await emailOf(userId);
    if (!to) continue;

    const unsub = unsubscribeUrl(userId, 'reminders');
    const list = jobs
      .slice(0, 10)
      .map((j) => `<li style="margin:0 0 6px;">${esc(j.job_title)} at ${esc(j.company)}</li>`)
      .join('');
    const count = jobs.length;
    const subject = count === 1 ? `Time to follow up with ${jobs[0].company}` : `${count} applications to follow up on today`;
    const html = layout({
      preheader: 'A short, polite follow-up often gets a reply.',
      heading: subject,
      bodyHtml:
        para('You asked us to remind you today about:') +
        `<ul style="margin:0 0 16px;padding-left:20px;font-size:16px;line-height:1.5;color:#3A3A38;">${list}</ul>` +
        para('A short note to the recruiter asking about the status of your application is normal and often gets a reply.') +
        button('Open my tracker', `${site()}/jobs`),
      unsubscribeUrl: unsub,
      why: 'You set a follow-up date in your Unviewable tracker.',
    });
    const text =
      `${subject}\n\n` +
      jobs.slice(0, 10).map((j) => `- ${j.job_title} at ${j.company}`).join('\n') +
      `\n\nOpen your tracker: ${site()}/jobs` +
      textFooter('You set a follow-up date in your Unviewable tracker.', unsub);

    const result = await sendEmail({ to, subject, html, text, unsubscribeUrl: unsub });
    if (result === 'sent') {
      sent += 1;
      await trackEvent('email_sent', userId, { kind: 'reminder' });
    } else {
      await release(key);
    }
  }
  return sent;
}

// --- weekly digest -------------------------------------------------------------

/** ISO week key like 2026-W39, so the digest goes out at most once a week. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Email each user with a resume on file the five best-matching openings posted
 * in the last 7 days. Users with no matches that week get nothing: an empty
 * digest is exactly the kind of email that gets marked as spam.
 */
export async function sendWeeklyDigest(now: Date = new Date(), maxUsers = 300): Promise<number> {
  if (!isEmailConfigured()) return 0;
  const admin = supabaseAdmin();
  const week = isoWeek(now);
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const { data: postings } = await admin
    .from('job_postings')
    .select('id, title, location, is_remote, is_india, url, description, posted_at, job_companies(name)')
    .eq('is_open', true)
    .gte('posted_at', since)
    .order('posted_at', { ascending: false })
    .limit(400);
  const candidates: IndexedPosting[] = (postings ?? []).map((r) => ({
    id: r.id,
    title: r.title,
    location: r.location,
    is_remote: r.is_remote,
    is_india: r.is_india,
    url: r.url,
    description: r.description,
    posted_at: r.posted_at,
    company_name: (r.job_companies as { name?: string } | null)?.name ?? null,
  }));
  if (candidates.length === 0) return 0;

  // Latest usable profile per user, newest resumes first.
  const { data: resumes } = await admin
    .from('resumes')
    .select('user_id, profile, created_at')
    .eq('profile_schema_version', PROFILE_SCHEMA_VERSION)
    .not('profile', 'is', null)
    .gt('expires_at', now.toISOString())
    .order('created_at', { ascending: false })
    .limit(2000);
  const profiles = new Map<string, ResumeProfile>();
  for (const r of resumes ?? []) {
    if (!profiles.has(r.user_id as string)) profiles.set(r.user_id as string, r.profile as ResumeProfile);
    if (profiles.size >= maxUsers) break;
  }
  const prefs = await prefsFor([...profiles.keys()]);

  let sent = 0;
  for (const [userId, profile] of profiles) {
    const p = prefs.get(userId);
    if (p && (p.unsubscribed || !p.digest)) continue;

    const top = rankPostings(profile, candidates)
      .filter((j) => !j.unscored && j.relevance >= 20)
      .slice(0, 5);
    if (top.length === 0) continue;

    const key = `digest:${userId}:${week}`;
    if (!(await claim(userId, 'digest', key))) continue;
    const to = await emailOf(userId);
    if (!to) continue;

    const unsub = unsubscribeUrl(userId, 'digest');
    const items = top
      .map(
        (j) =>
          `<li style="margin:0 0 10px;"><a href="${esc(j.url ?? `${site()}/jobs/discover`)}" style="color:#131312;font-weight:600;">${esc(j.title)}</a><br><span style="color:#6B6A66;font-size:14px;">${esc(j.company_name ?? '')}${j.location ? ` · ${esc(j.location)}` : ''}</span></li>`
      )
      .join('');
    const subject = `${top.length} new jobs that match your resume`;
    const html = layout({
      preheader: `This week's best matches for you, from company job boards.`,
      heading: subject,
      bodyHtml:
        para('Posted in the last 7 days and ranked against your latest resume:') +
        `<ul style="margin:0 0 16px;padding-left:20px;font-size:16px;line-height:1.5;color:#3A3A38;">${items}</ul>` +
        button('See all matching jobs', `${site()}/jobs/discover`),
      unsubscribeUrl: unsub,
      why: 'You get this weekly because you have a resume on Unviewable.',
    });
    const text =
      `${subject}\n\n` +
      top.map((j) => `- ${j.title} — ${j.company_name ?? ''} ${j.url ?? ''}`).join('\n') +
      `\n\nAll matches: ${site()}/jobs/discover` +
      textFooter('You get this weekly because you have a resume on Unviewable.', unsub);

    const result = await sendEmail({ to, subject, html, text, unsubscribeUrl: unsub });
    if (result === 'sent') {
      sent += 1;
      await trackEvent('email_sent', userId, { kind: 'digest' });
    } else {
      await release(key);
    }
  }
  return sent;
}
