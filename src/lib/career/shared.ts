import { NextResponse } from 'next/server';

import { jsonError, logSafe } from '@/lib/http';
import type { AiFeature, LimitVerdict } from '@/lib/plans/limits';
import { AiExtractionError } from '@/lib/resume/ai/client';
import { extractResumeProfile } from '@/lib/resume/ai/extract-profile';
import { PROFILE_SCHEMA_VERSION, type ResumeProfile } from '@/lib/resume/schema';
import { supabaseAdmin } from '@/lib/supabase/admin';

// -----------------------------------------------------------------------------
// Shared plumbing for the LinkedIn optimiser and the mock interview
// -----------------------------------------------------------------------------

export interface CareerProfile {
  resumeId: string;
  profile: ResumeProfile;
  /** The resume's full extracted text: the source of truth for "no new facts". */
  text: string;
}

/**
 * The user's latest readable resume, with its structured profile.
 *
 * The profile is normally cached by the first resume scan. If the user uploaded
 * but never scanned, it is extracted here (one AI call) and cached the same way
 * the scan route does, so it is never paid for twice.
 */
export async function loadCareerProfile(
  userId: string
): Promise<CareerProfile | null> {
  const admin = supabaseAdmin();
  const { data: resume } = await admin
    .from('resumes')
    .select('id, extracted_text, profile, profile_schema_version')
    .eq('user_id', userId)
    .eq('extraction_status', 'extracted')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!resume || typeof resume.extracted_text !== 'string') return null;

  let profile =
    resume.profile && resume.profile_schema_version === PROFILE_SCHEMA_VERSION
      ? (resume.profile as ResumeProfile)
      : null;

  if (!profile) {
    profile = await extractResumeProfile({ userId, resumeText: resume.extracted_text });
    const { error } = await admin
      .from('resumes')
      .update({ profile, profile_schema_version: PROFILE_SCHEMA_VERSION })
      .eq('id', resume.id)
      .eq('user_id', userId);
    if (error) logSafe('career_profile_cache_failed', { user_id: userId, error: error.message });
  }

  return { resumeId: resume.id as string, profile, text: resume.extracted_text };
}

/**
 * The profile as compact plain text for a prompt: roles, bullets, projects,
 * skills, education. Capped so a long resume cannot blow the token budget.
 */
export function profileForPrompt(p: ResumeProfile, maxChars = 7000): string {
  const lines: string[] = [];
  if (p.summary) lines.push(`Summary: ${p.summary}`);
  for (const r of p.experience) {
    lines.push(`Role: ${[r.title, r.company, r.location].filter(Boolean).join(' | ')}`);
    for (const b of r.bullets) lines.push(`- ${b.text}`);
  }
  for (const pr of p.projects) {
    lines.push(`Project: ${[pr.name, pr.technologies.join(', ')].filter(Boolean).join(' | ')}`);
    if (pr.description) lines.push(`- ${pr.description}`);
    for (const b of pr.bullets) lines.push(`- ${b.text}`);
  }
  if (p.skills.length) lines.push(`Skills: ${p.skills.map((s) => s.name).join(', ')}`);
  for (const e of p.education) {
    lines.push(`Education: ${[e.degree, e.field, e.institution, e.score].filter(Boolean).join(' | ')}`);
  }
  for (const c of p.certifications) {
    if (c.name) lines.push(`Certification: ${[c.name, c.issuer].filter(Boolean).join(' | ')}`);
  }
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}

/** Record one AI call. The daily caps count these rows. */
export async function recordGeneration(
  userId: string,
  kind: 'linkedin' | 'interview_questions' | 'interview_feedback',
  output: Record<string, unknown>
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('ai_generations')
    .insert({ user_id: userId, kind, output })
    .select('id')
    .single();
  if (error) {
    logSafe('ai_generation_insert_failed', { user_id: userId, kind, error: error.message });
    return null;
  }
  return data.id as string;
}

/** 429 when today's allowance is used, in the same shape as resume quotas. */
export function limitReached(feature: AiFeature, verdict: LimitVerdict, plan: string) {
  const what = feature === 'linkedin' ? 'LinkedIn rewrite' : 'interview practice session';
  return NextResponse.json(
    {
      code: 'quota_exceeded',
      feature,
      cap: verdict.cap,
      used: verdict.used,
      plan,
      message:
        plan === 'free'
          ? `You have used today's free ${what}. Come back tomorrow, or get full access for up to 10 a day.`
          : `You have used today's ${verdict.cap} ${what}s. They reset at 05:30 IST.`,
    },
    { status: 429 }
  );
}

/** Map an AI failure to the same responses the resume scan uses. */
export function aiErrorResponse(err: unknown, logEvent: string, userId: string) {
  if (err instanceof AiExtractionError) {
    if (err.code === 'rate_limited') {
      const headers = new Headers();
      if (err.retryAfterSeconds !== null) headers.set('retry-after', String(err.retryAfterSeconds));
      return NextResponse.json(
        {
          code: 'analysis_busy',
          message: 'Our AI is busy right now. Try again in a minute.',
          retryAfterSeconds: err.retryAfterSeconds,
        },
        { status: 429, headers }
      );
    }
    if (err.code === 'not_configured') return jsonError(503, 'analysis_unavailable');
    return jsonError(502, 'upstream_unavailable', 'That did not work this time. Try again.');
  }
  logSafe(logEvent, { user_id: userId, error: err instanceof Error ? err.name : 'unknown' });
  return jsonError(500, 'internal_error');
}

/** Trim a model string to a length, on a word boundary. */
export function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+\n/g, '\n').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.7 ? cut.slice(0, lastSpace) : cut).trim();
}
