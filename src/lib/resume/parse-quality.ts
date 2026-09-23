// -----------------------------------------------------------------------------
// Parse-quality gate — deterministic, AI-free, and the first thing that runs
// -----------------------------------------------------------------------------
//
// Answers one question about an uploaded resume: did this document survive being
// read? Below `PARSE_INTEGRITY_FLOOR` the pipeline stops here and the user is
// told what is wrong with their file, because every downstream score is computed
// from `text` — so scoring a mangled extraction means grading words the
// candidate never wrote and returning a confident number for them.
//
// Everything in this module is a pure function of `RawExtraction`. No model, no
// network, no database, no PDF library in the import graph. That is why it can be
// tested exhaustively from plain strings, which is what a sub-score carrying 25%
// of the headline number deserves.
//
// Two references worth keeping in mind while editing the deductions:
//   - A PDF stores characters and their positions, not words or paragraphs.
//     Column layouts are therefore a reading-order problem, and commercial
//     parsing vendors put them at roughly 15% of all CVs.
//   - Published resume-NER results run about 99% F1 on clean text and about 69%
//     on noisy extracted text. The cliff between "clean" and "noisy" is exactly
//     what this module measures.

import type { RawExtraction, ExtractionAssessment } from './extraction';
import type { ParseDiagnostics, ResumeDate } from './schema';
import {
  clampScore,
  EXPECTED_SECTIONS,
  PARSE_INTEGRITY_FLOOR,
  type ExpectedSectionKey,
} from './scoring/weights';

// -----------------------------------------------------------------------------
// Thresholds
// -----------------------------------------------------------------------------

/**
 * Below this many characters, extraction did not meaningfully succeed. A real
 * one-page resume runs 1,500-4,000 characters; 200 is the level where what came
 * back is a header fragment, not a document.
 */
const MIN_VIABLE_CHARS = 200;

/** Below this word count the document is too thin to score honestly. */
const THIN_WORD_COUNT = 150;

/**
 * Minimum share of date-like strings that must resolve to a year before dates
 * are considered intact. Applied only when there are enough candidates for the
 * ratio to mean anything (see `MIN_DATES_FOR_RATIO`).
 */
const DATE_PARSE_RATIO_FLOOR = 0.5;
const MIN_DATES_FOR_RATIO = 2;

/**
 * Deduction table. Every penalty is named and lives here so the score can be
 * explained to a user — and audited by us — rather than emerging from constants
 * scattered through the logic.
 */
const PENALTY = {
  /** Per page that is an image with no text. Capped below. */
  imageOnlyPage: 20,
  imageOnlyPageCap: 40,
  /** Reading order is at risk; the single most common real-world defect. */
  columnLayout: 20,
  /** Cell order is frequently mangled by extraction. */
  tables: 12,
  /** Glyph soup: ligature/encoding damage or letter-spaced text. */
  encodingDamage: 25,
  /** No identifiable Education heading. */
  missingEducation: 12,
  /**
   * Neither Experience nor Projects could be identified. Scored as a pair
   * because a student with no jobs yet legitimately leads with projects, and
   * penalising each separately would mark a normal student resume as broken.
   */
  missingExperienceAndProjects: 12,
  /** Dates present but mostly unparseable — usually mangled by extraction. */
  danglingDates: 10,
  /** No email recoverable. Often the header was lost to a text box. */
  noEmail: 10,
  noPhone: 5,
  /** Too little text to assess. */
  thinContent: 15,
} as const;

// -----------------------------------------------------------------------------
// Detectors (exported for testing)
// -----------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * Date-like strings on a resume, in document order.
 *
 * Broad by design: the point is to find everything a human would read as a date
 * so that `parseResumeDate` can then reveal how many are actually recoverable.
 * A narrow pattern would hide exactly the damage this is looking for.
 */
