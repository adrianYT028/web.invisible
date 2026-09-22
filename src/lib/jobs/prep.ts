// -----------------------------------------------------------------------------
// The prep pipeline — one action, many jobs prepared
// -----------------------------------------------------------------------------
//
// For each job in a run:
//
//   1. read the cached job description from the index
//   2. extract its requirements and knockouts
//   3. score it against the user's stored profile (deterministic)
//   4. tailor the weakest resume bullets toward it, verified for fabrication
//   5. draft a cold email grounded ONLY in requirements the scan credited
//   6. surface the contact the posting itself published
//
// The user then reviews and sends. Nothing is applied for them and nothing is
// emailed by the platform.
//
// ---------------------------------------------------------------------------
// WHY IT PROCESSES ONE ITEM AT A TIME
//
// The first estimate here said two, based on a short synthetic job description
// costing ~850 tokens to extract. Real postings measured 2,787 and 2,922 — a
// 12,000-character company posting is several times the size of a test fixture.
// Two items therefore blew the per-minute allowance and the following rewrite call
// came back 429.
//
// Measured cost of one item AFTER trimming the description (./trim-jd.ts):
//   job description  ~3,300   (1,300 prompt + 2,000 budget)
//   rewrite          ~2,100
//   email            ~1,600
//   ------------------------
//   ~7,000 against an 8,000/minute ceiling
//
// So: one item per tick, and roughly one job per minute. The ceiling is also SHARED
// with the desktop app — its vision calls run 1,300-2,400 tokens each against the
// same allowance — so leaving headroom is not optional. Raising the provider tier
// is what makes this faster; the code cannot.
//
// ---------------------------------------------------------------------------
// RATE LIMITING IS A NORMAL OUTCOME, NOT AN ERROR
//
// Hitting the per-minute ceiling mid-run is expected. When it happens the item is
// returned to `queued` and the tick reports how long to wait. Failing the item
// would throw away work the user paid for because a clock rolled over.

import { type SupabaseClient } from '@supabase/supabase-js';

import { logSafe } from '@/lib/http';
import { AiExtractionError } from '@/lib/resume/ai/client';
import { extractJobDescription } from '@/lib/resume/ai/extract-jd';
import { generateRewrites } from '@/lib/resume/ai/rewrite';
import { PROFILE_SCHEMA_VERSION, type ResumeProfile } from '@/lib/resume/schema';
import { ParseGateError, scoreResumeAgainstJob } from '@/lib/resume/scoring';
import { PARSE_INTEGRITY_FLOOR } from '@/lib/resume/scoring/weights';

import { findPostingContact } from './contacts';
import { rankPostings, type IndexedPosting } from './match';
import { draftOutreachEmail } from './outreach';

/** Items processed per tick. See the note above — this is a TPM budget, not a guess. */
export const ITEMS_PER_TICK = 1;

/** Largest run a user may request. Matches the CHECK in migration 014. */
export const MAX_RUN_SIZE = 25;

/** Postings pulled before ranking, to pick the best `requested` from. */
const CANDIDATE_POOL = 300;

export interface StartRunResult {
  runId: string | null;
  itemCount: number;
  error:
    | null
    | 'no_resume'
    | 'parse_quality_too_low'
    | 'no_postings'
    | 'insufficient_quota'
    | 'internal_error';
}

/**
 * Create a run and pick the jobs for it.
 *
 * No inference happens here — the ranking is deterministic, so starting a run is
 * fast and cheap. All the model work happens in ticks.
 */
