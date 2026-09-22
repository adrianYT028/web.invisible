import { createHash } from 'node:crypto';

import { NextResponse } from 'next/server';

import { jsonError, logSafe } from '@/lib/http';
import { AiExtractionError } from '@/lib/resume/ai/client';
import { extractJobDescription } from '@/lib/resume/ai/extract-jd';
import { extractResumeProfile } from '@/lib/resume/ai/extract-profile';
import { generateRewrites } from '@/lib/resume/ai/rewrite';
import { warningsFromDiagnostics } from '@/lib/resume/parse-quality';
import { checkResumeQuota, readPlan } from '@/lib/resume/quota';
import {
  PROFILE_SCHEMA_VERSION,
  type ParseDiagnostics,
  type ResumeProfile,
} from '@/lib/resume/schema';
import { ParseGateError, scoreResumeAgainstJob } from '@/lib/resume/scoring';
import { PARSE_INTEGRITY_FLOOR } from '@/lib/resume/scoring/weights';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/**
 * Two sequential model calls plus scoring. Comfortably inside this, but the
 * default 15s would be tight if the provider is slow.
 */
export const maxDuration = 60;

// -----------------------------------------------------------------------------
// POST /api/resume/scan — score one resume against one job description
// -----------------------------------------------------------------------------
//
// Body: { resumeId: string, jdText: string }
//
// Order of operations, and why it is this order:
//
//   1. Auth
//   2. Load the resume row (scoped to the caller — never trust a client-supplied id)
//   3. PARSE GATE, from the STORED integrity score. Checked before quota and
//      before any inference: an unreadable document can never produce a valid
//      scan, so it must not consume either.
//   4. Idempotency on (resume_id, jd_hash) — a repeat scan returns the stored
//      report and spends nothing
//   5. Quota
//   6. Extraction: profile (cached on the resume row) then job description,
//      SEQUENTIALLY
//   7. Deterministic scoring
//   8. Persist
//
// The profile is cached on `resumes.profile`. Scanning one resume against eight
// jobs therefore extracts the profile once and the job description eight times,
// which roughly halves the token cost of a realistic session. That caching is why
// the profile column exists.

/** Enough to hold a long posting; anything larger is a paste accident. */
const MAX_JD_CHARS = 20_000;
const MIN_JD_CHARS = 80;

