// -----------------------------------------------------------------------------
// Match Score weights and thresholds
// -----------------------------------------------------------------------------
//
// Deliberately NOT in the database. These are product tuning and will change;
// a migration per adjustment would be absurd. What the database does store is
// `resume_scans.weights_version`, so a report rendered under an older weight set
// stays interpretable after these numbers move.
//
// ---------------------------------------------------------------------------
// WHAT THIS SCORE IS, AND WHAT IT IS NOT
//
// It is our score. It is not "your ATS score", and the UI must never call it
// that. Two distinct mechanisms get conflated in the market and it matters here:
//
//   Knockout questions   Real, and genuinely auto-reject. Hard yes/no gates on
//                        the application form (work authorisation, location,
//                        years of experience) where the employer configures the
//                        disqualifying answer.
//
//   Ranking / ordering   Real. Affects the order a recruiter works through
//                        candidates. Does not reject anyone.
//
//   A universal 0-100    Not a thing. No major applicant tracking system
//   auto-reject score    publishes a score to candidates or rejects below a
//                        threshold, and every employer configures theirs
//                        differently.
//
// So presenting this number as an employer's verdict would be a false statement
// about third-party software. Presenting it as our assessment of how well a
// resume evidences a specific job's requirements is true, useful, and the thing
// competitors are vague about. That honesty is a feature, not a disclaimer.

/**
 * Bump on any change to `SUB_SCORE_WEIGHTS` or to how `overall_score` is
 * derived. Written to `resume_scans.weights_version` on every scan.
 */
export const WEIGHTS_VERSION = 1;

/**
 * The five sub-scores and their contribution to the headline number.
 *
 * Parse Integrity carries the most weight, which is not the obvious choice —
 * keyword matching is what the market sells. The reasoning:
 *
 *   - It is the only sub-score measuring a real mechanical failure. The others
 *     measure fit, which is a judgement; this measures whether the document
 *     survived being read at all.
 *   - It is fully deterministic. No model, no prompt, no variance between runs.
 *   - Everything downstream is computed FROM the extracted text, so a bad parse
 *     makes the other four scores fiction delivered with a confident number.
 *     Published resume-NER results drop from roughly 99% F1 on clean text to
 *     roughly 69% on noisy extracted text.
 *   - Competitors under-serve it, because it is unglamorous and hard.
 *
 * Hard Requirement Coverage is second because it is what the user actually asked
 * ("can I do this job, on paper?"), and Keyword Alignment is third because it is
 * a proxy for that same thing — real but shallower, and easy to game.
 *
 * Must sum to 1. Enforced by `assertWeightsSumToOne` below.
 */
export const SUB_SCORE_WEIGHTS = {
  parseIntegrity: 0.25,
  requirementCoverage: 0.3,
  keywordAlignment: 0.2,
  evidenceQuality: 0.15,
  knockoutRisk: 0.1,
} as const;

export type SubScoreKey = keyof typeof SUB_SCORE_WEIGHTS;

/**
 * Below this Parse Integrity, a scan is REFUSED rather than scored.
 *
 * This is a hard stop, not a warning, and that is a deliberate product choice.
 * If a resume did not extract cleanly, every other number is computed on
 * corrupted input — so returning "34/100, work on your keywords" would be
 * actively harmful advice derived from text the user never wrote. The honest
 * output is "we could not read your file properly, here is exactly what is wrong
 * with it, fix that first."
 *
 * It also makes the parse check feel like the feature it is rather than a nag,
 * and it protects margin: no inference is spent on a document that cannot
 * produce a valid result.
 */
export const PARSE_INTEGRITY_FLOOR = 55;

/**
 * Headings a resume is expected to have. Absence is a real parsing signal: a
 * document with no identifiable Experience or Education section reads to a parser
 * as one undifferentiated block of text.
 *
 * Kept broad on purpose — 'work history', 'employment', and 'professional
 * experience' are the same section, and a student resume legitimately leads with
 * Projects instead of Experience.
 */
export const EXPECTED_SECTIONS = {
  experience: [
    'experience',
    'work experience',
    'professional experience',
    'employment',
    'work history',
    'internship',
    'internships',
  ],
  education: ['education', 'academics', 'academic background', 'qualifications'],
  skills: ['skills', 'technical skills', 'core competencies', 'technologies'],
  projects: ['projects', 'personal projects', 'academic projects'],
} as const;

export type ExpectedSectionKey = keyof typeof EXPECTED_SECTIONS;

/**
 * Sections whose absence is penalised.
 *
 * `skills` and `projects` are not required: plenty of strong resumes fold skills
 * into their bullets, and a candidate with real work history does not need a
 * projects section. Penalising their absence would score a style preference as a
 * defect.
 *
 * A resume needs at least one of experience/projects, which
 * `assessParseQuality` handles as a pair rather than penalising each separately —
 * a student with no jobs yet is not a broken document.
 */
export const REQUIRED_SECTIONS: readonly ExpectedSectionKey[] = [
  'experience',
  'education',
] as const;

/**
 * Combine the five sub-scores into the headline number.
 *
 * Each input must already be 0-100. The result is rounded to an integer because
 * `resume_scans.overall_score` is an int column with a 0-100 CHECK constraint,
 * and because a match score presented to two decimal places implies a precision
 * this cannot possibly have.
 */
export function combineSubScores(scores: Record<SubScoreKey, number>): number {
  let total = 0;
  for (const key of Object.keys(SUB_SCORE_WEIGHTS) as SubScoreKey[]) {
    total += clampScore(scores[key]) * SUB_SCORE_WEIGHTS[key];
  }
  return Math.round(clampScore(total));
}

/**
 * Clamp to the 0-100 range the database enforces.
 *
 * Every score written to `resumes` or `resume_scans` passes through here. The
 * CHECK constraints in migration 011 are the real guarantee, but a rejected
 * INSERT surfaces to the user as a failed scan, so clamping in code turns a
 * scoring bug into a slightly wrong number instead of a broken request.
 *
 * NaN maps to 0 rather than propagating: `NaN` fails the CHECK, and a division
 * by an empty requirement list is an easy way to produce one.
 *
 * Note the deliberate `Number.isNaN` rather than `!Number.isFinite`. The latter
 * is also true for the infinities, which would clamp `+Infinity` DOWN to 0 —
 * turning an overflowing score into a zero and reporting a perfect match as a
 * total mismatch. Only NaN is special-cased; the ordinary range comparisons then
 * take `+Infinity` to 100 and `-Infinity` to 0, which is what clamping means.
 */
export function clampScore(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/**
 * Guard against a weight edit that no longer sums to 1, which would silently
 * rescale every score in the product. Called by the weights unit test.
 */
export function assertWeightsSumToOne(): void {
  const sum = Object.values(SUB_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  // Floating point: 0.25 + 0.3 + 0.2 + 0.15 + 0.1 does not land exactly on 1.
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`SUB_SCORE_WEIGHTS must sum to 1, got ${sum}`);
  }
}
