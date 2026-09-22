// -----------------------------------------------------------------------------
// Scoring orchestrator — five sub-scores into one Match Score
// -----------------------------------------------------------------------------
//
// The public entry point of the scoring engine, and the only thing the API route
// needs to call.
//
// EVERYTHING HERE IS DETERMINISTIC. A language model turns documents into
// `ResumeProfile` and `ParsedJobDescription`; from there, every number is pure
// arithmetic over those structures. That split is the most important design
// decision in this feature, for four reasons:
//
//   REPRODUCIBLE   The same resume and job description always produce the same
//                  score. A user who re-runs a scan and sees 71 then 64 stops
//                  believing either number.
//   EXPLAINABLE    Every point has a reason we can render in the report. Asking a
//                  model for "78/100" yields a number nobody can justify — least
//                  of all to a student asking why theirs dropped.
//   TESTABLE       The whole engine is unit-testable with no API key and no
//                  network. That is why this shipped before the platform Groq key
//                  was even provisioned.
//   CHEAP          Scoring costs nothing. Re-scoring after a weights change is a
//                  loop over stored profiles, not a re-run of inference.
//
// So: models extract, code scores. Do not move scoring into a prompt.

import {
  REPORT_SCHEMA_VERSION,
  type MatchReport,
  type ParsedJobDescription,
  type ResumeProfile,
} from '../schema';
import { scoreEvidenceQuality } from './evidence';
import { scoreKeywordAlignment } from './keywords';
import { scoreKnockoutRisk } from './knockouts';
import { scoreRequirementCoverage } from './requirements';
import {
  combineSubScores,
  PARSE_INTEGRITY_FLOOR,
  WEIGHTS_VERSION,
  type SubScoreKey,
} from './weights';

/** The five sub-scores, each 0-100, exactly as stored on `resume_scans`. */
export type SubScores = Record<SubScoreKey, number>;

/**
 * Everything scoring needs to know about how well the document parsed.
 *
 * Deliberately NARROWER than `ExtractionAssessment`. Scoring reads exactly these
 * three fields, and asking for the full assessment would force callers who no
 * longer hold one to fabricate it — the scan route works from `parse_integrity`
 * and the diagnostics persisted at upload time, and the original extraction is
 * long gone. It was building an empty `RawExtraction` and casting to satisfy a
 * signature that never wanted it.
 *
 * `ExtractionAssessment` satisfies this structurally, so a caller that DOES hold
 * one can still pass it directly with no adapter.
 */
export interface ParseState {
  /** Parse Integrity, 0-100. */
  parseIntegrity: number;
  /** False means refuse to score — see `PARSE_INTEGRITY_FLOOR`. */
  scannable: boolean;
  /** Human-readable file problems, restated into the report. */
  warnings: string[];
}

export interface ScanResult {
  /** The headline Match Score, 0-100. */
  overallScore: number;
  subScores: SubScores;
  /** Written to `resume_scans.weights_version`. */
  weightsVersion: number;
  report: MatchReport;
}

/**
 * A scan was refused because the document could not be read well enough to score.
 *
 * Thrown rather than returned as a low score, because a low score and an
 * unreadable document are different outcomes that need different screens. Scoring
 * a mangled parse would grade text the candidate never wrote and hand back
 * confident, wrong advice — so the pipeline stops and reports the file problem
 * instead.
 */
export class ParseGateError extends Error {
  readonly code = 'parse_quality_too_low' as const;

  constructor(
    readonly parseIntegrity: number,
    readonly warnings: string[]
  ) {
    super(
      `Parse integrity ${parseIntegrity} is below the floor of ${PARSE_INTEGRITY_FLOOR}.`
    );
    this.name = 'ParseGateError';
  }
}

/**
 * Score one resume against one job description.
 *
 * The parse gate is checked FIRST, before any other sub-score is computed. Nothing
 * downstream is meaningful on a broken extraction, and evaluating it anyway would
 * only produce numbers to throw away.
 *
 * `now` is injectable because experience arithmetic depends on the current date;
 * tests must not be able to fail in January.
 */
export function scoreResumeAgainstJob(input: {
  profile: ResumeProfile;
  jd: ParsedJobDescription;
  parse: ParseState;
  now?: Date;
}): ScanResult {
  const { profile, jd, parse, now = new Date() } = input;

  if (!parse.scannable) {
    throw new ParseGateError(parse.parseIntegrity, parse.warnings);
  }

  const requirements = scoreRequirementCoverage(profile, jd);
  const keywords = scoreKeywordAlignment(profile, jd);
  const evidence = scoreEvidenceQuality(profile);
  const knockouts = scoreKnockoutRisk(profile, jd, now);

  const subScores: SubScores = {
    parseIntegrity: parse.parseIntegrity,
    requirementCoverage: requirements.score,
    keywordAlignment: keywords.score,
    evidenceQuality: evidence.score,
    knockoutRisk: knockouts.score,
  };

  const report: MatchReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    requirements: requirements.matches,
    knockouts: knockouts.warnings,
    keywords: { matched: keywords.matched, missing: keywords.missing },
    bulletFeedback: evidence.feedback,
    // Populated by the rewrite step, which runs after scoring so it knows which
    // bullets are weakest and which requirements are unevidenced. An empty array
    // is a valid report — scoring does not depend on the rewrite existing.
    rewrite: [],
    genuineGaps: requirements.genuineGaps,
    // Restated here so a stored scan stays self-contained after the resume row
    // expires under the 90-day retention policy.
    parseWarnings: parse.warnings,
  };

  return {
    overallScore: combineSubScores(subScores),
    subScores,
    weightsVersion: WEIGHTS_VERSION,
    report,
  };
}

export {
  scoreEvidenceQuality,
  scoreKeywordAlignment,
  scoreKnockoutRisk,
  scoreRequirementCoverage,
};
