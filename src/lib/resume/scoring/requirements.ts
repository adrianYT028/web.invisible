// -----------------------------------------------------------------------------
// Hard Requirement Coverage — 30% of the Match Score, the heaviest sub-score
// -----------------------------------------------------------------------------
//
// Answers the question the user actually came with: on paper, can I do this job?
//
// It carries more weight than keyword alignment because it is the same question
// asked at a useful depth. Keyword matching asks "does this word appear". This
// asks "is this requirement evidenced, and where" — and the "where" is what makes
// the report auditable. A user who can see which bullet we credited for a
// requirement can disagree with us, which is the difference between a tool and an
// oracle.
//
// EVIDENCE IS RANKED, NOT BINARY. A requirement demonstrated inside a work bullet
// is stronger evidence than the same word sitting in a skills list. Both count,
// but only the bullet produces `met`, because "I have used Redis in production"
// and "I typed Redis into my skills section" are not the same claim. This is the
// one place the scoring pushes back on keyword stuffing.

import {
  allBullets,
  normaliseTerm,
  type JdRequirement,
  type ParsedJobDescription,
  type RequirementMatch,
  type ResumeProfile,
} from '../schema';
import { buildResumeHaystack } from './keywords';
import { containsTerm, mentionsTerm, searchVariants } from './synonyms';
import { clampScore } from './weights';

/**
 * Relative weight of a preferred requirement against a required one.
 *
 * Not zero: "nice to have" items still shape who gets shortlisted when several
 * candidates clear the bar. Not one: missing a preference is not the same failure
 * as missing a requirement, and weighting them equally would tell a qualified
 * candidate they are a poor match because they lack a bonus.
 */
const NICE_TO_HAVE_WEIGHT = 0.4;

/** Credit awarded per requirement status. */
const STATUS_CREDIT = {
  met: 1,
  partial: 0.5,
  missing: 0,
} as const;

/**
 * Share of a requirement's terms that must be evidenced before it counts as
 * fully met.
 *
 * Not 1.0, and the reason is empirical. Extracted term lists carry noise even
 * after stopword filtering — live output for a Python requirement included
 * 'Python-first', which is a real phrase from the posting and no resume will ever
 * contain. Demanding every term meant a single unmatchable token downgraded a
 * genuinely met requirement to `partial`, costing the candidate half its credit
 * for a wording artefact.
 *
 * 0.6 is chosen so a two-term requirement still needs both (1/2 = 0.5 falls
 * short) while a three-term one tolerates a single miss (2/3 = 0.67 clears it).
 * Missing one of two named technologies is a genuine partial; missing one of
 * three tokens is usually noise.
 */
const MET_TERM_RATIO = 0.6;

/**
 * Words that carry no matching signal, used when a requirement arrives with no
 * extracted terms and its own text must be mined instead.
 *
 * The soft-skill block at the end is not padding — it is what makes a genuinely
 * vague requirement reduce to NO terms and therefore be excluded from the score
 * rather than counted as a gap. Without 'player', "A strong team player with good
 * skills" mines down to the single token 'player', which no resume contains, and
 * the candidate is then told they are missing a requirement that was never
 * checkable in the first place.
 *
 * The rule when adding: a word belongs here if finding it in a resume would tell
 * you nothing about whether the candidate meets the requirement.
 */
const STOPWORDS = new Set([
  // Grammar
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'with', 'without',
  'for', 'from', 'to', 'of', 'in', 'on', 'at', 'by', 'as', 'is', 'are',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'should', 'could', 'can', 'may', 'might', 'must', 'you', 'your',
  'we', 'our', 'us', 'they', 'their', 'this', 'that', 'these', 'those',
  // Posting boilerplate
  'strong', 'good', 'excellent', 'solid', 'proven', 'demonstrated', 'deep',
  'experience', 'experienced', 'knowledge', 'understanding', 'familiarity',
  'ability', 'able', 'skills', 'skill', 'working', 'work', 'years', 'year',
  'plus', 'using', 'use', 'used', 'including', 'such', 'etc', 'other',
  'related', 'relevant', 'similar', 'least', 'preferred', 'required',
  'candidate', 'candidates', 'role', 'team', 'teams', 'environment',
  // Soft-skill filler — unmatchable by design
  'player', 'players', 'communication', 'communications', 'communicator',
  'interpersonal', 'verbal', 'written', 'motivated', 'passionate', 'passion',
  'detail', 'details', 'oriented', 'driven', 'fast', 'paced', 'dynamic',
  'collaborative', 'collaboration', 'proactive', 'independently', 'independent',
  'mindset', 'attitude', 'ethic', 'culture', 'fit', 'willingness', 'eager',
  'enthusiastic', 'organised', 'organized', 'reliable', 'flexible', 'adaptable',
  'thinker', 'thinking', 'problem', 'solving', 'solver', 'multitask',
  'deadlines', 'pressure', 'mentality', 'ownership', 'initiative',
]);

/**
 * The terms a requirement should be matched on.
 *
 * Prefers the terms extraction supplied, then falls back to mining the
 * requirement's own text — a requirement must always get assessed, because
 * silently excluding un-termed ones would shrink the denominator and inflate the
 * score.
 *
 * SUPPLIED TERMS ARE FILTERED TOO, and that is not defensive tidying. Real model
 * output for "Required: strong Python, PostgreSQL, REST API design" comes back as
 * `['Python', 'PostgreSQL', 'REST', 'API', 'design']` — three real skills plus
 * 'design', and other requirements yield 'experience', 'essential', 'degree'.
 * Those extra tokens are not skills, no resume reliably contains them, and every
 * one of them used to count against the candidate. Trusting the model's term list
 * verbatim was measurably wrong once tested against the live API.
 */
