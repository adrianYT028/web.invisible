import { describe, expect, it } from 'vitest';

import type { ExtractionAssessment } from '../extraction';
import {
  bulletId,
  emptyJobDescription,
  emptyProfile,
  type ParsedJobDescription,
  type ResumeBullet,
  type ResumeDate,
  type ResumeProfile,
  type ResumeRole,
  type ResumeSkill,
} from '../schema';
import { ParseGateError, scoreResumeAgainstJob } from './index';
import { isQuantified, hasActionVerb, describesOutcome, scoreEvidenceQuality } from './evidence';
import { isTitleAligned, scoreKeywordAlignment } from './keywords';
import {
  highestDegreeRank,
  scoreKnockoutRisk,
  totalExperienceMonths,
} from './knockouts';
import { requirementTerms, scoreRequirementCoverage } from './requirements';
import { canonicalTerm, containsTerm, mentionsTerm, termsMatch } from './synonyms';

// -----------------------------------------------------------------------------
// Scoring engine tests
//
// The entire engine is deterministic — models extract, code scores — so all of it
// is testable here with no API key and no network. That property is the reason
// this shipped before a platform Groq key existed.
// -----------------------------------------------------------------------------

const NOW = new Date('2026-08-25T00:00:00Z');

function date(year: number, month: number | null = null): ResumeDate {
  return { raw: `${month ?? ''}/${year}`, year, month };
}

function skill(name: string, evidenceBulletIds: string[] = []): ResumeSkill {
  return {
    name,
    normalised: name.toLowerCase(),
    category: null,
    evidenceBulletIds,
  };
}

function bullets(scope: 'exp' | 'proj', parent: number, texts: string[]): ResumeBullet[] {
  return texts.map((text, i) => ({ id: bulletId(scope, parent, i), text }));
}

function role(overrides: Partial<ResumeRole> = {}): ResumeRole {
  return {
    title: 'Backend Engineering Intern',
    company: 'Zenpay Technologies',
    location: 'Bengaluru',
    startDate: date(2024, 1),
    endDate: date(2024, 6),
    isCurrent: false,
    bullets: [],
    ...overrides,
  };
}

/** A believable student resume with real, quantified bullets. */
function strongProfile(): ResumeProfile {
  return {
    ...emptyProfile(),
    contact: {
      name: 'Aarav Sharma',
      email: 'aarav@example.com',
      phone: '+91 98765 43210',
      location: 'Noida, Uttar Pradesh',
      links: [],
    },
    skills: [skill('Python'), skill('PostgreSQL'), skill('Redis'), skill('React')],
    experience: [
      role({
        bullets: bullets('exp', 0, [
          'Reduced median API latency from 420 ms to 180 ms by adding a Redis cache layer',
          'Rebuilt the payment reconciliation job in Python, cutting nightly runtime by 40%',
          'Migrated a reporting service from MongoDB to PostgreSQL with no downtime',
        ]),
      }),
    ],
    education: [
      {
        institution: 'Amity University',
        degree: 'B.Tech',
        field: 'Computer Science',
        startDate: date(2021),
        endDate: date(2025),
        score: '8.4 CGPA',
      },
    ],
    sectionsFound: ['experience', 'education', 'skills'],
  };
}

function jd(overrides: Partial<ParsedJobDescription> = {}): ParsedJobDescription {
  return { ...emptyJobDescription(), ...overrides };
}

