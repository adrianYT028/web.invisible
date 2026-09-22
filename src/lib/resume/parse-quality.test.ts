import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RawExtraction } from './extraction';
import {
  assessParseQuality,
  countWords,
  detectEncodingDamage,
  findDateCandidates,
  findEmail,
  findPhone,
  findSections,
  isDateUnderstood,
  parseResumeDate,
} from './parse-quality';
import {
  assertWeightsSumToOne,
  clampScore,
  combineSubScores,
  PARSE_INTEGRITY_FLOOR,
  SUB_SCORE_WEIGHTS,
  type SubScoreKey,
} from './scoring/weights';

// -----------------------------------------------------------------------------
// Parse-quality gate tests
//
// This module carries 25% of the headline Match Score and runs before any
// inference, so it is tested from plain strings with no PDF fixtures and no
// library in the import graph — which is the whole reason the extraction seam
// splits "what only a parser knows" (RawExtraction) from "what is derived from
// text" (ParseDiagnostics).
// -----------------------------------------------------------------------------

/**
 * A realistic, well-formed student resume: single column, plain headings,
 * unambiguous dates, contact details as body text. Everything the gate is
 * looking for is present, so it should score 100 with no warnings.
 */
const CLEAN_RESUME = `Aarav Sharma
Noida, Uttar Pradesh
aarav.sharma@example.com
+91 98765 43210
github.com/aaravsharma

SUMMARY

Final-year computer science student with internship experience building
production web services. Comfortable across the stack and happiest close to
data and performance work.

EXPERIENCE

Backend Engineering Intern, Zenpay Technologies
Bengaluru, India
Jan 2024 - Jun 2024
Rebuilt the payment reconciliation job in Python, cutting the nightly run
Reduced median API latency from 420 ms to 180 ms with a Redis cache layer
Wrote integration tests covering the refund path, raising coverage to 78
Shipped an internal dashboard used by the support team every day

Software Engineering Intern, Lumen Analytics
Remote
May 2023 - Aug 2023
Built an ingestion pipeline in Node handling roughly 2 million events a day
Migrated a reporting service from MongoDB to PostgreSQL with no downtime
Automated a manual weekly report, saving the analytics team six hours

PROJECTS

Ledgerly, a double-entry bookkeeping API
Designed a Postgres schema enforcing balanced entries with constraints
Wrote property-based tests generating random transaction sequences

EDUCATION

Bachelor of Technology, Computer Science
Amity University, Noida
2021 - 2025
8.4 CGPA

SKILLS

Python, TypeScript, Node, PostgreSQL, Redis, Docker, React, Git`;

/** Build a `RawExtraction` for a body of text, defaulting to a clean parse. */
function raw(
  text: string,
  overrides: Partial<RawExtraction> = {}
): RawExtraction {
  return {
    text,
    pageCount: 1,
    pages: [{ pageNumber: 1, text, hasImages: false }],
    hasTextLayer: true,
    columnLayoutSuspected: false,
    tablesDetected: false,
    engine: 'test',
    ...overrides,
  };
}

// -----------------------------------------------------------------------------

