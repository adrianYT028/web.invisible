// -----------------------------------------------------------------------------
// Evidence Quality — 15% of the Match Score
// -----------------------------------------------------------------------------
//
// Measures how a resume states its claims, not what it claims. Three properties
// per bullet, all deterministic:
//
//   QUANTIFIED       Does it carry a real figure? "Reduced latency from 420 ms to
//                    180 ms" is checkable. "Improved performance" is not.
//   ACTION VERB      Does it open with something the candidate did? "Responsible
//                    for the API" describes a job description; "Rebuilt the API"
//                    describes a person.
//   OUTCOME          Does it say what changed? A duty is what you were assigned;
//                    an outcome is what happened because you were there.
//
// This is the one sub-score that is about writing rather than fit, which is why
// it is weighted below requirement coverage. It is also the most directly
// actionable: unlike a missing skill, a weak bullet can be fixed this afternoon,
// and it is what the rewrite step acts on.
//
// A deliberate limitation: none of this can tell whether a number is TRUE. It
// rewards a bullet for being specific and falsifiable, which correlates with
// honesty but does not verify it. The rewrite step is forbidden from inventing
// figures precisely because this scoring cannot catch it.

import {
  allBullets,
  type BulletFeedback,
  type ResumeProfile,
} from '../schema';
import { clampScore } from './weights';

/**
 * Relative worth of the three properties.
 *
 * Quantification leads because it is the property recruiters and hiring managers
 * consistently single out, and the hardest to fake convincingly. Outcome is close
 * behind. An action verb is table stakes — necessary, but a strong verb attached
 * to a vague claim is still a vague claim, so it carries the least.
 *
 * Must sum to 1.
 */
const PROPERTY_WEIGHTS = {
  quantified: 0.45,
  outcome: 0.35,
  actionVerb: 0.2,
} as const;

/**
 * Bullets shorter than this are treated as fragments and excluded from scoring.
 *
 * A skills line that extraction happened to capture as a bullet ("Python, SQL")
 * is not a weak achievement statement — it is not an achievement statement at
 * all, and scoring it as one would drag down a perfectly good resume.
 */
const MIN_SCORABLE_BULLET_CHARS = 25;

/**
 * Openers that signal a duty rather than an action.
 *
 * Each of these describes an assignment. None of them describes something the
 * candidate personally did or changed.
 */
const DUTY_OPENERS = [
  'responsible for',
  'was responsible for',
  'duties included',
  'tasked with',
  'helped with',
  'helped to',
  'assisted with',
  'assisted in',
  'worked on',
  'worked with',
  'involved in',
  'participated in',
  'part of a team',
  'contributed to',
  'in charge of',
  'handled',
  'dealt with',
  'took care of',
  'familiar with',
  'exposure to',
];

/**
 * Strong action verbs, in the past tense a resume bullet should use.
 *
 * Not exhaustive, and does not need to be: `hasActionVerb` also accepts any
 * unrecognised '-ed' opener, so this list exists to catch irregular verbs that
 * rule would miss ('built', 'wrote', 'led', 'cut') and to be explicit about what
 * good looks like.
 */
const ACTION_VERBS = new Set([
  'built', 'rebuilt', 'wrote', 'led', 'cut', 'shipped', 'drove', 'grew',
  'ran', 'sped', 'set', 'won', 'made', 'sold', 'taught', 'chose', 'found',
  'broke', 'rose', 'saved', 'sent', 'kept', 'held', 'took', 'gave', 'met',
  'created', 'designed', 'developed', 'implemented', 'launched', 'delivered',
  'reduced', 'increased', 'improved', 'optimised', 'optimized', 'automated',
  'migrated', 'refactored', 'architected', 'engineered', 'deployed', 'scaled',
  'analysed', 'analyzed', 'resolved', 'debugged', 'tested', 'documented',
  'mentored', 'coordinated', 'negotiated', 'presented', 'published',
  'streamlined', 'consolidated', 'integrated', 'eliminated', 'accelerated',
  'spearheaded', 'established', 'introduced', 'redesigned', 'rearchitected',
]);

/**
 * Phrases that assert a result.
 *
 * The pattern is causal or comparative language — something moved, and the bullet
 * says which direction.
 */
const OUTCOME_MARKERS = [
  'resulting in',
  'result was',
  'which reduced',
  'which increased',
  'which cut',
  'which saved',
  'leading to',
  'led to',
  'enabling',
  'allowing',
  'saving',
  'cutting',
  'reducing',
  'increasing',
  'improving',
  'raising',
  'lowering',
  'boosting',
  'eliminating',
  'from',
  'up from',
  'down from',
  'compared to',
  'ahead of schedule',
  'under budget',
  'adopted by',
  'used by',
  'relied on by',
];

/**
 * Units and countable nouns that turn a number into a measurement.
 *
 * Shared by the digit and the spelled-out patterns so the two cannot drift.
 */
const UNITS =
  'ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|quarters?|years?|gb|mb|kb|tb|qps|rps|users?|customers?|clients?|students?|records?|rows?|tests?|bugs?|tickets?|members?|people|engineers?|interns?|teams?|projects?|events?|requests?|queries?|pages?|screens?|endpoints?|services?|repositories|repos?|commits?|releases?|deployments?';

/**
 * Number words that count as a quantity when attached to a unit.
 *
 * Starts at 'two' deliberately. 'One' is far more often an article than a
 * measurement — "one of the team", "one thing I learned" — and admitting it would
 * mark a large share of vague bullets as quantified.
 */
const NUMBER_WORDS =
  'two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand';

