// -----------------------------------------------------------------------------
// Knockout Risk — 10% of the Match Score
// -----------------------------------------------------------------------------
//
// The only part of this product that models something which genuinely rejects an
// application without a human reading it.
//
// The distinction the market blurs, and which this module exists to keep sharp:
//
//   KNOCKOUT QUESTIONS are hard gates on the application form. The employer picks
//   a disqualifying answer to "Do you have the right to work here?" or "Do you
//   have 5+ years of experience?", and an answer that trips it ends the
//   application. This is real, and it happens in minutes.
//
//   RANKING is a scoring pass that orders candidates for the recruiter. It affects
//   the sequence they get reviewed in. It does not reject anyone.
//
// Almost all advice about "beating the ATS" is aimed at the second thing while
// implying the first. Keeping knockouts as their own sub-score, with their own
// warnings, means a candidate who is about to be auto-rejected for something
// structural hears about THAT, instead of being handed a keyword list.
//
// SCORING DIRECTION: 100 means no knockout risk was detected. It is the only
// sub-score where a high number means "nothing found" rather than "did well",
// which is why it is inverted from the others and weighted lightly — a clean 100
// here is the normal case, not an achievement.
//
// HONESTY CONSTRAINT: most resumes say nothing about work authorisation or notice
// period, and this module must not read silence as either compliance or failure.
// Undeterminable conditions are reported as `unclear` and penalised only slightly,
// because the correct advice is "the form will ask you this" rather than a score
// deduction for a question the resume was never meant to answer.

import {
  type JdKnockout,
  type KnockoutWarning,
  type ParsedJobDescription,
  type ResumeDate,
  type ResumeProfile,
} from '../schema';
import { clampScore } from './weights';
import { mentionsTerm } from './synonyms';

/**
 * Deductions by severity.
 *
 * `blocking` is heavy but not fatal to the whole Match Score: this sub-score is
 * 10% of the total, so a blocking knockout costs about 5 points overall. That is
 * deliberate — the WARNING is the product here, not the arithmetic. A student who
 * lacks a required degree needs to read that sentence, and zeroing their whole
 * report would just make them close the tab.
 */
const SEVERITY_PENALTY = {
  blocking: 50,
  likely: 25,
  unclear: 8,
} as const;

/**
 * Experience shortfall, in months, before a years-of-experience gap is treated as
 * blocking rather than merely likely.
 *
 * Postings routinely overstate this, and recruiters routinely ignore it by a
 * year — so a candidate six months short of "2+ years" is not out of the running,
 * while one four years short of "5+ years" effectively is.
 */
const BLOCKING_EXPERIENCE_SHORTFALL_MONTHS = 24;

/** Degree levels, so a Master's satisfies a posting asking for a Bachelor's. */
const DEGREE_RANK: Record<string, number> = {
  diploma: 1,
  bachelor: 2,
  btech: 2,
  be: 2,
  bsc: 2,
  bca: 2,
  bcom: 2,
  ba: 2,
  master: 3,
  mtech: 3,
  msc: 3,
  mca: 3,
  mba: 3,
  ma: 3,
  phd: 4,
  doctorate: 4,
};

/**
 * A date resolved to an absolute month index, or null when the year is unknown.
 *
 * A missing month is treated as mid-year rather than January. Resume dates that
 * give only a year are as likely to mean December as January, and defaulting to
 * January systematically inflates every tenure by up to eleven months.
 */
function toMonthIndex(date: ResumeDate | null): number | null {
  if (!date || date.year === null) return null;
  const month = date.month ?? 6;
  return date.year * 12 + month;
}

/**
 * Total professional experience in months.
 *
 * Overlapping roles are MERGED rather than summed. Students routinely hold a
 * part-time role and an internship at the same time, and adding both would credit
 * them with twice the calendar time they actually worked — which would then be
 * compared against a posting's "2+ years" and produce a confidently wrong verdict.
 *
 * Roles with no parseable start are skipped: an unreadable date is a gap in our
 * knowledge, and guessing at it in either direction would be worse than the
 * `unclear` warning the caller can emit instead.
 */