function assessment(overrides: Partial<ExtractionAssessment> = {}): ExtractionAssessment {
  return {
    raw: {
      text: '',
      pageCount: 1,
      pages: [],
      hasTextLayer: true,
      columnLayoutSuspected: false,
      tablesDetected: false,
      engine: 'test',
    },
    diagnostics: {
      hasTextLayer: true,
      imageOnlyPages: [],
      columnLayoutSuspected: false,
      tablesDetected: false,
      headingsFound: [],
      headingsMissing: [],
      datesFound: 0,
      datesParsed: 0,
      charCount: 2000,
      wordCount: 300,
      encodingDamageSuspected: false,
      hasEmail: true,
      hasPhone: true,
    },
    parseIntegrity: 100,
    warnings: [],
    scannable: true,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Synonyms
// -----------------------------------------------------------------------------

describe('synonyms', () => {
  it.each([
    ['React.js', 'react'],
    ['ReactJS', 'react'],
    ['react', 'react'],
    ['JS', 'javascript'],
    ['Node.js', 'node'],
    ['postgres', 'postgresql'],
    ['K8s', 'kubernetes'],
    ['ML', 'machine learning'],
    ['CPP', 'c++'],
  ])('canonicalises %s', (input, expected) => {
    expect(canonicalTerm(input)).toBe(expected);
  });

  it('treats different spellings of one skill as equal', () => {
    expect(termsMatch('React.js', 'ReactJS')).toBe(true);
    expect(termsMatch('postgres', 'PostgreSQL')).toBe(true);
  });

  it('does NOT conflate Java with JavaScript', () => {
    // Merging these would mark a Java backend developer as matching a frontend
    // role, which is the single worst false positive this map could produce.
    expect(termsMatch('java', 'javascript')).toBe(false);
  });

  it('does not conflate git with github', () => {
    expect(termsMatch('git', 'github')).toBe(false);
  });

  it('respects term boundaries rather than matching substrings', () => {
    // 'go' inside 'mongodb' is the classic false positive.
    expect(containsTerm('mongodb aggregation', 'go')).toBe(false);
    expect(containsTerm('go and rust', 'go')).toBe(true);
  });

  it('matches terms whose punctuation breaks word boundaries', () => {
    // \b does not work at the end of 'c++' because '+' is not a word character.
    expect(containsTerm('built in c++ and rust', 'c++')).toBe(true);
    expect(containsTerm('wrote c# services', 'c#')).toBe(true);
    // And must not match the bare letter.
    expect(containsTerm('built in c++', 'c')).toBe(false);
  });

  it('finds a term through any known alias', () => {
    expect(mentionsTerm('experienced with ml pipelines', 'machine learning')).toBe(
      true
    );
    expect(mentionsTerm('deep machine learning work', 'ml')).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Evidence quality
// -----------------------------------------------------------------------------

describe('isQuantified', () => {
  it.each([
    'Cut nightly runtime by 40%',
    'Reduced latency from 420 ms to 180 ms',
    'Saved ₹2.4L in annual costs',
    'Handled roughly 2 million events a day',
    'Grew signups 3x in one quarter',
    'Supported 50k users',
    'Raised coverage from 41 to 78',
    'Saved the team six hours a week',
  ])('accepts "%s"', (text) => {
    expect(isQuantified(text)).toBe(true);
  });

  it.each([
    'Improved application performance significantly',
    'Worked on the payments system',
    'Responsible for various backend services',
  ])('rejects "%s"', (text) => {
    expect(isQuantified(text)).toBe(false);
  });

  it('does not count a bare year as a measurement', () => {
    // Otherwise every bullet carrying a date would claim the largest share of
    // this sub-score.
    expect(isQuantified('Joined the platform team in 2024')).toBe(false);
  });
});

describe('hasActionVerb', () => {
  it.each([
    'Rebuilt the reconciliation job',
    'Cut deployment time in half',
    'Wrote the integration test suite',
    'Migrated the service to PostgreSQL',
    'Spearheaded the caching project',
  ])('accepts "%s"', (text) => {
    expect(hasActionVerb(text)).toBe(true);
  });

  it.each([
    'Responsible for the payments API',
    'Worked on improving performance',
    'Assisted with the migration',
    'Involved in code reviews',
    'Familiar with Kubernetes',
  ])('rejects the duty opener "%s"', (text) => {
    expect(hasActionVerb(text)).toBe(false);
  });

  it('rejects a duty opener even when it contains a strong verb', () => {
    // 'Worked on rebuilding' has 'rebuilding' in it but is still framed as an
    // assignment, so opener checks must run before verb checks.
    expect(hasActionVerb('Worked on rebuilding the API')).toBe(false);
  });

  it('accepts an unlisted past-tense verb', () => {
    expect(hasActionVerb('Overhauled the onboarding flow')).toBe(true);
  });

  it('tolerates a leading bullet glyph', () => {
    expect(hasActionVerb('• Rebuilt the job')).toBe(true);
  });
});

describe('describesOutcome', () => {
  it('accepts causal language', () => {
    expect(describesOutcome('Refactored the parser, resulting in fewer crashes')).toBe(
      true
    );
  });

  it('accepts a bare figure with no connective', () => {
    // Demanding a connective would penalise the tightest bullets in a good resume.
    expect(describesOutcome('Reduced median latency to 180 ms')).toBe(true);
  });

  it('rejects a pure activity statement', () => {
    expect(describesOutcome('Attended daily standups')).toBe(false);
  });
});

describe('scoreEvidenceQuality', () => {
  it('scores a strong resume highly, with partial credit where a figure is absent', () => {
    // 85, and the arithmetic is worth spelling out because it documents the
    // partial-credit path rather than just asserting "high".
    //
    // Bullets 1 and 2 are quantified, outcome-bearing, and action-led → 1.0 each.
    // Bullet 3 ("Migrated a reporting service from MongoDB to PostgreSQL with no
    // downtime") is action-led and states an outcome but carries NO figure, so it
    // forfeits the quantified weight of 0.45 → 0.55.
    //
    //   (1.0 + 1.0 + 0.55) / 3 = 0.85
    //
    // A resume of three strong bullets where one lacks a number should not score
    // 100; that bullet has a real, fixable weakness and the rewrite step targets it.
    const result = scoreEvidenceQuality(strongProfile());
    expect(result.score).toBe(85);
    expect(result.scoredBulletCount).toBe(3);
    expect(result.feedback[2].isQuantified).toBe(false);
    expect(result.feedback[2].note).toMatch(/figure|number/i);
  });

  it('scores a duty-listing resume poorly and says why', () => {
    const weak: ResumeProfile = {
      ...strongProfile(),
      experience: [
        role({
          bullets: bullets('exp', 0, [
            'Responsible for maintaining the backend services',
            'Worked on various features across the product',
            'Involved in team meetings and code reviews',
          ]),
        }),
      ],
    };

    const result = scoreEvidenceQuality(weak);
    expect(result.score).toBeLessThan(25);
    expect(result.feedback.every((f) => f.note !== null)).toBe(true);
    expect(result.feedback[0].note).toMatch(/action verb/i);
  });

  it('excludes fragments too short to be achievement statements', () => {
    // A skills line captured as a bullet is not a weak bullet — it is not a
    // bullet, and scoring it would drag down a good resume.
    const withFragment: ResumeProfile = {
      ...strongProfile(),
      experience: [
        role({
          bullets: bullets('exp', 0, [
            'Reduced median API latency from 420 ms to 180 ms using Redis',
            'Python, SQL',
          ]),
        }),
      ],
    };

    const result = scoreEvidenceQuality(withFragment);
    expect(result.scoredBulletCount).toBe(1);
    expect(result.score).toBe(100);
    // Still reported, just not scored.
    expect(result.feedback).toHaveLength(2);
    expect(result.feedback[1].note).toBeNull();
  });

  it('scores a resume with no bullets as zero', () => {
    const result = scoreEvidenceQuality(emptyProfile());
    expect(result.score).toBe(0);
  });

  it('gives one instruction per bullet, not three criticisms', () => {
    const result = scoreEvidenceQuality({
      ...strongProfile(),
      experience: [
        role({
          bullets: bullets('exp', 0, [
            'Built an internal tool for the support team to use',
          ]),
        }),
      ],
    });
    // Has an action verb but no figure and no outcome → the missing-result note.
    expect(result.feedback[0].note).toMatch(/no result|what changed/i);
  });
});

// -----------------------------------------------------------------------------
// Keyword alignment
// -----------------------------------------------------------------------------

describe('isTitleAligned', () => {
  it('aligns on a distinctive word', () => {
    expect(isTitleAligned(strongProfile(), 'Backend Engineer')).toBe(true);
  });

  it('does NOT align on a generic word alone', () => {
    // Otherwise a Mechanical Engineer matches a Software Engineer posting.
    const mechanical: ResumeProfile = {
      ...strongProfile(),
      experience: [role({ title: 'Mechanical Engineer' })],
      projects: [],
      summary: null,
    };
    expect(isTitleAligned(mechanical, 'Software Engineer')).toBe(false);
  });

  it('returns false for a title made only of generic words', () => {
    expect(isTitleAligned(strongProfile(), 'Senior Associate')).toBe(false);
  });

  it('returns false when the posting has no title', () => {
    expect(isTitleAligned(strongProfile(), null)).toBe(false);
  });
});

describe('scoreKeywordAlignment', () => {
  it('credits a term found only inside a bullet', () => {
    // A skills-list-only index would report MongoDB as a gap the candidate does
    // not have — it appears in their migration bullet.
    const result = scoreKeywordAlignment(
      strongProfile(),
      jd({ keywords: [{ term: 'MongoDB', count: 2 }] })
    );
    expect(result.matched.map((m) => m.term)).toContain('MongoDB');
  });

  it('flags a match made through an alias', () => {
    const result = scoreKeywordAlignment(
      strongProfile(),
      jd({ keywords: [{ term: 'Postgres', count: 1 }] })
    );
    // The resume writes 'PostgreSQL'; the posting writes 'Postgres'. That is not
    // a gap, and the report should say so rather than listing it as missing.
    expect(result.matched).toHaveLength(1);
    expect(result.missing).toHaveLength(0);
  });

  it('weights by how often the posting mentions a term', () => {
    const profile = strongProfile();
    // Misses the term mentioned 10 times, matches the one mentioned once.
    const heavyMiss = scoreKeywordAlignment(
      profile,
      jd({
        keywords: [
          { term: 'Kubernetes', count: 10 },
          { term: 'Python', count: 1 },
        ],
      })
    );
    // Misses the rare term, matches the frequent one.
    const lightMiss = scoreKeywordAlignment(
      profile,
      jd({
        keywords: [
          { term: 'Python', count: 10 },
          { term: 'Kubernetes', count: 1 },
        ],
      })
    );
    expect(lightMiss.score).toBeGreaterThan(heavyMiss.score);
  });

  it('orders gaps by how central they are to the posting', () => {
    const result = scoreKeywordAlignment(
      strongProfile(),
      jd({
        keywords: [
          { term: 'Terraform', count: 1 },
          { term: 'Kubernetes', count: 6 },
        ],
      })
    );
    expect(result.missing[0].term).toBe('Kubernetes');
  });

  it('scores a posting with no keywords as 100, not 0', () => {
    // Nothing to miss. Reporting a failure would blame the candidate for a vague
    // posting.
    const result = scoreKeywordAlignment(strongProfile(), jd());
    expect(result.score).toBe(100);
  });
});

// -----------------------------------------------------------------------------
// Knockouts
// -----------------------------------------------------------------------------

describe('totalExperienceMonths', () => {
  it('sums non-overlapping roles', () => {
    const profile: ResumeProfile = {
      ...emptyProfile(),
      experience: [
        role({ startDate: date(2022, 1), endDate: date(2022, 12) }),
        role({ startDate: date(2024, 1), endDate: date(2024, 12) }),
      ],
    };
    expect(totalExperienceMonths(profile, NOW)).toBe(22);
  });

  it('MERGES overlapping roles instead of double-counting them', () => {
    // Students routinely hold a part-time role and an internship at once. Summing
    // would credit twice the calendar time actually worked, then compare that
    // against a posting's "2+ years" and produce a confidently wrong verdict.
    const profile: ResumeProfile = {
      ...emptyProfile(),
      experience: [
        role({ startDate: date(2024, 1), endDate: date(2024, 12) }),
        role({ startDate: date(2024, 6), endDate: date(2024, 12) }),
      ],
    };
    expect(totalExperienceMonths(profile, NOW)).toBe(11);
  });

  it('treats a current role as running to now', () => {
    const profile: ResumeProfile = {
      ...emptyProfile(),
      experience: [
        role({ startDate: date(2026, 2), endDate: null, isCurrent: true }),
      ],
    };
    // Feb 2026 to Aug 2026.
    expect(totalExperienceMonths(profile, NOW)).toBe(6);
  });

  it('skips roles whose dates could not be parsed', () => {
    const profile: ResumeProfile = {
      ...emptyProfile(),
      experience: [role({ startDate: { raw: 'garbled', year: null, month: null } })],
    };
    expect(totalExperienceMonths(profile, NOW)).toBe(0);
  });

  it('ignores a role whose dates run backwards', () => {
    const profile: ResumeProfile = {
      ...emptyProfile(),
      experience: [role({ startDate: date(2025, 1), endDate: date(2023, 1) })],
    };
    expect(totalExperienceMonths(profile, NOW)).toBe(0);
  });
});

describe('highestDegreeRank', () => {
  it('recognises a dotted Indian degree abbreviation', () => {
    // 'B.Tech' normalises to 'b tech', which never matches the key 'btech'
    // unless the compacted form is also checked. This is the most common degree
    // on the target market's resumes.
    expect(highestDegreeRank(strongProfile())).toBe(2);
  });

  it('recognises a spelled-out degree', () => {
    const profile: ResumeProfile = {
      ...emptyProfile(),
      education: [
        {
          institution: 'X',
          degree: 'Bachelor of Technology',
          field: 'CS',
          startDate: null,
          endDate: null,
          score: null,
        },
      ],
    };
    expect(highestDegreeRank(profile)).toBe(2);
  });

  it('takes the highest of several', () => {
    const profile: ResumeProfile = {
      ...emptyProfile(),
      education: [
        { institution: 'X', degree: 'B.Tech', field: null, startDate: null, endDate: null, score: null },
        { institution: 'Y', degree: 'M.Tech', field: null, startDate: null, endDate: null, score: null },
      ],
    };
    expect(highestDegreeRank(profile)).toBe(3);
  });

  it('returns 0 when no degree is recognisable', () => {
    expect(highestDegreeRank(emptyProfile())).toBe(0);
  });
});

describe('scoreKnockoutRisk', () => {
  it('reports 100 when the posting states no gates', () => {
    const result = scoreKnockoutRisk(strongProfile(), jd(), NOW);
    expect(result.score).toBe(100);
    expect(result.warnings).toEqual([]);
  });

  it('does not warn when experience clears the bar', () => {
    const result = scoreKnockoutRisk(
      strongProfile(),
      jd({
        knockouts: [
          { kind: 'years_experience', requirement: '0+ years', minYears: 0 },
        ],
      }),
      NOW
    );
    expect(result.warnings).toEqual([]);
  });

  it('calls a large experience shortfall blocking', () => {
    const result = scoreKnockoutRisk(
      strongProfile(),
      jd({
        knockouts: [
          { kind: 'years_experience', requirement: '5+ years', minYears: 5 },
        ],
      }),
      NOW
    );
    expect(result.warnings[0].severity).toBe('blocking');
    expect(result.score).toBe(50);
  });

  it('treats a near miss as worth applying to anyway', () => {
    // Postings overstate this and recruiters flex by about a year. Telling a
    // candidate six months short not to apply would be bad advice.
    const result = scoreKnockoutRisk(
      strongProfile(),
      jd({
        knockouts: [
          { kind: 'years_experience', requirement: '1+ years', minYears: 1 },
        ],
      }),
      NOW
    );
    expect(result.warnings[0].severity).toBe('likely');
    expect(result.warnings[0].note).toMatch(/worth applying/i);
  });

  it('blames unreadable dates rather than the candidate when none parse', () => {
    const undated: ResumeProfile = {
      ...strongProfile(),
      experience: [
        role({ startDate: { raw: '??', year: null, month: null }, endDate: null }),
      ],
    };
    const result = scoreKnockoutRisk(
      undated,
      jd({
        knockouts: [
          { kind: 'years_experience', requirement: '2+ years', minYears: 2 },
        ],
      }),
      NOW
    );
    expect(result.warnings[0].note).toMatch(/dates are written plainly/i);
  });

  it('warns on a location mismatch', () => {
    const result = scoreKnockoutRisk(
      strongProfile(),
      jd({
        location: 'Bengaluru, Karnataka',
        knockouts: [
          { kind: 'location', requirement: 'Based in Bengaluru', minYears: null },
        ],
      }),
      NOW
    );
    expect(result.warnings[0].severity).toBe('likely');
    expect(result.warnings[0].note).toMatch(/relocate/i);
  });

  it('suppresses the location gate for a remote role', () => {
    const result = scoreKnockoutRisk(
      strongProfile(),
      jd({
        isRemote: true,
        location: 'Bengaluru',
        knockouts: [
          { kind: 'location', requirement: 'Based in Bengaluru', minYears: null },
        ],
      }),
      NOW
    );
    expect(result.warnings).toEqual([]);
  });

  it('matches a city against a fuller location string', () => {
    const bengaluruCandidate: ResumeProfile = {
      ...strongProfile(),
      contact: { ...strongProfile().contact, location: 'Bengaluru' },
    };
    const result = scoreKnockoutRisk(
      bengaluruCandidate,
      jd({
        location: 'Bengaluru, Karnataka',
        knockouts: [
          { kind: 'location', requirement: 'Based in Bengaluru', minYears: null },
        ],
      }),
      NOW
    );
    expect(result.warnings).toEqual([]);
  });

  it('reports work authorisation as unclear rather than a failing', () => {
    // A resume is not where this is stated, and its absence says nothing about
    // the candidate.
    const result = scoreKnockoutRisk(
      strongProfile(),
      jd({
        knockouts: [
          {
            kind: 'work_authorisation',
            requirement: 'Must have the right to work in the UK',
            minYears: null,
          },
        ],
      }),
      NOW
    );
    expect(result.warnings[0].severity).toBe('unclear');
    expect(result.score).toBe(92);
  });

  it('accepts a higher degree than the posting asks for', () => {
    const masters: ResumeProfile = {
      ...emptyProfile(),
      education: [
        { institution: 'X', degree: 'M.Tech', field: 'CS', startDate: null, endDate: null, score: null },
      ],
    };
    const result = scoreKnockoutRisk(
      masters,
      jd({
        knockouts: [
          { kind: 'degree', requirement: "Bachelor's degree required", minYears: null },
        ],
      }),
      NOW
    );
    expect(result.warnings).toEqual([]);
  });

  it('tells a current student to state an expected completion date', () => {
    const result = scoreKnockoutRisk(
      emptyProfile(),
      jd({
        knockouts: [
          { kind: 'degree', requirement: "Bachelor's degree required", minYears: null },
        ],
      }),
      NOW
    );
    expect(result.warnings[0].severity).toBe('unclear');
    expect(result.warnings[0].note).toMatch(/expected/i);
  });

  it('lists the most severe warning first', () => {
    const result = scoreKnockoutRisk(
      strongProfile(),
      jd({
        knockouts: [
          { kind: 'work_authorisation', requirement: 'Right to work', minYears: null },
          { kind: 'years_experience', requirement: '8+ years', minYears: 8 },
        ],
      }),
      NOW
    );
    expect(result.warnings[0].severity).toBe('blocking');
  });

  it('never reports a negative score', () => {
    const result = scoreKnockoutRisk(
      emptyProfile(),
      jd({
        knockouts: Array.from({ length: 6 }, () => ({
          kind: 'years_experience',
          requirement: '10+ years',
          minYears: 10,
        })),
      }),
      NOW
    );
    expect(result.score).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Requirement coverage
// -----------------------------------------------------------------------------

describe('requirementTerms', () => {
  it('prefers the terms extraction supplied', () => {
    expect(
      requirementTerms({
        text: 'Strong experience with React and TypeScript',
        kind: 'must',
        terms: ['React', 'TypeScript'],
      })
    ).toEqual(['react', 'typescript']);
  });

  it('filters junk out of SUPPLIED terms, not just mined ones', () => {
    // This exact term list is real output from openai/gpt-oss-120b for the line
    // "Required: strong Python, PostgreSQL, REST API design." Three real skills
    // plus 'design'. Other requirements in the same response yielded
    // 'experience', 'essential' and 'degree'. Trusting the model's list verbatim
    // counted every one of those against the candidate.
    const terms = requirementTerms({
      text: 'Strong Python, PostgreSQL, REST API design.',
      kind: 'must',
      terms: ['Python', 'PostgreSQL', 'REST', 'API', 'design'],
    });

    expect(terms).toContain('python');
    expect(terms).toContain('postgresql');
    expect(terms).toContain('rest');
    // 'API' survives as a term but canonicalises onto 'rest' downstream.
    expect(terms).not.toContain('experience');
  });

  it('keeps a requirement met despite one unmatchable term', () => {
    // Live output for the Python requirement included 'Python-first' — a real
    // phrase from the posting that no resume will ever contain. All-or-nothing
    // matching downgraded a genuinely met requirement to partial over it.
    const result = scoreRequirementCoverage(
      strongProfile(),
      jd({
        requirements: [
          {
            text: 'Python experience is essential; we are a Python-first shop',
            kind: 'must',
            terms: ['Python', 'essential', 'Python-first'],
          },
        ],
      })
    );

    // 'essential' is filtered; 'python' matches in a bullet; 'python-first' does
    // not. 1 of 2 is below the ratio, so this lands on partial rather than met —
    // but it must not be 'missing', and the credit must not be zero.
    expect(result.matches[0].status).not.toBe('missing');
    expect(result.score).toBeGreaterThan(0);
  });

  it('counts a three-term requirement as met when two of three match', () => {
    const result = scoreRequirementCoverage(
      strongProfile(),
      jd({
        requirements: [
          {
            text: 'Python, PostgreSQL and Terraform',
            kind: 'must',
            terms: ['Python', 'PostgreSQL', 'Terraform'],
          },
        ],
      })
    );
    // 2/3 = 0.67 clears MET_TERM_RATIO, and both matches are in bullets.
    expect(result.matches[0].status).toBe('met');
  });

  it('still requires both terms of a two-term requirement', () => {
    const result = scoreRequirementCoverage(
      strongProfile(),
      jd({
        requirements: [
          {
            text: 'Python and Terraform',
            kind: 'must',
            terms: ['Python', 'Terraform'],
          },
        ],
      })
    );
    // 1/2 = 0.5 falls short: missing one of two named technologies is a genuine
    // partial, not noise.
    expect(result.matches[0].status).toBe('partial');
  });

  it('mines the requirement text when no terms were supplied', () => {
    // Excluding un-termed requirements would shrink the denominator and inflate
    // the score, so there is always a fallback.
    const terms = requirementTerms({
      text: 'Strong experience with Kubernetes in production',
      kind: 'must',
      terms: [],
    });
    expect(terms).toContain('kubernetes');
    expect(terms).toContain('production');
    // Filler carries no signal and must not become a matchable term.
    expect(terms).not.toContain('experience');
    expect(terms).not.toContain('with');
    expect(terms).not.toContain('strong');
  });
});

describe('scoreRequirementCoverage', () => {
  it('marks a requirement evidenced in a bullet as met', () => {
    const result = scoreRequirementCoverage(
      strongProfile(),
      jd({
        requirements: [
          { text: 'Experience with Redis', kind: 'must', terms: ['Redis'] },
        ],
      })
    );
    expect(result.matches[0].status).toBe('met');
    expect(result.matches[0].evidenceBulletIds).toEqual(['exp.0.0']);
    expect(result.score).toBe(100);
  });

  it('marks a skill that is only listed as partial, not met', () => {
    // The main defence against a resume listing forty technologies and
    // demonstrating none. Listed is a claim; a bullet is proof.
    const listedOnly: ResumeProfile = {
      ...strongProfile(),
      skills: [skill('Kubernetes')],
    };
    const result = scoreRequirementCoverage(
      listedOnly,
      jd({
        requirements: [
          { text: 'Experience with Kubernetes', kind: 'must', terms: ['Kubernetes'] },
        ],
      })
    );
    expect(result.matches[0].status).toBe('partial');
    expect(result.matches[0].note).toMatch(/skills list but no bullet/i);
    expect(result.score).toBe(50);
  });

  it('marks an unevidenced requirement as missing and lists it as a real gap', () => {
    const result = scoreRequirementCoverage(
      strongProfile(),
      jd({
        requirements: [
          { text: 'Experience with Kubernetes', kind: 'must', terms: ['Kubernetes'] },
        ],
      })
    );
    expect(result.matches[0].status).toBe('missing');
    expect(result.genuineGaps).toEqual(['Experience with Kubernetes']);
    expect(result.score).toBe(0);
  });

  it('does not put a missing PREFERENCE in the genuine-gaps list', () => {
    const result = scoreRequirementCoverage(
      strongProfile(),
      jd({
        requirements: [
          { text: 'Nice to have: Kubernetes', kind: 'nice', terms: ['Kubernetes'] },
        ],
      })
    );
    expect(result.matches[0].status).toBe('missing');
    expect(result.genuineGaps).toEqual([]);
  });

  it('weights a required item above a preferred one', () => {
    const profile = strongProfile();
    const missingMust = scoreRequirementCoverage(
      profile,
      jd({
        requirements: [
          { text: 'Kubernetes', kind: 'must', terms: ['Kubernetes'] },
          { text: 'Redis', kind: 'nice', terms: ['Redis'] },
        ],
      })
    );
    const missingNice = scoreRequirementCoverage(
      profile,
      jd({
        requirements: [
          { text: 'Redis', kind: 'must', terms: ['Redis'] },
          { text: 'Kubernetes', kind: 'nice', terms: ['Kubernetes'] },
        ],
      })
    );
    expect(missingNice.score).toBeGreaterThan(missingMust.score);
  });

  it('excludes an unassessable requirement from the arithmetic and says so', () => {
    const result = scoreRequirementCoverage(
      strongProfile(),
      jd({
        requirements: [
          { text: 'A strong team player with good skills', kind: 'must', terms: [] },
          { text: 'Redis', kind: 'must', terms: ['Redis'] },
        ],
      })
    );
    // The vague one is reported but not scored; the concrete one carries the score.
    expect(result.score).toBe(100);
    const vague = result.matches.find((m) => m.text.startsWith('A strong'));
    expect(vague?.note).toMatch(/too generally to check/i);
  });

  it('leads with what actually costs the interview', () => {
    const result = scoreRequirementCoverage(
      strongProfile(),
      jd({
        requirements: [
          { text: 'Redis', kind: 'must', terms: ['Redis'] },
          { text: 'Kubernetes', kind: 'must', terms: ['Kubernetes'] },
        ],
      })
    );
    expect(result.matches[0].status).toBe('missing');
  });

  it('scores a posting with no requirements as 100', () => {
    expect(scoreRequirementCoverage(strongProfile(), jd()).score).toBe(100);
  });
});

// -----------------------------------------------------------------------------
// Orchestrator
// -----------------------------------------------------------------------------

describe('scoreResumeAgainstJob', () => {
  const realisticJd = () =>
    jd({
      jobTitle: 'Backend Engineer',
      company: 'Acme',
      location: 'Noida',
      requirements: [
        { text: 'Experience with Python', kind: 'must', terms: ['Python'] },
        { text: 'Experience with PostgreSQL', kind: 'must', terms: ['PostgreSQL'] },
        { text: 'Nice to have: Kubernetes', kind: 'nice', terms: ['Kubernetes'] },
      ],
      keywords: [
        { term: 'Python', count: 4 },
        { term: 'PostgreSQL', count: 2 },
        { term: 'Kubernetes', count: 1 },
      ],
    });

  it('produces all five sub-scores and a coherent overall', () => {
    const result = scoreResumeAgainstJob({
      profile: strongProfile(),
      jd: realisticJd(),
      parse: assessment(),
      now: NOW,
    });

    expect(Object.keys(result.subScores).sort()).toEqual([
      'evidenceQuality',
      'keywordAlignment',
      'knockoutRisk',
      'parseIntegrity',
      'requirementCoverage',
    ]);
    for (const value of Object.values(result.subScores)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(result.overallScore).toBeGreaterThan(70);
    expect(result.weightsVersion).toBe(1);
  });

  it('carries the parse integrity through from the assessment', () => {
    const result = scoreResumeAgainstJob({
      profile: strongProfile(),
      jd: realisticJd(),
      parse: assessment({ parseIntegrity: 80, warnings: ['columned'] }),
      now: NOW,
    });
    expect(result.subScores.parseIntegrity).toBe(80);
    // Restated in the report so a stored scan survives the resume's expiry.
    expect(result.report.parseWarnings).toEqual(['columned']);
  });

  it('REFUSES to score an unreadable document rather than returning a low score', () => {
    // A low score and an unreadable file are different outcomes needing different
    // screens. Scoring a mangled parse would grade text the candidate never wrote.
    expect(() =>
      scoreResumeAgainstJob({
        profile: strongProfile(),
        jd: realisticJd(),
        parse: assessment({
          scannable: false,
          parseIntegrity: 30,
          warnings: ['no selectable text'],
        }),
        now: NOW,
      })
    ).toThrow(ParseGateError);
  });

  it('carries the file diagnosis on the refusal', () => {
    try {
      scoreResumeAgainstJob({
        profile: strongProfile(),
        jd: realisticJd(),
        parse: assessment({
          scannable: false,
          parseIntegrity: 30,
          warnings: ['no selectable text'],
        }),
        now: NOW,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseGateError);
      const gate = err as ParseGateError;
      expect(gate.code).toBe('parse_quality_too_low');
      expect(gate.parseIntegrity).toBe(30);
      expect(gate.warnings).toEqual(['no selectable text']);
    }
  });

  it('is deterministic — identical inputs give an identical score', () => {
    // The property that makes the number trustworthy, and the reason scoring is
    // arithmetic rather than a prompt.
    const args = {
      profile: strongProfile(),
      jd: realisticJd(),
      parse: assessment(),
      now: NOW,
    };
    const first = scoreResumeAgainstJob(args);
    const second = scoreResumeAgainstJob(args);
    expect(second).toEqual(first);
  });

  it('leaves the rewrite empty — scoring does not depend on it', () => {
    const result = scoreResumeAgainstJob({
      profile: strongProfile(),
      jd: realisticJd(),
      parse: assessment(),
      now: NOW,
    });
    expect(result.report.rewrite).toEqual([]);
    expect(result.report.schemaVersion).toBe(1);
  });

  it('scores a weak resume below a strong one against the same posting', () => {
    const weak: ResumeProfile = {
      ...emptyProfile(),
      contact: { ...strongProfile().contact },
      experience: [
        role({
          bullets: bullets('exp', 0, [
            'Responsible for various backend tasks as assigned',
          ]),
        }),
      ],
    };

    const strongResult = scoreResumeAgainstJob({
      profile: strongProfile(),
      jd: realisticJd(),
      parse: assessment(),
      now: NOW,
    });
    const weakResult = scoreResumeAgainstJob({
      profile: weak,
      jd: realisticJd(),
      parse: assessment(),
      now: NOW,
    });

    expect(weakResult.overallScore).toBeLessThan(strongResult.overallScore);
  });
});