describe('assessParseQuality — the clean baseline', () => {
  it('gives a well-formed resume a perfect score and no warnings', () => {
    const result = assessParseQuality(raw(CLEAN_RESUME));

    expect(result.parseIntegrity).toBe(100);
    expect(result.scannable).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('reports the diagnostics that drive the score', () => {
    const { diagnostics } = assessParseQuality(raw(CLEAN_RESUME));

    expect(diagnostics.hasTextLayer).toBe(true);
    expect(diagnostics.hasEmail).toBe(true);
    expect(diagnostics.hasPhone).toBe(true);
    expect(diagnostics.encodingDamageSuspected).toBe(false);
    expect(diagnostics.headingsMissing).toEqual([]);
    expect(diagnostics.imageOnlyPages).toEqual([]);
    // Every date in the fixture is written unambiguously.
    expect(diagnostics.datesParsed).toBe(diagnostics.datesFound);
    expect(diagnostics.wordCount).toBeGreaterThan(150);
  });

  it('identifies all four standard sections', () => {
    const { diagnostics } = assessParseQuality(raw(CLEAN_RESUME));

    expect([...diagnostics.headingsFound].sort()).toEqual([
      'education',
      'experience',
      'projects',
      'skills',
    ]);
  });
});

describe('assessParseQuality — fatal conditions short-circuit', () => {
  it('scores a scanned document 0 and refuses to scan it', () => {
    const result = assessParseQuality(
      raw(CLEAN_RESUME, {
        hasTextLayer: false,
        pages: [{ pageNumber: 1, text: '', hasImages: true }],
      })
    );

    expect(result.parseIntegrity).toBe(0);
    expect(result.scannable).toBe(false);
  });

  it('says only the one thing that matters for a scan, not every finding', () => {
    // A scanned photo of a resume has no headings, no email, and no dates. If
    // those were all reported the user would have to dig for the single
    // actionable cause, so the fatal path emits exactly one warning.
    const result = assessParseQuality(
      raw('', {
        hasTextLayer: false,
        pages: [{ pageNumber: 1, text: '', hasImages: true }],
      })
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/no selectable text/i);
  });

  it('refuses a document that extracted almost nothing', () => {
    const result = assessParseQuality(raw('Aarav Sharma\nSoftware Engineer'));

    expect(result.parseIntegrity).toBe(5);
    expect(result.scannable).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/characters could be extracted/i);
  });
});

describe('assessParseQuality — layout deductions', () => {
  it('penalises a suspected column layout and names the fix', () => {
    const clean = assessParseQuality(raw(CLEAN_RESUME));
    const columned = assessParseQuality(
      raw(CLEAN_RESUME, { columnLayoutSuspected: true })
    );

    expect(columned.parseIntegrity).toBeLessThan(clean.parseIntegrity);
    expect(columned.warnings.join(' ')).toMatch(/single-column/i);
  });

  it('penalises tables', () => {
    const clean = assessParseQuality(raw(CLEAN_RESUME));
    const tabular = assessParseQuality(
      raw(CLEAN_RESUME, { tablesDetected: true })
    );

    expect(tabular.parseIntegrity).toBeLessThan(clean.parseIntegrity);
    expect(tabular.warnings.join(' ')).toMatch(/tables/i);
  });

  it('flags image-only pages by number and ignores pages that have text', () => {
    const result = assessParseQuality(
      raw(CLEAN_RESUME, {
        pageCount: 3,
        pages: [
          { pageNumber: 1, text: CLEAN_RESUME, hasImages: true },
          { pageNumber: 2, text: '   ', hasImages: true },
          { pageNumber: 3, text: '', hasImages: false },
        ],
      })
    );

    // Page 1 has images AND text (a logo) — not a scan. Page 3 has neither, so
    // there is nothing to report. Only page 2 is a picture standing in for text.
    expect(result.diagnostics.imageOnlyPages).toEqual([2]);
    expect(result.warnings.join(' ')).toMatch(/Page 2/);
  });

  it('caps the image-only penalty so one defect cannot zero the score alone', () => {
    const manyPages = Array.from({ length: 10 }, (_, i) => ({
      pageNumber: i + 1,
      text: '',
      hasImages: true,
    }));
    const result = assessParseQuality(
      raw(CLEAN_RESUME, { pageCount: 10, pages: manyPages })
    );

    // 10 pages x 20 would be -200; the cap holds it to -40.
    expect(result.parseIntegrity).toBe(60);
  });
});

describe('assessParseQuality — section deductions', () => {
  it('penalises a missing Education heading', () => {
    const withoutEducation = CLEAN_RESUME.replace('EDUCATION', 'ACADEMIC STUFF');
    const result = assessParseQuality(raw(withoutEducation));

    expect(result.diagnostics.headingsMissing).toContain('education');
    expect(result.warnings.join(' ')).toMatch(/Education heading/i);
  });

  it('accepts a student resume with Projects but no Experience', () => {
    // A first-year student with no job history is not a broken document, so
    // experience and projects are scored as a pair.
    const projectsOnly = CLEAN_RESUME.replace('EXPERIENCE', 'ROLES I HELD');
    const result = assessParseQuality(raw(projectsOnly));

    expect(result.diagnostics.headingsMissing).not.toContain('experience');
    expect(result.warnings.join(' ')).not.toMatch(/Projects heading/i);
  });

  it('penalises losing both Experience and Projects', () => {
    const neither = CLEAN_RESUME.replace('EXPERIENCE', 'STUFF').replace(
      'PROJECTS',
      'THINGS'
    );
    const result = assessParseQuality(raw(neither));

    expect(result.diagnostics.headingsMissing).toContain('experience');
    expect(result.warnings.join(' ')).toMatch(/Experience nor a Projects/i);
  });
});

describe('assessParseQuality — contact deductions', () => {
  it('warns when no email survived extraction, and explains why', () => {
    const noEmail = CLEAN_RESUME.replace('aarav.sharma@example.com', '');
    const result = assessParseQuality(raw(noEmail));

    expect(result.diagnostics.hasEmail).toBe(false);
    // The likely cause is a header or text box, not a missing address, and the
    // consequence is that a recruiter cannot make contact. Both are said.
    expect(result.warnings.join(' ')).toMatch(/text box|header/i);
  });

  it('warns when no phone number survived extraction', () => {
    const noPhone = CLEAN_RESUME.replace('+91 98765 43210', '');
    const result = assessParseQuality(raw(noPhone));

    expect(result.diagnostics.hasPhone).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/phone number/i);
  });
});