export function totalExperienceMonths(
  profile: ResumeProfile,
  now: Date = new Date()
): number {
  const nowIndex = now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1);

  const intervals: Array<[number, number]> = [];
  for (const role of profile.experience) {
    const start = toMonthIndex(role.startDate);
    if (start === null) continue;

    const end = role.isCurrent
      ? nowIndex
      : (toMonthIndex(role.endDate) ?? nowIndex);
    // A role whose dates run backwards is a parse artefact, not a negative tenure.
    if (end < start) continue;
    intervals.push([start, end]);
  }

  if (intervals.length === 0) return 0;

  intervals.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [currentStart, currentEnd] = intervals[0];

  for (const [start, end] of intervals.slice(1)) {
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      months += currentEnd - currentStart;
      [currentStart, currentEnd] = [start, end];
    }
  }
  months += currentEnd - currentStart;
  return months;
}

/**
 * Highest degree level named in a body of text, or 0 when none is recognisable.
 *
 * Checks BOTH a space-separated form and a whitespace-stripped form, which is not
 * redundant: Indian degrees are overwhelmingly written with dots, so 'B.Tech'
 * becomes 'b tech' once punctuation is neutralised and would never match the key
 * 'btech'. Testing the compacted form too is what makes 'B.Tech', 'B Tech' and
 * 'BTech' all resolve to the same level — without it, the most common degree on
 * the target market's resumes would silently rank as no degree at all.
 */
function degreeRankIn(text: string): number {
  const spaced = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ');
  const compact = spaced.replace(/\s+/g, '');

  let rank = 0;
  for (const [name, value] of Object.entries(DEGREE_RANK)) {
    if (value <= rank) continue;
    if (spaced.includes(name) || compact.includes(name)) rank = value;
  }
  return rank;
}

/** The highest degree level the resume claims, or 0 when none is recognisable. */
export function highestDegreeRank(profile: ResumeProfile): number {
  let rank = 0;
  for (const education of profile.education) {
    const found = degreeRankIn(
      `${education.degree ?? ''} ${education.field ?? ''}`
    );
    if (found > rank) rank = found;
  }
  return rank;
}

/** The degree level a posting demands, or 0 when it names none. */
function requiredDegreeRank(requirement: string): number {
  return degreeRankIn(requirement);
}

export interface KnockoutRiskResult {
  /** 0-100, where 100 means nothing was detected. */
  score: number;
  warnings: KnockoutWarning[];
}

/**
 * Assess the posting's hard gates against the resume.
 *
 * `now` is injectable so experience arithmetic is testable without the clock
 * moving under the test suite.
 */
export function scoreKnockoutRisk(
  profile: ResumeProfile,
  jd: ParsedJobDescription,
  now: Date = new Date()
): KnockoutRiskResult {
  const warnings: KnockoutWarning[] = [];

  for (const knockout of jd.knockouts) {
    const warning = assessKnockout(knockout, profile, jd, now);
    if (warning) warnings.push(warning);
  }

  let score = 100;
  for (const warning of warnings) score -= SEVERITY_PENALTY[warning.severity];

  // Most severe first — this list is read top-down and the blocking item is the
  // one that decides whether applying is worth the effort.
  const order = { blocking: 0, likely: 1, unclear: 2 } as const;
  warnings.sort((a, b) => order[a.severity] - order[b.severity]);

  return { score: Math.round(clampScore(score)), warnings };
}

function assessKnockout(
  knockout: JdKnockout,
  profile: ResumeProfile,
  jd: ParsedJobDescription,
  now: Date
): KnockoutWarning | null {
  switch (knockout.kind) {
    case 'years_experience':
      return assessExperience(knockout, profile, now);
    case 'location':
      return assessLocation(knockout, profile, jd);
    case 'degree':
      return assessDegree(knockout, profile);
    case 'work_authorisation':
      // A resume is not the place this is stated, and its absence says nothing.
      // Reported so the candidate is not blindsided by the form, not scored as a
      // failing.
      return {
        kind: knockout.kind,
        requirement: knockout.requirement,
        resumeStates: null,
        severity: 'unclear',
        note: 'This posting has a work-authorisation condition. Your resume does not address it, which is normal — but the application form will ask directly, and the answer there is a hard gate. Check you meet it before spending time on the application.',
      };
    default:
      return {
        kind: knockout.kind,
        requirement: knockout.requirement,
        resumeStates: null,
        severity: 'unclear',
        note: `This posting states a condition your resume does not address: "${knockout.requirement}".`,
      };
  }
}

