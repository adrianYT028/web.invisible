// -----------------------------------------------------------------------------
// Keyword & Title Alignment — 20% of the Match Score
// -----------------------------------------------------------------------------
//
// The shallowest of the five sub-scores, and weighted accordingly. It measures
// vocabulary overlap between the resume and the posting, which is a real signal —
// recruiters search their applicant database by job title, hard skills, and
// location, so a resume that never uses the posting's words is genuinely harder
// to find — but it is also the easiest signal to game by pasting a keyword list.
//
// Two design choices keep it honest:
//
//   FREQUENCY WEIGHTING. A term the posting mentions five times matters more than
//   one mentioned once. Without weighting, matching a passing mention of 'Excel'
//   counts the same as matching the core language of the role.
//
//   EVIDENCE IS NOT REQUIRED HERE, BUT IT IS SCORED ELSEWHERE. This sub-score
//   accepts a term listed in a skills section. Whether the candidate actually
//   demonstrated it is what Evidence Quality measures, and requirement coverage
//   looks for it in bullets. So a keyword-stuffed resume can score well here and
//   still land a mediocre overall number — which is the intended behaviour, and
//   the reason this is 20% rather than the headline.

import {
  allBullets,
  type KeywordMatch,
  type ParsedJobDescription,
  type ResumeProfile,
} from '../schema';
import { canonicalTerm, containsTerm, mentionsTerm, searchVariants } from './synonyms';
import { clampScore } from './weights';

/**
 * Share of the sub-score carried by job-title alignment, with the rest coming
 * from weighted keyword coverage.
 *
 * Title alignment gets real weight because it is the field recruiters search
 * most directly, and because a resume whose titles never resemble the role is
 * usually a genuine mismatch rather than a wording problem. It is not larger than
 * this because student resumes legitimately have no matching title yet — an
 * intern applying for "Software Engineer" should not be capped by it.
 */
const TITLE_WEIGHT = 0.15;

/**
 * Title words too generic to prove alignment on their own.
 *
 * Matching on 'engineer' alone would call a Mechanical Engineer a match for a
 * Software Engineer posting.
 */
const GENERIC_TITLE_WORDS = new Set([
  'engineer',
  'engineering',
  'developer',
  'analyst',
  'associate',
  'specialist',
  'intern',
  'internship',
  'senior',
  'junior',
  'lead',
  'staff',
  'principal',
  'i',
  'ii',
  'iii',
  'trainee',
  'graduate',
  'manager',
  'consultant',
  'executive',
  'officer',
  'assistant',
]);

export interface KeywordAlignmentResult {
  /** 0-100. */
  score: number;
  matched: KeywordMatch[];
  missing: KeywordMatch[];
  /** Whether a distinctive word from the job title appears in the resume. */
  titleAligned: boolean;
}

/**
 * One lowercased, punctuation-stripped haystack of everything the resume says.
 *
 * Searching free text rather than a tokenised skill list is deliberate: it finds
 * a technology mentioned only inside a bullet ("migrated the service to
 * PostgreSQL") which a skills-section-only index would miss and then report as a
 * gap the candidate does not have.
 */
export function buildResumeHaystack(profile: ResumeProfile): string {
  const parts: string[] = [];

  if (profile.summary) parts.push(profile.summary);
  for (const skill of profile.skills) parts.push(skill.name);
  for (const role of profile.experience) {
    if (role.title) parts.push(role.title);
    if (role.company) parts.push(role.company);
  }
  for (const project of profile.projects) {
    if (project.name) parts.push(project.name);
    if (project.description) parts.push(project.description);
    parts.push(...project.technologies);
  }
  for (const education of profile.education) {
    if (education.degree) parts.push(education.degree);
    if (education.field) parts.push(education.field);
  }
  for (const certification of profile.certifications) {
    if (certification.name) parts.push(certification.name);
  }
  for (const bullet of allBullets(profile)) parts.push(bullet.text);

  // Normalise the joined text the same way terms are normalised, so both sides of
  // every comparison have been through identical treatment.
  return normaliseHaystack(parts.join(' \n '));
}

/**
 * Normalise a body of text for term search.
 *
 * Mirrors `normaliseTerm` but preserves whitespace as separators rather than
 * collapsing to a single token, because multi-word terms ('machine learning')
 * must remain findable.
 */