export async function startPrepRun(
  admin: SupabaseClient,
  input: { userId: string; requested: number; indiaOnly: boolean }
): Promise<StartRunResult> {
  const requested = Math.max(1, Math.min(input.requested, MAX_RUN_SIZE));

  // The most recent resume with a usable profile. An older schema version is
  // skipped rather than reinterpreted, matching the scan route.
  const { data: resume } = await admin
    .from('resumes')
    .select('id, profile, profile_schema_version, parse_integrity')
    .eq('user_id', input.userId)
    .eq('profile_schema_version', PROFILE_SCHEMA_VERSION)
    .not('profile', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!resume) return { runId: null, itemCount: 0, error: 'no_resume' };

  // The same gate the scan route applies. Preparing ten jobs against a resume we
  // could not read would produce ten confidently wrong reports.
  const parseIntegrity =
    typeof resume.parse_integrity === 'number' ? resume.parse_integrity : 0;
  if (parseIntegrity < PARSE_INTEGRITY_FLOOR) {
    return { runId: null, itemCount: 0, error: 'parse_quality_too_low' };
  }

  const profile = resume.profile as ResumeProfile;

  // Candidate postings. Only ones WITH a description: an item cannot be scored or
  // written about without the requirements, so including them would create items
  // destined to be skipped.
  let query = admin
    .from('job_postings')
    .select('id, title, location, is_remote, is_india, url, description, posted_at, job_companies(name)')
    .eq('is_open', true)
    .neq('description', '');

  if (input.indiaOnly) query = query.or('is_india.eq.true,is_remote.eq.true');

  const { data: rows, error: postingsError } = await query
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(CANDIDATE_POOL);

  if (postingsError) {
    logSafe('prep_start_postings_failed', { error: postingsError.message });
    return { runId: null, itemCount: 0, error: 'internal_error' };
  }

  const candidates: IndexedPosting[] = (rows ?? []).map((r) => {
    const company = r.job_companies as { name?: string } | null;
    return {
      id: r.id as string,
      title: r.title as string,
      location: r.location as string | null,
      is_remote: r.is_remote as boolean,
      is_india: r.is_india as boolean,
      url: r.url as string,
      description: r.description as string,
      posted_at: r.posted_at as string | null,
      company_name: company?.name ?? null,
    };
  });

  if (candidates.length === 0) {
    return { runId: null, itemCount: 0, error: 'no_postings' };
  }

  // Best matches first, so a run of five prepares the five most relevant jobs
  // rather than five arbitrary ones.
  const chosen = rankPostings(profile, candidates)
    .filter((p) => !p.unscored)
    .slice(0, requested);

  if (chosen.length === 0) {
    return { runId: null, itemCount: 0, error: 'no_postings' };
  }

  const { data: run, error: runError } = await admin
    .from('prep_runs')
    .insert({
      user_id: input.userId,
      resume_id: resume.id,
      requested: chosen.length,
      status: 'queued',
    })
    .select('id')
    .single();

  if (runError || !run) {
    logSafe('prep_start_run_failed', { error: runError?.message });
    return { runId: null, itemCount: 0, error: 'internal_error' };
  }

  const { error: itemsError } = await admin.from('prep_items').insert(
    chosen.map((p) => ({
      run_id: run.id,
      user_id: input.userId,
      posting_id: p.id,
      status: 'queued',
    }))
  );

  if (itemsError) {
    logSafe('prep_start_items_failed', { error: itemsError.message });
    return { runId: null, itemCount: 0, error: 'internal_error' };
  }

  return { runId: run.id as string, itemCount: chosen.length, error: null };
}

export interface TickResult {
  processed: number;
  remaining: number;
  runStatus: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  /** Set when the provider rate-limited us; the caller should wait this long. */
  retryAfterSeconds: number | null;
}

/**
 * Process the next few items of a run.
 *
 * Called repeatedly — by the client while the user watches, or by a schedule.
 * Idempotent: an item is claimed by moving it to `running` before any work starts,
 * so two overlapping ticks cannot prepare the same job twice.
 */