describe('assessParseQuality — the scan gate', () => {
  it('refuses to score once accumulated damage crosses the floor', () => {
    const damaged = CLEAN_RESUME.replace('aarav.sharma@example.com', '').replace(
      '+91 98765 43210',
      ''
    );
    const result = assessParseQuality(
      raw(damaged, { columnLayoutSuspected: true, tablesDetected: true })
    );

    // -20 column, -12 tables, -10 email, -5 phone = 53, under the floor of 55.
    expect(result.parseIntegrity).toBeLessThan(PARSE_INTEGRITY_FLOOR);
    expect(result.scannable).toBe(false);
  });

  it('still scans a resume with one significant but survivable defect', () => {
    const result = assessParseQuality(
      raw(CLEAN_RESUME, { columnLayoutSuspected: true })
    );

    expect(result.scannable).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// -----------------------------------------------------------------------------
// Detectors
// -----------------------------------------------------------------------------

describe('detectEncodingDamage', () => {
  it('accepts ordinary text', () => {
    expect(detectEncodingDamage(CLEAN_RESUME)).toBe(false);
  });

  it('catches the Unicode replacement character', () => {
    expect(detectEncodingDamage('Experience \uFFFD\uFFFD Python')).toBe(true);
  });

  it('catches pdfminer cid fallbacks from fonts with no character map', () => {
    expect(detectEncodingDamage('(cid:82)(cid:101)sume')).toBe(true);
  });

  it('catches letter-spaced text, which destroys every keyword match', () => {
    expect(
      detectEncodingDamage('E X P E R I E N C E and E D U C A T I O N and S K I L L S')
    ).toBe(true);
  });

  it('tolerates a couple of single letters in a list', () => {
    // 'a b c' style enumerations are legitimate; damage means several runs.
    expect(detectEncodingDamage('Grades: a b c d in three subjects')).toBe(false);
  });
});

describe('findEmail / findPhone', () => {
  it('finds an email address', () => {
    expect(findEmail('reach me at aarav.sharma@example.co.in please')).toBe(
      'aarav.sharma@example.co.in'
    );
  });

  it('returns null when there is no email', () => {
    expect(findEmail('no address here')).toBeNull();
  });

  it.each([
    ['+91 98765 43210', 'with country code and spaces'],
    ['+919876543210', 'with country code, no spaces'],
    ['9876543210', 'bare ten digits'],
    ['98765-43210', 'hyphenated'],
  ])('finds the Indian mobile %s (%s)', (input) => {
    expect(findPhone(`Call ${input} anytime`)).not.toBeNull();
  });

  it('does not mistake a year or a CGPA for a phone number', () => {
    expect(findPhone('2021 - 2025, 8.4 CGPA, 78% coverage')).toBeNull();
  });
});

describe('findSections', () => {
  it('reads a heading on its own line', () => {
    expect(findSections('EXPERIENCE\nsomething')).toEqual(['experience']);
  });

  it('reads a decorated heading', () => {
    expect(findSections('--- Education ---')).toEqual(['education']);
  });

  it('reads a compound heading', () => {
    expect(findSections('Work Experience & Internships')).toEqual(['experience']);
  });

  it('does not mistake prose for a heading', () => {
    // The critical negative case: if a summary sentence registered as a section,
    // a resume whose real headings were lost to extraction would look intact.
    expect(
      findSections(
        'I have extensive experience in Python and a strong education record'
      )
    ).toEqual([]);
  });

  it('does not treat a job title containing "intern" as an Experience heading', () => {
    expect(findSections('Software Engineering Intern, Lumen Analytics')).toEqual(
      []
    );
  });
});

describe('parseResumeDate', () => {
  it.each([
    ['Jan 2024', 2024, 1],
    ['January 2024', 2024, 1],
    ['Sept. 2023', 2023, 9],
    ['Sep 2023', 2023, 9],
    ['March 2023', 2023, 3],
    ["Jan '24", 2024, 1],
    ['01/2024', 2024, 1],
    ['12-2023', 2023, 12],
    ['2021', 2021, null],
  ])('parses %s', (input, year, month) => {
    const parsed = parseResumeDate(input);
    expect(parsed.year).toBe(year);
    expect(parsed.month).toBe(month);
  });

  it('always preserves the raw string verbatim', () => {
    // The raw form is the only evidence of what the document actually said.
    expect(parseResumeDate('  Sept. 2023  ').raw).toBe('Sept. 2023');
    expect(parseResumeDate('garbled').raw).toBe('garbled');
  });

  it('recovers the year from a full numeric date but refuses to guess the month', () => {
    // 12/03/2024 is either 12 March or 3 December depending on region, and the
    // document does not say which. Guessing would mis-date a role by months.
    const parsed = parseResumeDate('12/03/2024');
    expect(parsed.year).toBe(2024);
    expect(parsed.month).toBeNull();
  });

  it('treats an open-ended marker as understood but valueless', () => {
    const parsed = parseResumeDate('Present');
    expect(parsed.year).toBeNull();
    // Counting 'Present' as a failure would penalise every current job.
    expect(isDateUnderstood('Present')).toBe(true);
  });

  it('leaves an ambiguous two-digit year unparsed', () => {
    expect(parseResumeDate('01/24').year).toBeNull();
    expect(isDateUnderstood('01/24')).toBe(false);
  });
});

describe('findDateCandidates', () => {
  it('finds every date in the clean fixture and understands them all', () => {
    const candidates = findDateCandidates(CLEAN_RESUME);
    expect(candidates.length).toBeGreaterThanOrEqual(6);
    expect(candidates.every(isDateUnderstood)).toBe(true);
  });

  it('prefers the specific numeric form over the ambiguous one', () => {
    // Alternation is leftmost-first, so '01/2024' must not be consumed as the
    // MM/YY form and then reported as unreadable.
    expect(findDateCandidates('01/2024')).toEqual(['01/2024']);
    expect(isDateUnderstood('01/2024')).toBe(true);
  });

  it('drives the dangling-dates warning when dates are ambiguous', () => {
    const ambiguous = CLEAN_RESUME.replace('Jan 2024 - Jun 2024', '01/24 - 06/24')
      .replace('May 2023 - Aug 2023', '05/23 - 08/23')
      .replace('2021 - 2025', '09/21 - 06/25');
    const result = assessParseQuality(raw(ambiguous));

    expect(result.diagnostics.datesParsed).toBeLessThan(
      result.diagnostics.datesFound
    );
    expect(result.warnings.join(' ')).toMatch(/dates could be read/i);
  });
});

describe('countWords', () => {
  it('counts whitespace-separated tokens', () => {
    expect(countWords('one two  three\nfour')).toBe(4);
  });

  it('counts empty and whitespace-only text as zero', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t ')).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Invariants
// -----------------------------------------------------------------------------

describe('scoring weights', () => {
  it('sums to exactly 1', () => {
    expect(() => assertWeightsSumToOne()).not.toThrow();
  });

  it('weights Parse Integrity highest', () => {
    // Deliberate: it is the only deterministic sub-score, and it measures a real
    // mechanical failure rather than a judgement about fit. Every other score is
    // computed from the text it validates.
    const others = Object.entries(SUB_SCORE_WEIGHTS)
      .filter(([key]) => key !== 'parseIntegrity')
      .map(([, weight]) => weight);
    expect(SUB_SCORE_WEIGHTS.parseIntegrity).toBeGreaterThanOrEqual(
      Math.max(...others) - 0.05
    );
  });

  it('maps a perfect scorecard to 100 and an empty one to 0', () => {
    const keys = Object.keys(SUB_SCORE_WEIGHTS) as SubScoreKey[];
    const all = (v: number) =>
      Object.fromEntries(keys.map((k) => [k, v])) as Record<SubScoreKey, number>;

    expect(combineSubScores(all(100))).toBe(100);
    expect(combineSubScores(all(0))).toBe(0);
  });

  it('maps NaN to 0 rather than propagating it into a CHECK violation', () => {
    // An empty requirement list divides by zero; the database would reject NaN
    // and the user would see a failed scan instead of a slightly wrong number.
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe('parse integrity invariants', () => {
  it('is always an integer within the range the database accepts', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (text, hasTextLayer, columnLayoutSuspected, tablesDetected) => {
          const result = assessParseQuality(
            raw(text, { hasTextLayer, columnLayoutSuspected, tablesDetected })
          );
          expect(Number.isInteger(result.parseIntegrity)).toBe(true);
          expect(result.parseIntegrity).toBeGreaterThanOrEqual(0);
          expect(result.parseIntegrity).toBeLessThanOrEqual(100);
        }
      ),
      { numRuns: 200 }
    );
  });

  it('never rewards an additional defect', () => {
    // Monotonicity. Without it, a tweak to the deduction table could make a
    // worse document score higher, which is the one bug that would destroy
    // trust in the number entirely.
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (column, tables) => {
        const better = assessParseQuality(
          raw(CLEAN_RESUME, {
            columnLayoutSuspected: column,
            tablesDetected: tables,
          })
        );
        const worse = assessParseQuality(
          raw(CLEAN_RESUME, {
            columnLayoutSuspected: true,
            tablesDetected: true,
          })
        );
        expect(worse.parseIntegrity).toBeLessThanOrEqual(better.parseIntegrity);
      }),
      { numRuns: 50 }
    );
  });

  it('keeps `scannable` consistent with the floor', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 4000 }), (text) => {
        const result = assessParseQuality(raw(text));
        expect(result.scannable).toBe(
          result.parseIntegrity >= PARSE_INTEGRITY_FLOOR
        );
      }),
      { numRuns: 200 }
    );
  });
});