export function requirementTerms(requirement: JdRequirement): string[] {
  const supplied = requirement.terms
    .map((term) => normaliseTerm(term))
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));
  if (supplied.length > 0) return supplied;

  return normaliseTerm(requirement.text)
    .split(' ')
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Bullets that evidence a term, by id.
 *
 * Searching bullets specifically — rather than the whole resume — is what
 * separates a demonstrated skill from a listed one.
 */
function findEvidenceBullets(profile: ResumeProfile, terms: string[]): string[] {
  const evidence: string[] = [];
  for (const bullet of allBullets(profile)) {
    const haystack = normaliseHaystackText(bullet.text);
    if (terms.some((term) => mentionsTerm(haystack, term))) {
      evidence.push(bullet.id);
    }
  }
  return evidence;
}

/** Normalise free text for term search, preserving word separation. */
function normaliseHaystackText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\.js\b/g, '')
    .replace(/[^a-z0-9+#\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RequirementCoverageResult {
  /** 0-100. */
  score: number;
  matches: RequirementMatch[];
  /**
   * Required items with no evidence at all — the honest "go and acquire this"
   * list.
   *
   * Kept strictly separate from anything the rewrite step touches. The correct
   * response to a missing skill is to build it, not to reword the resume until it
   * implies otherwise, and merging the two lists is the point at which a resume
   * tool starts coaching people to lie.
   */
  genuineGaps: string[];
}

/**
 * Score how well the resume evidences the posting's requirements.
 *
 * A posting with no extractable requirements scores 100: there is nothing to
 * miss. Reporting a failure would blame the candidate for a vague posting.
 */
export function scoreRequirementCoverage(
  profile: ResumeProfile,
  jd: ParsedJobDescription
): RequirementCoverageResult {
  const resumeHaystack = buildResumeHaystack(profile);
  const skillHaystack = normaliseHaystackText(
    profile.skills.map((skill) => skill.name).join(' ')
  );

  const matches: RequirementMatch[] = [];
  const genuineGaps: string[] = [];
  let weightTotal = 0;
  let creditTotal = 0;

  for (const requirement of jd.requirements) {
    const terms = requirementTerms(requirement);
    const weight = requirement.kind === 'must' ? 1 : NICE_TO_HAVE_WEIGHT;

    // A requirement we cannot derive any term from is not assessable. Rather than
    // guess, it is reported with an explicit note and left out of the arithmetic —
    // the only case where exclusion is more honest than a verdict.
    if (terms.length === 0) {
      matches.push({
        text: requirement.text,
        kind: requirement.kind,
        status: 'partial',
        evidenceBulletIds: [],
        note: 'This requirement is written too generally to check automatically. Read it yourself and judge whether your resume answers it.',
      });
      continue;
    }

    const evidenceBulletIds = findEvidenceBullets(profile, terms);
    const foundInBullets = evidenceBulletIds.length > 0;
    const matchedTerms = terms.filter((term) =>
      mentionsTerm(resumeHaystack, term)
    );
    const listedInSkills = terms.some((term) =>
      searchVariants(term).some((variant) => containsTerm(skillHaystack, variant))
    );

    const { status, note } = classify({
      totalTerms: terms.length,
      matchedTerms: matchedTerms.length,
      foundInBullets,
      listedInSkills,
    });

    matches.push({
      text: requirement.text,
      kind: requirement.kind,
      status,
      evidenceBulletIds,
      note,
    });

    weightTotal += weight;
    creditTotal += weight * STATUS_CREDIT[status];

    if (status === 'missing' && requirement.kind === 'must') {
      genuineGaps.push(requirement.text);
    }
  }

  const score =
    weightTotal === 0 ? 100 : clampScore(100 * (creditTotal / weightTotal));

  // Unmet requirements first, and required before preferred: this list is the
  // action plan, so it leads with what actually costs the candidate the interview.
  const statusOrder = { missing: 0, partial: 1, met: 2 } as const;
  const kindOrder = { must: 0, nice: 1 } as const;
  matches.sort(
    (a, b) =>
      statusOrder[a.status] - statusOrder[b.status] ||
      kindOrder[a.kind] - kindOrder[b.kind]
  );

  return { score: Math.round(score), matches, genuineGaps };
}

/**
 * Decide a requirement's status.
 *
 * The ranking that matters: evidence inside a bullet earns `met`; the same term
 * present only in a skills list earns `partial`. That gap is intentional and is
 * the main defence against a resume that lists forty technologies and demonstrates
 * none of them.
 */
function classify(input: {
  totalTerms: number;
  matchedTerms: number;
  foundInBullets: boolean;
  listedInSkills: boolean;
}): { status: RequirementMatch['status']; note: string | null } {
  const { totalTerms, matchedTerms, foundInBullets, listedInSkills } = input;

  if (matchedTerms === 0) {
    return {
      status: 'missing',
      note: 'Nothing in your resume speaks to this requirement.',
    };
  }

  // A threshold rather than all-or-nothing — see MET_TERM_RATIO for why.
  const substantiallyMatched = matchedTerms / totalTerms >= MET_TERM_RATIO;

  if (foundInBullets && substantiallyMatched) {
    return { status: 'met', note: null };
  }

  if (foundInBullets) {
    return {
      status: 'partial',
      note: 'Partly evidenced — your bullets cover some of what this asks for, but not all of it.',
    };
  }

  if (listedInSkills) {
    return {
      status: 'partial',
      note: 'This appears in your skills list but no bullet shows you using it. A recruiter reads a listed skill as a claim and a bullet as proof — move it into your experience or a project.',
    };
  }

  return {
    status: 'partial',
    note: 'Mentioned somewhere in your resume, but not where it counts. Put it in a bullet that shows what you built with it.',
  };
}