/**
 * Whether the bullet contains a checkable figure.
 *
 * Matches percentages, currency (including lakh/crore notation), multipliers,
 * scale words, numbers attached to units, and spelled-out numbers attached to
 * units.
 *
 * Deliberately does NOT count a bare year. "Joined the platform team in 2024" is a
 * date, not a measurement, and admitting it would let every bullet carrying a date
 * claim the largest single share of this sub-score.
 */
export function isQuantified(text: string): boolean {
  const lower = text.toLowerCase();

  // Percentages: '40%', '40 percent', '2.5pp'
  if (/\d+(\.\d+)?\s*(%|percent|pp\b)/.test(lower)) return true;
  // Currency, including Indian notation: '₹2.4L', '$40k', 'rs 5000', '3 crore'
  if (/(₹|\$|€|£|\brs\.?\s?)\s*\d/.test(lower)) return true;
  if (/\d+(\.\d+)?\s*(lakh|lakhs|crore|crores|l\b|cr\b)/.test(lower)) return true;
  // Multipliers: '3x', '2.5×'
  if (/\d+(\.\d+)?\s*[x×]\b/.test(lower)) return true;
  // Scale words: '2 million events', '50k users'
  if (/\d+(\.\d+)?\s*(k|m|bn|million|billion|thousand)\b/.test(lower)) {
    return true;
  }
  // A digit attached to a unit: '180 ms', '4 engineers'
  if (new RegExp(String.raw`\d+(\.\d+)?\s*(${UNITS})\b`).test(lower)) return true;
  // A spelled-out number attached to a unit: 'six hours a week', 'four engineers'
  if (new RegExp(String.raw`\b(${NUMBER_WORDS})\s+(${UNITS})\b`).test(lower)) {
    return true;
  }
  // A stated movement between two values: 'from 41 to 78'
  if (/\bfrom\s+\d+(\.\d+)?\s+to\s+\d+(\.\d+)?/.test(lower)) return true;

  return false;
}

/**
 * Whether the bullet opens with an action rather than a duty.
 *
 * Order matters: a duty opener is checked first, because "Worked on rebuilding
 * the API" contains a strong verb but is still framed as an assignment.
 */
export function hasActionVerb(text: string): boolean {
  const lower = text.trim().toLowerCase().replace(/^[-•*\s]+/, '');
  if (lower.length === 0) return false;

  if (DUTY_OPENERS.some((opener) => lower.startsWith(opener))) return false;

  const firstWord = lower.split(/[\s,]+/)[0]?.replace(/[^a-z]/g, '') ?? '';
  if (firstWord.length === 0) return false;
  if (ACTION_VERBS.has(firstWord)) return true;

  // Any past-tense verb the list does not know. Requires length so 'led' style
  // short words are not matched by accident and 'red' is not read as a verb.
  return firstWord.length > 4 && firstWord.endsWith('ed');
}

/**
 * Whether the bullet states an outcome.
 *
 * A figure alone counts: "Reduced median API latency to 180 ms" names a result
 * without any causal connective, and demanding one would penalise the tightest
 * bullets in a good resume.
 */
export function describesOutcome(text: string): boolean {
  const lower = text.toLowerCase();
  if (OUTCOME_MARKERS.some((marker) => lower.includes(marker))) return true;
  return isQuantified(text);
}

export interface EvidenceQualityResult {
  /** 0-100. */
  score: number;
  feedback: BulletFeedback[];
  /** Bullets long enough to be scored. */
  scoredBulletCount: number;
}

/**
 * Score how well the resume evidences its claims.
 *
 * A resume with no scorable bullets scores 0, and that is not a punishment for
 * brevity — it means nothing in the document demonstrates anything, which is the
 * single most important thing to tell a student. It is also almost always paired
 * with parse warnings, since a resume that truly has no bullets usually failed to
 * extract properly.
 */
export function scoreEvidenceQuality(
  profile: ResumeProfile
): EvidenceQualityResult {
  const bullets = allBullets(profile);
  const feedback: BulletFeedback[] = [];
  let scored = 0;
  let total = 0;

  for (const bullet of bullets) {
    const quantified = isQuantified(bullet.text);
    const actionVerb = hasActionVerb(bullet.text);
    const outcome = describesOutcome(bullet.text);

    const scorable = bullet.text.trim().length >= MIN_SCORABLE_BULLET_CHARS;
    if (scorable) {
      scored++;
      total +=
        (quantified ? PROPERTY_WEIGHTS.quantified : 0) +
        (outcome ? PROPERTY_WEIGHTS.outcome : 0) +
        (actionVerb ? PROPERTY_WEIGHTS.actionVerb : 0);
    }

    feedback.push({
      bulletId: bullet.id,
      isQuantified: quantified,
      hasActionVerb: actionVerb,
      describesOutcome: outcome,
      note: scorable ? buildNote(quantified, actionVerb, outcome) : null,
    });
  }

  const score = scored === 0 ? 0 : clampScore(100 * (total / scored));

  return {
    score: Math.round(score),
    feedback,
    scoredBulletCount: scored,
  };
}

/**
 * The one thing most worth fixing about this bullet, or null when it is strong.
 *
 * Single-issue on purpose. A bullet annotated with three criticisms gets rewritten
 * from scratch or ignored; one specific instruction gets acted on.
 */
function buildNote(
  quantified: boolean,
  actionVerb: boolean,
  outcome: boolean
): string | null {
  if (!actionVerb) {
    return 'Starts by describing a responsibility rather than something you did. Open with a past-tense action verb — "Rebuilt", "Cut", "Shipped".';
  }
  if (!quantified && !outcome) {
    return 'States an activity with no result. Add what changed and by how much — time saved, latency dropped, users reached.';
  }
  if (!quantified) {
    return 'Names an outcome but no figure. A number makes it checkable: how much faster, how many users, how many hours saved?';
  }
  return null;
}
