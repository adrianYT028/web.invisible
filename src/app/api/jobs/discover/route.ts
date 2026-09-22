import { NextResponse } from 'next/server';

import { jsonError, logSafe } from '@/lib/http';
import { looksEarlyCareer, rankPostings, type IndexedPosting } from '@/lib/jobs/match';
import { PROFILE_SCHEMA_VERSION, type ResumeProfile } from '@/lib/resume/schema';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { requireService } from '@/lib/plans/guard';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// GET /api/jobs/discover — open roles, ranked against the caller's profile
//
//   ?india=1        India-based roles only
//   ?remote=1       include remote regardless of location
//   ?early=1        early-career titles only
//
// Ranking is deterministic and model-free (src/lib/jobs/match.ts). It orders the
// list; it is NOT the Match Score, and the response calls the field `relevance`
// precisely so the UI cannot accidentally present it as one.
// -----------------------------------------------------------------------------

/** Postings pulled before ranking. Ranking is in-process, so this bounds memory. */
const CANDIDATE_LIMIT = 400;
/** Returned to the client. */
const PAGE = 60;

export async function GET(request: Request) {
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  // Entitlement gate (job discovery). Gating the API and not only the page is
  // the point: a page check alone is bypassed by calling this endpoint
  // directly.
  const gate = await requireService(user.id, 'jobs');
  if (gate) return gate;

  const params = new URL(request.url).searchParams;
  const indiaOnly = params.get('india') === '1';
  const includeRemote = params.get('remote') === '1';
  const earlyOnly = params.get('early') === '1';

  const admin = supabaseAdmin();

  // The caller's most recent usable profile. Older schema versions are skipped
  // rather than reinterpreted — the same rule the scan route applies.
  const { data: resume } = await admin
    .from('resumes')
    .select('profile, profile_schema_version')
    .eq('user_id', user.id)
    .eq('profile_schema_version', PROFILE_SCHEMA_VERSION)
    .not('profile', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const profile = (resume?.profile ?? null) as ResumeProfile | null;

  let query = admin
    .from('job_postings')
    .select(
      'id, title, location, is_remote, is_india, url, description, posted_at, job_companies(name)'
    )
    .eq('is_open', true);

  // India-only still includes remote roles when asked, because a remote role is
  // open to a candidate in India even though its location string is not.
  if (indiaOnly) {
    query = includeRemote
      ? query.or('is_india.eq.true,is_remote.eq.true')
      : query.eq('is_india', true);
  }

  const { data, error } = await query
    .order('posted_at', { ascending: false, nullsFirst: false })
    .limit(CANDIDATE_LIMIT);

  if (error) {
    logSafe('jobs_discover_failed', { user_id: user.id, error: error.message });
    return jsonError(500, 'internal_error');
  }

  const rows = (data ?? []).map((r) => {
    const company = r.job_companies as { name?: string } | null;
    return {
      id: r.id,
      title: r.title,
      location: r.location,
      is_remote: r.is_remote,
      is_india: r.is_india,
      url: r.url,
      description: r.description,
      posted_at: r.posted_at,
      company_name: company?.name ?? null,
    } satisfies IndexedPosting;
  });

  const filtered = earlyOnly ? rows.filter((r) => looksEarlyCareer(r.title)) : rows;

  // With no profile there is nothing to rank against, so the list stays in
  // recency order rather than being scored zero across the board.
  const ranked = profile ? rankPostings(profile, filtered) : filtered.map(flat);

  return NextResponse.json({
    // Tells the UI to prompt for a resume upload instead of showing a list of
    // zeroes and implying every role is a poor fit.
    hasProfile: profile !== null,
    total: filtered.length,
    jobs: ranked.slice(0, PAGE).map((j) => ({
      id: j.id,
      title: j.title,
      company: j.company_name,
      location: j.location,
      isRemote: j.is_remote,
      isIndia: j.is_india,
      url: j.url,
      postedAt: j.posted_at,
      // Description is NOT returned: it is up to 12,000 characters per posting and
      // the client only needs it when the user runs a real scan.
      relevance: 'relevance' in j ? j.relevance : null,
      matchedSkills: 'matchedSkills' in j ? j.matchedSkills : [],
      unscored: 'unscored' in j ? j.unscored : true,
      earlyCareer: looksEarlyCareer(j.title),
    })),
  });
}

/** Shape an unranked posting like a ranked one, without inventing a score. */
function flat(p: IndexedPosting) {
  return { ...p, relevance: null as number | null, matchedSkills: [] as string[], unscored: true };
}