function assessExperience(
  knockout: JdKnockout,
  profile: ResumeProfile,
  now: Date
): KnockoutWarning | null {
  if (knockout.minYears === null) return null;

  const months = totalExperienceMonths(profile, now);
  const requiredMonths = knockout.minYears * 12;
  if (months >= requiredMonths) return null;

  const shortfall = requiredMonths - months;
  const years = (months / 12).toFixed(1);

  // No parseable experience at all is a different message from a shortfall: the
  // cause is often that dates failed to extract, not that the candidate has none.
  if (months === 0) {
    return {
      kind: knockout.kind,
      requirement: knockout.requirement,
      resumeStates: null,
      severity: 'likely',
      note: `This posting asks for ${knockout.minYears}+ years of experience and no dated work history could be read from your resume. If you do have experience, check that your dates are written plainly ("Jan 2024 – Jun 2024") — unreadable dates mean a recruiter's filters cannot credit you for it.`,
    };
  }

  return {
    kind: knockout.kind,
    requirement: knockout.requirement,
    resumeStates: `${years} years`,
    severity:
      shortfall >= BLOCKING_EXPERIENCE_SHORTFALL_MONTHS ? 'blocking' : 'likely',
    note:
      shortfall >= BLOCKING_EXPERIENCE_SHORTFALL_MONTHS
        ? `This posting asks for ${knockout.minYears}+ years and your resume evidences about ${years}. That is a large enough gap that the form's screening question will most likely end the application. Worth targeting roles a level down.`
        : `This posting asks for ${knockout.minYears}+ years and your resume evidences about ${years}. Postings overstate this often and recruiters flex by around a year, so this is worth applying to — but lead with your strongest, most relevant work.`,
  };
}

function assessLocation(
  knockout: JdKnockout,
  profile: ResumeProfile,
  jd: ParsedJobDescription
): KnockoutWarning | null {
  // A remote posting has no location gate to trip.
  if (jd.isRemote) return null;

  const candidateLocation = profile.contact.location;
  if (!candidateLocation) {
    return {
      kind: knockout.kind,
      requirement: knockout.requirement,
      resumeStates: null,
      severity: 'unclear',
      note: `This role is tied to a location (${knockout.requirement}) and your resume does not say where you are. Add your city — recruiters filter on it, and its absence can drop you from a search you would otherwise pass.`,
    };
  }

  // Compare on the distinctive words of the posting's location. A shared word is
  // enough: "Bengaluru, Karnataka" and "Bengaluru" are the same place.
  const target = (jd.location ?? knockout.requirement)
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3);

  const candidate = candidateLocation.toLowerCase();
  if (target.length === 0) return null;
  if (target.some((word) => mentionsTerm(candidate, word))) return null;

  return {
    kind: knockout.kind,
    requirement: knockout.requirement,
    resumeStates: candidateLocation,
    severity: 'likely',
    note: `This role is based in ${jd.location ?? knockout.requirement} and your resume says you are in ${candidateLocation}. Location is one of the fields recruiters filter on hardest. If you are willing to relocate, say so explicitly near your contact details — otherwise this is likely to screen you out.`,
  };
}

function assessDegree(
  knockout: JdKnockout,
  profile: ResumeProfile
): KnockoutWarning | null {
  const required = requiredDegreeRank(knockout.requirement);
  if (required === 0) return null;

  const held = highestDegreeRank(profile);
  if (held >= required) return null;

  // A student mid-degree has no completed qualification but is not disqualified —
  // most graduate postings expect exactly this.
  if (held === 0) {
    return {
      kind: knockout.kind,
      requirement: knockout.requirement,
      resumeStates: null,
      severity: 'unclear',
      note: `This posting requires a specific qualification ("${knockout.requirement}") and no degree could be identified on your resume. If you are still studying, state the degree and your expected completion date — "B.Tech Computer Science, expected 2027" reads as on-track rather than absent.`,
    };
  }

  return {
    kind: knockout.kind,
    requirement: knockout.requirement,
    resumeStates: profile.education[0]?.degree ?? null,
    severity: 'likely',
    note: `This posting asks for ${knockout.requirement}, which is above the qualification on your resume. Some employers treat this as a hard filter on the application form.`,
  };
}
