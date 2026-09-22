// -----------------------------------------------------------------------------
// Ranking the job index against a stored profile
// -----------------------------------------------------------------------------
//
// This is a CHEAP PRE-FILTER, not a scan. It exists to order a few hundred
// postings so the good ones are on the first screen; the real answer for any one
// posting is the full scan at /resume, which extracts requirements and knockouts
// and costs inference.
//
// So this deliberately uses NO model calls at all. Two reasons:
//
//   COST. Ranking 300 postings through a model on every page load would cost more
//   than every other feature combined, and the token allowance is 8000/minute for
//   the entire platform.
//
//   IT WOULD BE THE WRONG TOOL. Ordering a list needs a comparable number, not a
//   judgement. The deterministic keyword machinery already built for scoring gives
//   exactly that, and reusing it means the pre-filter and the full scan cannot
//   disagree about whether the user knows Python.
//
// The honest framing in the UI is "roles worth looking at", not a score. A number
// here would look like the Match Score and would not survive comparison with it,
// because it reads only a description rather than extracted requirements.

import { normaliseTerm, type ResumeProfile } from '@/lib/resume/schema';
import { mentionsTerm } from '@/lib/resume/scoring/synonyms';

export interface IndexedPosting {
  id: string;
  title: string;
  location: string | null;
  is_remote: boolean;
  is_india: boolean;
  url: string;
  description: string;
  posted_at: string | null;
  company_name?: string | null;
}

export interface RankedPosting extends IndexedPosting {
  /** Skills from the profile that this posting mentions. */
  matchedSkills: string[];
  /** 0-100, for ORDERING only. Never presented as the Match Score. */
  relevance: number;
  /** True when the posting has no description to match against (Ashby). */
  unscored: boolean;
}

/**
 * Weight of a title hit relative to a description hit.
 *
 * A skill in the job TITLE is far stronger evidence of what the role actually is
 * than the same word buried in a benefits paragraph. Recruiters search on titles
 * for the same reason.
 */
const TITLE_WEIGHT = 3;

/** Maximum distinct profile skills that can contribute, to stop long lists dominating. */
const MAX_CONTRIBUTING_SKILLS = 12;

/**
 * Rank postings by overlap with the profile.
 *
 * Postings with no description (Ashby) are marked `unscored` and sorted last
 * rather than scored zero — zero would read as "bad match" when the truth is "we
 * have nothing to compare".
 */
export function rankPostings(
  profile: ResumeProfile,
  postings: readonly IndexedPosting[]
): RankedPosting[] {
  const skills = profileSkills(profile);

  const ranked = postings.map((posting): RankedPosting => {
    if (posting.description.trim().length === 0) {
      return { ...posting, matchedSkills: [], relevance: 0, unscored: true };
    }

    const title = normaliseText(posting.title);
    const body = normaliseText(posting.description);

    const matched: string[] = [];
    let score = 0;

    for (const skill of skills) {
      const inTitle = mentionsTerm(title, skill);
      const inBody = inTitle || mentionsTerm(body, skill);
      if (!inBody) continue;
      matched.push(skill);
      score += inTitle ? TITLE_WEIGHT : 1;
    }

    // Normalised against the best achievable score for THIS profile, so a
    // candidate with three skills is not permanently capped below one with thirty.
    const best = skills.length * TITLE_WEIGHT;
    const relevance = best === 0 ? 0 : Math.round((score / best) * 100);

    return {
      ...posting,
      matchedSkills: matched,
      relevance: Math.min(relevance, 100),
      unscored: false,
    };
  });

  return ranked.sort((a, b) => {
    // Unscored postings last, whatever their other properties.
    if (a.unscored !== b.unscored) return a.unscored ? 1 : -1;
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    // Tie-break on recency, with undated postings after dated ones.
    const at = a.posted_at ? Date.parse(a.posted_at) : 0;
    const bt = b.posted_at ? Date.parse(b.posted_at) : 0;
    return bt - at;
  });
}

/**
 * The profile's matchable skill terms.
 *
 * Drawn from the skills list AND from project technologies, because a student's
 * strongest evidence is often only in a project. Capped so a resume listing forty
 * technologies does not flatten the ranking — the cap keeps the denominator
 * meaningful.
 */
export function profileSkills(profile: ResumeProfile): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (raw: string) => {
    const term = normaliseTerm(raw);
    if (term.length < 2 || seen.has(term)) return;
    seen.add(term);
    out.push(term);
  };

  // Skills demonstrated in a bullet come first: they are the strongest claims, so
  // if the cap truncates anything it should be the unevidenced tail.
  const evidenced = profile.skills.filter((s) => s.evidenceBulletIds.length > 0);
  const listed = profile.skills.filter((s) => s.evidenceBulletIds.length === 0);
  for (const s of [...evidenced, ...listed]) add(s.name);
  for (const p of profile.projects) for (const t of p.technologies) add(t);

  return out.slice(0, MAX_CONTRIBUTING_SKILLS);
}

/** Normalise free text for whole-term search, mirroring the scoring layer. */
function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\.js\b/g, '')
    .replace(/[^a-z0-9+#\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Titles that suggest a role is aimed at students or early-career candidates.
 *
 * Used as a surfacing hint, never as a filter — a second-year student applying to
 * a mid-level role is making a choice, not a mistake, and hiding those postings
 * would be the product deciding for them.
 */
export function looksEarlyCareer(title: string): boolean {
  return /\b(intern|internship|trainee|graduate|entry[- ]level|junior|apprentice|fresher|campus|new grad)\b/i.test(
    title
  );
}

/** Titles that clearly are not. Also a hint, not a filter. */
export function looksSenior(title: string): boolean {
  return /\b(senior|staff|principal|lead|head|director|vp|vice president|manager|architect|chief)\b/i.test(
    title
  );
}