function normaliseHaystack(text: string): string {
  return text
    .toLowerCase()
    .replace(/\.js\b/g, '')
    .replace(/[^a-z0-9+#\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How many times the resume mentions a term, across all its known spellings.
 *
 * Capped per variant because repetition in a resume is not evidence of depth —
 * a term listed once in Skills and used twice in bullets is a normal, well-written
 * resume, and one repeated fifteen times is keyword stuffing that should not earn
 * fifteen times the credit.
 */
function countResumeMentions(haystack: string, term: string): number {
  let total = 0;
  for (const variant of searchVariants(term)) {
    if (containsTerm(haystack, variant)) total += 1;
  }
  return total;
}

/**
 * The words in a job title that can actually carry a match.
 *
 * 'Backend Engineer' and 'Frontend Engineer' share 'engineer' — precisely the
 * word that must not count. An empty result means the title is unusable for
 * alignment ('Senior Associate' is entirely generic), which the scorer treats as
 * "not assessable" rather than "not aligned".
 */
export function distinctiveTitleWords(jobTitle: string | null): string[] {
  if (!jobTitle) return [];
  return normaliseHaystack(jobTitle)
    .split(' ')
    .filter((word) => word.length > 1 && !GENERIC_TITLE_WORDS.has(word));
}

/**
 * Whether the resume's role titles resemble the posting's title.
 */
export function isTitleAligned(
  profile: ResumeProfile,
  jobTitle: string | null
): boolean {
  const distinctive = distinctiveTitleWords(jobTitle);
  if (distinctive.length === 0) return false;

  const titleHaystack = normaliseHaystack(
    profile.experience
      .map((role) => role.title ?? '')
      .concat(profile.projects.map((project) => project.name ?? ''))
      .concat(profile.summary ?? '')
      .join(' ')
  );

  return distinctive.some((word) => mentionsTerm(titleHaystack, word));
}

/**
 * Score keyword and title alignment.
 *
 * A posting with no extractable keywords scores 100 rather than 0: there is
 * nothing to miss, and reporting a failure for an empty requirement list would
 * punish the candidate for the posting being vague.
 */
export function scoreKeywordAlignment(
  profile: ResumeProfile,
  jd: ParsedJobDescription
): KeywordAlignmentResult {
  const haystack = buildResumeHaystack(profile);
  const titleAligned = isTitleAligned(profile, jd.jobTitle);

  const matched: KeywordMatch[] = [];
  const missing: KeywordMatch[] = [];
  let weightTotal = 0;
  let weightMatched = 0;

  for (const keyword of jd.keywords) {
    // Frequency is the weight, floored at 1 so a term the extractor reported with
    // a zero or missing count still counts once.
    const weight = Math.max(keyword.count, 1);
    weightTotal += weight;

    const resumeCount = countResumeMentions(haystack, keyword.term);
    const canonical = canonicalTerm(keyword.term);
    // A hit through an alias rather than the posting's own spelling is worth
    // surfacing: it is the difference between "you are missing this" and "you
    // wrote this a different way", and only one of those is a real gap.
    const viaSynonym =
      resumeCount > 0 && !containsTerm(haystack, canonical);

    const entry: KeywordMatch = {
      term: keyword.term,
      jdCount: keyword.count,
      resumeCount,
      viaSynonym,
    };

    if (resumeCount > 0) {
      matched.push(entry);
      weightMatched += weight;
    } else {
      missing.push(entry);
    }
  }

  const coverage = weightTotal === 0 ? 1 : weightMatched / weightTotal;

  // Charge for title alignment ONLY when the posting gave something to align to.
  // A posting with no title, or a title made entirely of generic words, offers
  // nothing to match — so folding in a zero would silently cap the sub-score at
  // 85 for a resume that did nothing wrong. When the title is unusable, its weight
  // returns to coverage.
  const titleWeight = distinctiveTitleWords(jd.jobTitle).length > 0
    ? TITLE_WEIGHT
    : 0;

  const score = clampScore(
    100 * ((1 - titleWeight) * coverage + titleWeight * (titleAligned ? 1 : 0))
  );

  // Most-mentioned gaps first: that is the order in which fixing them matters.
  missing.sort((a, b) => b.jdCount - a.jdCount);

  return { score: Math.round(score), matched, missing, titleAligned };
}