export function findDateCandidates(text: string): string[] {
  // ORDER MATTERS. JavaScript alternation is leftmost-first, not longest-match:
  // at any position the first alternative that matches wins. The more specific
  // numeric forms must therefore precede the shorter ones, or '01/2024' would be
  // consumed as the ambiguous 'MM/YY' form and misreported as unparseable.
  const pattern = new RegExp(
    [
      // 'Jan 2024', 'January '24', 'Sept. 2023'
      String.raw`\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*'?\d{2,4}`,
      // Full numeric date: '12/03/2024', '12-03-24'. Day/month order is
      // unknowable, but the year is recoverable.
      String.raw`\b\d{1,2}\s*[/\-.]\s*\d{1,2}\s*[/\-.]\s*\d{2,4}\b`,
      // 'MM/YYYY': '01/2024', '1-2024', '01.2024'
      String.raw`\b\d{1,2}\s*[/\-.]\s*(?:19|20)\d{2}\b`,
      // 'MM/YY': '01/24'. Genuinely ambiguous — this is the form that fails to
      // parse and earns the dangling-dates warning.
      String.raw`\b\d{1,2}\s*[/\-.]\s*\d{2}\b`,
      // A bare year
      String.raw`\b(?:19|20)\d{2}\b`,
      // Open-ended tenure
      String.raw`\b(?:present|current|ongoing|till date|to date)\b`,
    ].join('|'),
    'gi'
  );
  return text.match(pattern) ?? [];
}

/**
 * Resolve a date-like string to a `ResumeDate`.
 *
 * `raw` is always preserved verbatim; `year` and `month` are best-effort and
 * `null` when unrecoverable. Shared with the structured-extraction step so the
 * profile and the diagnostics can never disagree about what a date meant.
 *
 * An open-ended marker ('Present') is a valid, fully-understood date with no
 * numeric value — so it counts as parsed. Treating it as a failure would
 * penalise every resume with a current job.
 */
export function parseResumeDate(raw: string): ResumeDate {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  if (/^(present|current|ongoing|till date|to date)$/.test(lower)) {
    return { raw: trimmed, year: null, month: null };
  }

  // 'Jan 2024' / "January '24"
  const monthName = lower.match(
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*'?(\d{2,4})$/
  );
  if (monthName) {
    const month = MONTHS[monthName[1]] ?? null;
    return { raw: trimmed, year: expandYear(monthName[2]), month };
  }

  // '01/2024'
  const numeric = lower.match(/^(\d{1,2})\s*[/\-.]\s*((?:19|20)\d{2})$/);
  if (numeric) {
    const month = Number(numeric[1]);
    return {
      raw: trimmed,
      year: Number(numeric[2]),
      month: month >= 1 && month <= 12 ? month : null,
    };
  }

  // Full numeric date: '12/03/2024'. The year is recoverable; the month is not,
  // because day/month order is a regional convention the document does not
  // state. Guessing it would silently mis-date a role by up to eleven months,
  // so `month` stays null and the date still counts as understood.
  const full = lower.match(
    /^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*((?:19|20)\d{2})$/
  );
  if (full) return { raw: trimmed, year: Number(full[3]), month: null };

  // Bare year
  const bare = lower.match(/^((?:19|20)\d{2})$/);
  if (bare) return { raw: trimmed, year: Number(bare[1]), month: null };

  // Anything else — notably 'MM/YY' and 'DD/MM/YY' — is left unparsed. A
  // two-digit year on a resume is ambiguous enough that inventing a century
  // would be worse than reporting that we could not read it.
  return { raw: trimmed, year: null, month: null };
}

/**
 * Whether a date-like string was understood.
 *
 * Open-ended markers count: they carry no year but their meaning is unambiguous.
 */
export function isDateUnderstood(raw: string): boolean {
  if (/^(present|current|ongoing|till date|to date)$/i.test(raw.trim())) {
    return true;
  }
  return parseResumeDate(raw).year !== null;
}

/** Two-digit years become 20xx. Resume dates are not from the 1920s. */
function expandYear(value: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (value.length === 4) return n;
  if (value.length === 2) return 2000 + n;
  return null;
}

/**
 * Which expected sections are identifiable in the text.
 *
 * Only short lines are considered: a heading is a line, not a phrase buried in a
 * sentence. Without that constraint, "I have experience in Python" inside a
 * summary would register as an Experience section and mask the fact that
 * extraction lost the real headings.
 */