export async function POST(request: Request) {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  const body = (await request.json().catch(() => null)) as
    | { resumeId?: unknown; jdText?: unknown }
    | null;

  const resumeId = typeof body?.resumeId === 'string' ? body.resumeId : '';
  const jdRaw = typeof body?.jdText === 'string' ? body.jdText : '';
  const jdText = jdRaw.trim().slice(0, MAX_JD_CHARS);

  if (resumeId.length === 0) return jsonError(400, 'invalid_input');
  if (jdText.length < MIN_JD_CHARS) {
    return jsonError(
      400,
      'invalid_input',
      'Paste the full job description — at least a few lines of requirements.'
    );
  }

  const admin = supabaseAdmin();

  // --- load the resume, scoped to the caller --------------------------------
  const { data: resume, error: resumeError } = await admin
    .from('resumes')
    .select(
      'id, extracted_text, parse_integrity, diagnostics, extraction_status, profile, profile_schema_version'
    )
    .eq('id', resumeId)
    // Belt and braces alongside RLS: the service-role client bypasses RLS, so the
    // ownership filter here is the actual protection against scanning someone
    // else's resume by guessing an id.
    .eq('user_id', user.id)
    .maybeSingle();

  if (resumeError || !resume) return jsonError(404, 'resume_not_found');
  if (
    resume.extraction_status !== 'extracted' ||
    typeof resume.extracted_text !== 'string'
  ) {
    return jsonError(422, 'document_unreadable');
  }

  // --- parse gate, before quota and before inference ------------------------
  const parseIntegrity =
    typeof resume.parse_integrity === 'number' ? resume.parse_integrity : 0;
  if (parseIntegrity < PARSE_INTEGRITY_FLOOR) {
    return NextResponse.json(
      {
        code: 'parse_quality_too_low',
        message:
          'We could not read this resume well enough to score it. Fix the file problems listed first — scoring it as-is would grade text you never wrote.',
        parseIntegrity,
        floor: PARSE_INTEGRITY_FLOOR,
        diagnostics: resume.diagnostics,
      },
      { status: 422 }
    );
  }

  // --- idempotency ----------------------------------------------------------
  // Normalised before hashing so trailing whitespace or a re-paste does not read
  // as a different job and charge for a second scan.
  const jdHash = createHash('sha256')
    .update(jdText.replace(/\s+/g, ' ').toLowerCase())
    .digest('hex');

  const { data: cached } = await admin
    .from('resume_scans')
    .select(
      'id, overall_score, parse_integrity, requirement_coverage, keyword_alignment, evidence_quality, knockout_risk, report, created_at, jd_job_title, jd_company'
    )
    .eq('resume_id', resumeId)
    .eq('jd_hash', jdHash)
    .maybeSingle();

  if (cached) {
    return NextResponse.json({ ...serialiseScan(cached), reused: true });
  }

  // --- quota ----------------------------------------------------------------
  const plan = await readPlan(admin, user.id);
  const quota = await checkResumeQuota(admin, user.id, 'scan', plan);
  if (!quota.allowed) {
    return NextResponse.json(
      {
        code: 'quota_exceeded',
        action: 'scan',
        cap: quota.cap,
        used: quota.used,
        plan: quota.plan,
      },
      { status: 429 }
    );
  }

  // --- extraction -----------------------------------------------------------
  try {
    // The profile is cached on the resume row, so scanning the same resume against
    // another job costs only the job-description extraction.
    let profile = reuseProfile(resume);
    if (!profile) {
      profile = await extractResumeProfile({
        userId: user.id,
        resumeText: resume.extracted_text,
      });
      const { error: profileError } = await admin
        .from('resumes')
        .update({
          profile,
          profile_schema_version: PROFILE_SCHEMA_VERSION,
        })
        .eq('id', resumeId)
        .eq('user_id', user.id);
      if (profileError) {
        // Not fatal: the scan can proceed on the in-memory profile. The only cost
        // of a failed cache write is re-extracting on the next scan.
        logSafe('resume_scan_profile_cache_failed', {
          user_id: user.id,
          error: profileError.message,
        });
      }
    }

    // SEQUENTIAL, not concurrent. The provider charges
    // prompt + max_completion_tokens against a per-minute allowance up front, so
    // issuing both calls at once roughly doubles peak usage against a measured
    // 8000 TPM ceiling and is what pushes a second concurrent user into a 413.
    const jd = await extractJobDescription({ userId: user.id, jdText });

    // --- scoring (deterministic) -------------------------------------------
    const result = scoreResumeAgainstJob({
      profile,
      jd,
      parse: {
        // `parse_integrity` and the diagnostics were persisted at upload time
        // precisely so a scan never has to re-read the file. Scoring needs only
        // these three fields — see ParseState.
        parseIntegrity,
        scannable: true,
        // Rebuilt from the stored diagnostics rather than passed as `[]`.
        //
        // This was empty, which quietly broke a promise the schema makes: a stored
        // scan is supposed to stay self-contained after the 90-day retention window
        // deletes the resume it came from. `report.parseWarnings` was that
        // guarantee, and it was always an empty array — so a report opened later
        // showed the parse score with no record of what the parse problems were.
        warnings: warningsFromDiagnostics(
          resume.diagnostics as ParseDiagnostics
        ),
      },
    });

    // --- tailored rewrite ---------------------------------------------------
    //
    // Runs after scoring, because scoring is what identifies which bullets are
    // weak and which requirements went unevidenced. Every suggestion is verified
    // against the source bullet and dropped if it introduces a fact the resume
    // did not already claim.
    //
    // Failure here must NOT fail the scan. The report is what the user paid for;
    // rewrites are an enhancement, so a rewrite problem degrades to "no
    // suggestions" rather than losing the whole result.
    try {
      const { rewrites } = await generateRewrites({
        userId: user.id,
        profile,
        jd,
        report: result.report,
      });
      result.report.rewrite = rewrites;
    } catch (err) {
      logSafe('resume_rewrite_failed', {
        user_id: user.id,
        error: err instanceof Error ? err.name : 'unknown',
        code: (err as { code?: string })?.code ?? null,
      });
    }

    // --- persist ------------------------------------------------------------
    const { data: inserted, error: insertError } = await admin
      .from('resume_scans')
      .upsert(
        {
          user_id: user.id,
          resume_id: resumeId,
          jd_text: jdText,
          jd_hash: jdHash,
          jd_job_title: jd.jobTitle,
          jd_company: jd.company,
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
      .select(
        'id, overall_score, parse_integrity, requirement_coverage, keyword_alignment, evidence_quality, knockout_risk, report, created_at, jd_job_title, jd_company'
      )
      .single();

    if (insertError || !inserted) {
      logSafe('resume_scan_insert_failed', {
        user_id: user.id,
        error: insertError?.message,
      });
      return jsonError(500, 'internal_error');
    }

    logSafe('resume_scanned', {
      user_id: user.id,
      plan,
      overall_score: result.overallScore,
      requirements: jd.requirements.length,
      knockouts: result.report.knockouts.length,
    });

    return NextResponse.json({ ...serialiseScan(inserted), reused: false });
  } catch (err) {
    if (err instanceof ParseGateError) {
      // Defence in depth — the gate above should already have caught this.
      return NextResponse.json(
        {
          code: 'parse_quality_too_low',
          parseIntegrity: err.parseIntegrity,
          floor: PARSE_INTEGRITY_FLOOR,
          warnings: err.warnings,
        },
        { status: 422 }
      );
    }

    if (err instanceof AiExtractionError) {
      // Rate limiting is transient and retryable, and on the measured provider
      // allowance it is the failure real concurrent users hit first. It gets its
      // own status and a Retry-After so the UI can say "busy" rather than "broken".
      if (err.code === 'rate_limited') {
        const headers = new Headers();
        if (err.retryAfterSeconds !== null) {
          headers.set('retry-after', String(err.retryAfterSeconds));
        }
        return NextResponse.json(
          {
            code: 'analysis_busy',
            message: err.message,
            retryAfterSeconds: err.retryAfterSeconds,
          },
          { status: 429, headers }
        );
      }
      if (err.code === 'not_configured') {
        return jsonError(503, 'analysis_unavailable');
      }
      if (err.code === 'truncated') {
        return jsonError(
          422,
          'document_unreadable',
          'This resume or job description was too long to analyse in one pass. Try a shorter version.'
        );
      }
      return jsonError(502, 'upstream_unavailable', err.message);
    }

    logSafe('resume_scan_failed', {
      user_id: user.id,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return jsonError(500, 'internal_error');
  }
}

/**
 * Reuse a cached profile only when it was produced by the CURRENT schema version.
 *
 * A profile stored under an older shape would be silently misread — fields renamed
 * or given new meaning — and produce a plausible but wrong score. Re-extracting is
 * cheap; scoring a misinterpreted profile is not recoverable.
 */
function reuseProfile(row: {
  profile: unknown;
  profile_schema_version: unknown;
}): ResumeProfile | null {
  if (row.profile === null || typeof row.profile !== 'object') return null;
  if (row.profile_schema_version !== PROFILE_SCHEMA_VERSION) return null;
  return row.profile as ResumeProfile;
}

/** Shape the client renders. Mirrors the stored columns rather than the engine. */
function serialiseScan(row: Record<string, unknown>) {
  return {
    scanId: row.id,
    // Surfaced so the client can add this posting to the tracker with its match
    // score attached, without re-deriving the company and role from the pasted text.
    jobTitle: row.jd_job_title ?? null,
    company: row.jd_company ?? null,
    overallScore: row.overall_score,
    subScores: {
      parseIntegrity: row.parse_integrity,
      requirementCoverage: row.requirement_coverage,
      keywordAlignment: row.keyword_alignment,
      evidenceQuality: row.evidence_quality,
      knockoutRisk: row.knockout_risk,
    },
    report: row.report,
    createdAt: row.created_at,
  };
}