export async function tickPrepRun(
  admin: SupabaseClient,
  runId: string,
  userId: string
): Promise<TickResult> {
  const { data: run } = await admin
    .from('prep_runs')
    .select('id, resume_id, status')
    .eq('id', runId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!run) {
    return { processed: 0, remaining: 0, runStatus: 'failed', retryAfterSeconds: null };
  }
  if (run.status === 'done' || run.status === 'cancelled' || run.status === 'failed') {
    return {
      processed: 0,
      remaining: 0,
      runStatus: run.status as TickResult['runStatus'],
      retryAfterSeconds: null,
    };
  }

  const { data: resume } = await admin
    .from('resumes')
    .select('profile, parse_integrity, diagnostics')
    .eq('id', run.resume_id)
    .maybeSingle();

  if (!resume?.profile) {
    await finishRun(admin, runId, 'failed', 'resume_unavailable');
    return { processed: 0, remaining: 0, runStatus: 'failed', retryAfterSeconds: null };
  }

  const profile = resume.profile as ResumeProfile;
  const parseIntegrity =
    typeof resume.parse_integrity === 'number' ? resume.parse_integrity : 0;

  await admin.from('prep_runs').update({ status: 'running' }).eq('id', runId);

  const { data: queued } = await admin
    .from('prep_items')
    .select('id, posting_id')
    .eq('run_id', runId)
    .eq('status', 'queued')
    .order('created_at', { ascending: true })
    .limit(ITEMS_PER_TICK);

  let processed = 0;
  let retryAfterSeconds: number | null = null;

  for (const item of queued ?? []) {
    // Claim it before doing any work, so an overlapping tick skips it.
    const { data: claimed } = await admin
      .from('prep_items')
      .update({ status: 'running' })
      .eq('id', item.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle();
    if (!claimed) continue;

    const outcome = await prepareItem(admin, {
      itemId: item.id as string,
      postingId: item.posting_id as string,
      userId,
      resumeId: run.resume_id as string,
      profile,
      parseIntegrity,
    });

    if (outcome === 'rate_limited') {
      // The per-minute window is 60s; 35 is long enough to clear a partial window
      // without idling a full minute when the reset is imminent.
      retryAfterSeconds = 35;
      break;
    }
    processed++;
  }

  const { count: stillQueued } = await admin
    .from('prep_items')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .in('status', ['queued', 'running']);

  const remaining = stillQueued ?? 0;
  if (remaining === 0) {
    await finishRun(admin, runId, 'done', null);
    return { processed, remaining: 0, runStatus: 'done', retryAfterSeconds };
  }

  return { processed, remaining, runStatus: 'running', retryAfterSeconds };
}

type ItemOutcome = 'done' | 'skipped' | 'failed' | 'rate_limited';

/** Prepare one job end to end. */
async function prepareItem(
  admin: SupabaseClient,
  input: {
    itemId: string;
    postingId: string;
    userId: string;
    /**
     * Passed down rather than re-queried per item. `resume_scans.resume_id` is NOT
     * NULL, so deriving it with a lookup that can miss would fail the insert on a
     * transient error — and it is already known by the caller.
     */
    resumeId: string;
    profile: ResumeProfile;
    parseIntegrity: number;
  }
): Promise<ItemOutcome> {
  const { data: posting } = await admin
    .from('job_postings')
    .select('id, title, description, job_companies(name)')
    .eq('id', input.postingId)
    .maybeSingle();

  if (!posting || !(posting.description as string)?.trim()) {
    await admin
      .from('prep_items')
      .update({
        status: 'skipped',
        error: 'no_description',
        completed_at: new Date().toISOString(),
      })
      .eq('id', input.itemId);
    return 'skipped';
  }

  const company = (posting.job_companies as { name?: string } | null)?.name ?? null;
  const jdText = posting.description as string;

  try {
    const jd = await extractJobDescription({ userId: input.userId, jdText });

    const result = scoreResumeAgainstJob({
      profile: input.profile,
      jd,
      parse: {
        parseIntegrity: input.parseIntegrity,
        scannable: true,
        warnings: [],
      },
    });

    // Rewrite and email are enhancements: if either fails, the item still keeps
    // its match report rather than being thrown away.
    try {
      const { rewrites } = await generateRewrites({
        userId: input.userId,
        profile: input.profile,
        jd,
        report: result.report,
      });
      result.report.rewrite = rewrites;
    } catch (err) {
      if (isRateLimit(err)) throw err;
      logSafe('prep_item_rewrite_failed', { item: input.itemId });
    }

    const contact = findPostingContact({ description: jdText, companyName: company });

    let subject: string | null = null;
    let body: string | null = null;
    try {
      const draft = await draftOutreachEmail({
        userId: input.userId,
        profile: input.profile,
        report: result.report,
        jobTitle: posting.title as string,
        company: company ?? 'the company',
        recipientName: contact.name,
      });
      subject = draft?.subject ?? null;
      body = draft?.body ?? null;
    } catch (err) {
      if (isRateLimit(err)) throw err;
      logSafe('prep_item_email_failed', { item: input.itemId });
    }

    // Persist the scan so the item links to a real report, exactly like a manual
    // scan at /resume.
    const jdHash = await sha256(`${input.postingId}:${jdText.slice(0, 4000)}`);
    const { data: scan } = await admin
      .from('resume_scans')
      .upsert(
        {
          user_id: input.userId,
          resume_id: input.resumeId,
          jd_text: jdText.slice(0, 20_000),
          jd_hash: jdHash,
          jd_job_title: jd.jobTitle,
          jd_company: jd.company ?? company,
          parse_integrity: result.subScores.parseIntegrity,
          requirement_coverage: result.subScores.requirementCoverage,
          keyword_alignment: result.subScores.keywordAlignment,
          evidence_quality: result.subScores.evidenceQuality,
          knockout_risk: result.subScores.knockoutRisk,
          overall_score: result.overallScore,
          weights_version: result.weightsVersion,
          report: result.report,
        },
        { onConflict: 'resume_id,jd_hash' }
      )
      .select('id')
      .single();

    await admin
      .from('prep_items')
      .update({
        status: 'done',
        error: null,
        scan_id: scan?.id ?? null,
        match_score: scan?.id ? result.overallScore : null,
        email_subject: subject,
        email_body: body,
        contact_hint: contact.email ?? contact.guidance,
        completed_at: new Date().toISOString(),
      })
      .eq('id', input.itemId);

    return 'done';
  } catch (err) {
    if (isRateLimit(err)) {
      // Back to the queue — this is a clock problem, not a data problem.
      await admin
        .from('prep_items')
        .update({ status: 'queued' })
        .eq('id', input.itemId);
      return 'rate_limited';
    }

    const code =
      err instanceof ParseGateError
        ? 'parse_quality_too_low'
        : err instanceof AiExtractionError
          ? err.code
          : 'internal_error';

    await admin
      .from('prep_items')
      .update({
        status: 'failed',
        error: code,
        completed_at: new Date().toISOString(),
      })
      .eq('id', input.itemId);

    logSafe('prep_item_failed', { item: input.itemId, code });
    return 'failed';
  }
}

function isRateLimit(err: unknown): boolean {
  return err instanceof AiExtractionError && err.code === 'rate_limited';
}

async function finishRun(
  admin: SupabaseClient,
  runId: string,
  status: 'done' | 'failed',
  error: string | null
): Promise<void> {
  await admin
    .from('prep_runs')
    .update({ status, error, finished_at: new Date().toISOString() })
    .eq('id', runId);
}

/** sha256 hex, used for the scan idempotency key. */
async function sha256(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}