export function findSections(text: string): ExpectedSectionKey[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    // Headings are short. 60 chars is generous enough for 'PROFESSIONAL
    // EXPERIENCE & INTERNSHIPS' while excluding prose.
    .filter((line) => line.length > 0 && line.length <= 60)
    .map((line) =>
      line
        .toLowerCase()
        // Strip decoration: 'EXPERIENCE:', '— Experience —', '## Experience'
        .replace(/[^a-z&\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );

  const found = new Set<ExpectedSectionKey>();
  for (const line of lines) {
    for (const [key, aliases] of Object.entries(EXPECTED_SECTIONS) as [
      ExpectedSectionKey,
      readonly string[],
    ][]) {
      if (found.has(key)) continue;
      // The line must BE the heading, not merely contain the word. An alias may
      // be padded by connectives ('work experience & internships') which the
      // decoration strip above has already flattened to spaces.
      if (aliases.some((alias) => line === alias || isHeadingWithAlias(line, alias))) {
        found.add(key);
      }
    }
  }
  return [...found];
}

/**
 * A heading line that contains an alias plus only connective filler.
 *
 * Accepts 'work experience & internships' and 'technical skills' while rejecting
 * 'experience with distributed systems at scale' — the difference being whether
 * what surrounds the alias is structural or substantive.
 */
function isHeadingWithAlias(line: string, alias: string): boolean {
  if (!line.includes(alias)) return false;
  const remainder = line.replace(alias, ' ').replace(/\s+/g, ' ').trim();
  if (remainder.length === 0) return true;
  const filler = new Set([
    'and', '&', 'work', 'professional', 'technical', 'academic', 'relevant',
    'other', 'additional', 'internships', 'internship', 'projects', 'history',
    'details', 'background', 'summary', 'core', 'key',
  ]);
  return remainder.split(' ').every((word) => filler.has(word));
}

/**
 * Glyph-level damage from extraction.
 *
 * Three distinct signatures, any one of which means the text is untrustworthy:
 *   - U+FFFD, the replacement character: bytes that could not be decoded.
 *   - `(cid:NN)`: pdfminer-style output for a font with no usable character map.
 *     Common in resumes exported by design tools.
 *   - Letter-spaced runs ('R e s u m e'): the extractor recovered glyphs but not
 *     word boundaries, so every keyword match downstream would fail.
 */
export function detectEncodingDamage(text: string): boolean {
  if (text.includes('\uFFFD')) return true;
  if (/\(cid:\d+\)/.test(text)) return true;

  // Four or more consecutive single letters separated by single spaces. A few
  // are legitimate ('a b c' in a list), so require several occurrences.
  const spacedRuns = text.match(/\b(?:[A-Za-z]\s){3,}[A-Za-z]\b/g) ?? [];
  return spacedRuns.length >= 3;
}

/** An email address, if the text still contains one. */
export function findEmail(text: string): string | null {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
}

/**
 * A phone number, if the text still contains one.
 *
 * Tuned for the launch market: Indian mobile numbers are ten digits beginning
 * 6-9, usually written with an optional +91 and arbitrary internal spacing. A
 * generic "seven or more digits" pattern would match years, PIN codes, and
 * enrolment numbers, so this stays deliberately specific and accepts a plain
 * international form alongside it.
 */
export function findPhone(text: string): string | null {
  const indian = text.match(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/);
  if (indian) return indian[0];
  const international = text.match(/\+\d{1,3}[\s-]?\d{6,12}\b/);
  return international ? international[0] : null;
}

export function countWords(text: string): number {
  const words = text.trim().match(/\S+/g);
  return words ? words.length : 0;
}

// -----------------------------------------------------------------------------
// The gate
// -----------------------------------------------------------------------------

/**
 * Assess an extraction: diagnostics, Parse Integrity, warnings, and whether the
 * document may proceed to scoring.
 *
 * Deductions from 100 rather than points awarded toward it, because the baseline
 * expectation is that a resume parses cleanly — most do. A score of 100 means
 * "nothing wrong was detected", which is an honest thing to say, whereas points
 * awarded for present features would quietly punish unusual-but-fine resumes.
 */
export function assessParseQuality(raw: RawExtraction): ExtractionAssessment {
  const text = raw.text ?? '';
  const charCount = text.length;
  const wordCount = countWords(text);

  const imageOnlyPages = raw.pages
    .filter((page) => page.hasImages && countWords(page.text) === 0)
    .map((page) => page.pageNumber);

  const dateCandidates = findDateCandidates(text);
  const datesParsed = dateCandidates.filter(isDateUnderstood).length;

  const sectionsFound = findSections(text);
  const missingRequired: ExpectedSectionKey[] = [];
  if (!sectionsFound.includes('education')) missingRequired.push('education');
  if (
    !sectionsFound.includes('experience') &&
    !sectionsFound.includes('projects')
  ) {
    missingRequired.push('experience');
  }

  const email = findEmail(text);
  const phone = findPhone(text);

  const diagnostics: ParseDiagnostics = {
    hasTextLayer: raw.hasTextLayer,
    imageOnlyPages,
    columnLayoutSuspected: raw.columnLayoutSuspected,
    tablesDetected: raw.tablesDetected,
    headingsFound: sectionsFound,
    headingsMissing: missingRequired,
    datesFound: dateCandidates.length,
    datesParsed,
    charCount,
    wordCount,
    encodingDamageSuspected: detectEncodingDamage(text),
    hasEmail: email !== null,
    hasPhone: phone !== null,
    // `?? undefined`, not `?? 1`. The diagnostics blob is persisted and read back
    // by `warningsFromDiagnostics`, which guards on `typeof === 'number'` — so
    // omitting the field means "unknown" and correctly produces no page-based
    // advice, whereas defaulting it to 1 would assert a page count we do not have
    // and is exactly the bug this replaced.
    pagesRead: raw.pageCount ?? undefined,
    pagesInDocument: raw.pagesInDocument,
  };

  // --- Fatal conditions ------------------------------------------------------
  // Short-circuited rather than folded into the deduction table: when there is
  // no usable text, the other findings are not merely bad, they are meaningless.
  // Emitting "no Education heading found" for a scanned photograph of a resume
  // would bury the one thing the user needs to hear.
  //
  // The warning TEXT for every case now comes from `warningsFromDiagnostics`,
  // which derives it from the diagnostics alone. This function keeps the
  // arithmetic; that one owns the words. They used to be interleaved in the same
  // `if` blocks, which meant the advice could only ever be produced at the moment
  // of extraction — so a re-upload and a stored report both showed a score with
  // no explanation.

  if (!raw.hasTextLayer) {
    return {
      raw,
      diagnostics,
      parseIntegrity: 0,
      scannable: false,
      warnings: warningsFromDiagnostics(diagnostics),
    };
  }

  if (charCount < MIN_VIABLE_CHARS) {
    return {
      raw,
      diagnostics,
      parseIntegrity: 5,
      scannable: false,
      warnings: warningsFromDiagnostics(diagnostics),
    };
  }

  // --- Deductions ------------------------------------------------------------
  //
  // Conditions here MUST mirror `warningsFromDiagnostics`, or a score would move
  // without a warning explaining it. Both read from the same `diagnostics` object
  // for exactly that reason, and a property test asserts the two agree.

  let score = 100;

  if (diagnostics.encodingDamageSuspected) {
    score -= PENALTY.encodingDamage;
  }

  if (imageOnlyPages.length > 0) {
    score -= Math.min(
      imageOnlyPages.length * PENALTY.imageOnlyPage,
      PENALTY.imageOnlyPageCap
    );
  }

  if (diagnostics.columnLayoutSuspected) {
    score -= PENALTY.columnLayout;
  }

  if (diagnostics.tablesDetected) {
    score -= PENALTY.tables;
  }

  if (missingRequired.includes('education')) {
    score -= PENALTY.missingEducation;
  }

  if (missingRequired.includes('experience')) {
    score -= PENALTY.missingExperienceAndProjects;
  }

  if (
    dateCandidates.length >= MIN_DATES_FOR_RATIO &&
    datesParsed / dateCandidates.length < DATE_PARSE_RATIO_FLOOR
  ) {
    score -= PENALTY.danglingDates;
  }

  if (!diagnostics.hasEmail) {
    score -= PENALTY.noEmail;
  }

  if (!diagnostics.hasPhone) {
    score -= PENALTY.noPhone;
  }

  // Truncation is NOT penalised. The pages that were read are intact, so there is
  // no extraction defect to deduct for — but it is warned about, because otherwise
  // a long document's unread pages surface only as the thin-content deduction
  // below, which reads as "your resume is sparse" when the truth is "we stopped
  // reading". Those need opposite responses from the user.

  if (wordCount < THIN_WORD_COUNT) {
    score -= PENALTY.thinContent;
  }

  const parseIntegrity = Math.round(clampScore(score));

  return {
    raw,
    diagnostics,
    parseIntegrity,
    scannable: parseIntegrity >= PARSE_INTEGRITY_FLOOR,
    warnings: warningsFromDiagnostics(diagnostics),
  };
}

/** The truncation warning, shared by both callers. */
function truncationWarning(pagesRead: number, pagesInDocument: number): string {
  return `Only the first ${pagesRead} of ${pagesInDocument} pages were read, so anything after that was not assessed. A resume this long is also unlikely to be read in full by a recruiter — consider cutting it to one or two pages.`;
}

/**
 * Rebuild the user-facing warnings from stored diagnostics alone.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The advice used to be generated inline while scoring, which meant it existed
 * only in the response to the original upload. Two places were left showing a
 * score with no explanation:
 *
 *   - Re-uploading the same file hit the idempotency path, which returned
 *     `warnings: []`. The user saw a number and nothing to fix, while a
 *     first-time upload of identical bytes listed every problem.
 *   - `resume_scans.report.parseWarnings` was written as `[]`, despite the schema
 *     promising a stored scan stays self-contained after the 90-day retention
 *     window deletes the resume it came from.
 *
 * `ParseDiagnostics` already contained everything needed to say it again. Now
 * this function is the only place the words live, and both paths call it.
 *
 * Order is most to least severe, matching the deduction order in
 * `assessParseQuality`.
 */
export function warningsFromDiagnostics(
  diagnostics: ParseDiagnostics
): string[] {
  const d = diagnostics;

  // Fatal cases return alone: when there is no usable text, listing missing
  // headings buries the one thing that matters.
  if (!d.hasTextLayer) {
    return [
      'This file has no selectable text — it looks like a scan or an exported image. An applicant tracking system reads text, not pictures, so it would extract nothing at all from this. Export or save your resume as a text-based PDF (from Word, Google Docs, or your resume builder) rather than scanning or screenshotting it.',
    ];
  }

  if (d.charCount < MIN_VIABLE_CHARS) {
    return [
      `Only ${d.charCount} characters could be extracted from this file, which is far less than a real resume contains. The text is probably locked inside images, text boxes, or a layout the parser cannot follow. Try exporting a fresh PDF from a simple single-column template.`,
    ];
  }

  const warnings: string[] = [];

  if (d.encodingDamageSuspected) {
    warnings.push(
      'The extracted text is damaged — characters are being lost or spaced apart in a way that breaks words. This usually means the PDF embeds fonts without a usable character map. Re-export it from the original document, or save it as a DOCX and upload that instead.'
    );
  }

  const imageOnly = d.imageOnlyPages ?? [];
  if (imageOnly.length > 0) {
    warnings.push(
      `Page${imageOnly.length > 1 ? 's' : ''} ${imageOnly.join(', ')} contain${imageOnly.length > 1 ? '' : 's'} images but no readable text. Anything written there is invisible to a parser.`
    );
  }

  if (d.columnLayoutSuspected) {
    warnings.push(
      'This looks like a multi-column layout. A PDF stores character positions, not reading order, so a parser often interleaves the columns and turns your resume into scrambled sentences. A single-column layout is the single highest-value change you can make to this file.'
    );
  }

  if (d.tablesDetected) {
    warnings.push(
      'Tables were detected. Parsers frequently read table cells out of order, which can attach the wrong dates to the wrong roles. Consider replacing tables with plain headings and bullet points.'
    );
  }

  const missing = d.headingsMissing ?? [];
  if (missing.includes('education')) {
    warnings.push(
      'No Education heading could be identified. Either it is missing, or its formatting stopped it being recognised as a section heading. Use a plain, bold heading on its own line.'
    );
  }

  if (missing.includes('experience')) {
    warnings.push(
      'Neither an Experience nor a Projects heading could be identified. One of the two needs to be present and recognisable — if you have no work history yet, a clearly headed Projects section is the right place to show your evidence.'
    );
  }

  if (
    d.datesFound >= MIN_DATES_FOR_RATIO &&
    d.datesParsed / d.datesFound < DATE_PARSE_RATIO_FLOOR
  ) {
    warnings.push(
      `Only ${d.datesParsed} of ${d.datesFound} dates could be read properly. Unreadable dates mean a recruiter's filters cannot work out how long you spent anywhere. Write them plainly, as "Jan 2024 – Jun 2024".`
    );
  }

  if (!d.hasEmail) {
    warnings.push(
      'No email address could be found in the extracted text. Either it is missing, or it sits inside a header, text box, or graphic that the parser cannot read — which would leave a recruiter with no way to contact you. Put it as plain text in the body of the document.'
    );
  }

  if (!d.hasPhone) {
    warnings.push(
      'No phone number could be found in the extracted text. If you have included one, it may be trapped in a header or image.'
    );
  }

  if (
    typeof d.pagesInDocument === 'number' &&
    typeof d.pagesRead === 'number' &&
    d.pagesInDocument > d.pagesRead
  ) {
    warnings.push(truncationWarning(d.pagesRead, d.pagesInDocument));
  }

  if (d.wordCount < THIN_WORD_COUNT) {
    warnings.push(
      `Only ${d.wordCount} words were extracted. That is thin for a resume — either the document is very sparse, or part of it did not come through.`
    );
  }

  return warnings;
}
