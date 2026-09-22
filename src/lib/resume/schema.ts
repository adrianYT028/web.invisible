// -----------------------------------------------------------------------------
// Persisted resume shapes — the contract between extraction, scoring, and the UI
// -----------------------------------------------------------------------------
//
// This module owns every JSON shape that reaches the database (migration 011):
// `resumes.diagnostics`, `resumes.profile`, and `resume_scans.report`. Nothing
// else may define them, because a jsonb column with two competing TypeScript
// definitions is a silent data corruption waiting for its first schema change.
//
// `ResumeProfile` is the load-bearing type of the whole platform. Job matching,
// cold-mail drafting, and interview prep are all views over it rather than
// separate parses of the same PDF — that shared derivation is the reason those
// features belong in one product. Adding a field here is cheap; changing the
// meaning of an existing one is not, so it is versioned.

/**
 * Bump when `ResumeProfile` changes in a way that makes an older stored profile
 * misinterpretable. Written to `resumes.profile_schema_version` on every row, so
 * a reader can always tell which shape it is holding.
 *
 * Additive optional fields do NOT require a bump. Renaming, removing, or
 * changing the units/meaning of a field does.
 */
export const PROFILE_SCHEMA_VERSION = 1;

/** Bump when `MatchReport` changes shape. Stored per scan alongside the scores. */
export const REPORT_SCHEMA_VERSION = 1;

// -----------------------------------------------------------------------------
// Primitives
// -----------------------------------------------------------------------------

/**
 * A date on a resume, which is very often not a date.
 *
 * Resumes carry "Jan 2024", "01/2024", "Winter 2023", "2023-present" and worse.
 * Normalising to a bare `Date` throws away the only evidence of what the
 * document actually said, and guessing a month in order to satisfy a type is how
 * a tenure calculation silently gains or loses six months.
 *
 * So `raw` is preserved verbatim and always populated; `year` and `month` are
 * best-effort. A consumer computing durations MUST handle `year === null` rather
 * than defaulting it — an unparsed date is a fact about the resume worth
 * surfacing to the user, not a value to invent.
 */
export interface ResumeDate {
  /** Exactly as it appeared in the document. */
  raw: string;
  /** Four-digit year, or null when unparseable. */
  year: number | null;
  /** 1-12, or null when absent or unparseable. */
  month: number | null;
}

/**
 * One bullet point, individually addressable.
 *
 * `id` exists so the rewrite step can return "here is a better version of bullet
 * exp.2.1" and the UI can render a side-by-side diff. Without stable ids the
 * rewrite can only be delivered as a wall of replacement text, which gives the
 * user no way to accept one suggestion and reject another.
 */
export interface ResumeBullet {
  /** Stable within a profile, e.g. `exp.0.2` or `proj.1.0`. */
  id: string;
  text: string;
}

export interface ResumeLink {
  /** e.g. 'github', 'linkedin', 'portfolio', 'other'. */
  kind: string;
  url: string;
}

// -----------------------------------------------------------------------------
// Profile
// -----------------------------------------------------------------------------

/**
 * Contact block.
 *
 * Every field is nullable on purpose. A missing phone number is a finding to
 * report, not a parse failure to throw on — and for a student user base, some of
 * these are absent legitimately.
 */
export interface ResumeContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** Free text as written, e.g. 'Noida, Uttar Pradesh'. */
  location: string | null;
  links: ResumeLink[];
}

/**
 * A skill as claimed by the resume.
 *
 * `normalised` is the deduplication key: "React.js", "ReactJS" and "React" are
 * one skill, and keyword scoring that treats them as three punishes the
 * candidate for spelling. `evidenceBulletIds` records where the skill is
 * actually demonstrated rather than merely listed — the difference between a
 * skills-section keyword and a claim backed by work, which is exactly what
 * Evidence Quality scores.
 */
export interface ResumeSkill {
  /** As written in the document. */
  name: string;
  /** Lowercased canonical form used for matching. */
  normalised: string;
  /** e.g. 'language', 'framework', 'tool', 'soft', 'domain'. */
  category: string | null;
  /** Bullet ids demonstrating this skill. Empty = listed but not evidenced. */
  evidenceBulletIds: string[];
}

export interface ResumeRole {
  title: string | null;
  company: string | null;
  location: string | null;
  startDate: ResumeDate | null;
  endDate: ResumeDate | null;
  /** True for "Present"/"Current" end dates. */
  isCurrent: boolean;
  bullets: ResumeBullet[];
}

export interface ResumeEducation {
  institution: string | null;
  /** e.g. 'B.Tech', 'B.E.', 'Class XII'. */
  degree: string | null;
  field: string | null;
  startDate: ResumeDate | null;
  endDate: ResumeDate | null;
  /**
   * Verbatim, e.g. '8.4 CGPA' or '82%'. Not normalised to a number: Indian
   * resumes mix CGPA out of 10, percentages, and GPA out of 4, and silently
   * coercing them into one scale produces nonsense comparisons.
   */
  score: string | null;
}

export interface ResumeProject {
  name: string | null;
  description: string | null;
  technologies: string[];
  link: string | null;
  bullets: ResumeBullet[];
}

export interface ResumeCertification {
  name: string | null;
  issuer: string | null;
  date: ResumeDate | null;
}

/**
 * The structured profile. Produced once per resume, read by every feature.
 *
 * Arrays are always present, possibly empty. A consumer never has to
 * null-check a collection — the absence of experience is `[]`, which is a fact,
 * not a missing field.
 */
export interface ResumeProfile {
  contact: ResumeContact;
  /** Professional summary / objective, if the resume has one. */
  summary: string | null;
  skills: ResumeSkill[];
  experience: ResumeRole[];
  education: ResumeEducation[];
  projects: ResumeProject[];
  certifications: ResumeCertification[];
  /**
   * Section headings found in the document, in order, as written. Feeds Parse
   * Integrity: a resume whose headings could not be identified is usually a
   * resume whose layout defeated extraction.
   */
  sectionsFound: string[];
}

// -----------------------------------------------------------------------------
// Parse diagnostics
// -----------------------------------------------------------------------------

/**
 * Deterministic, AI-free findings about how well the file survived extraction.
 * Stored in `resumes.diagnostics` and scored into Parse Integrity.
 *
 * This is the highest-weighted sub-score, for two reasons. It is the only part
 * of the pipeline measuring a real mechanical failure — a PDF has no concept of
 * paragraphs or even words, only characters and their positions, so a column
 * layout is not two text streams but a pile of coordinates that happen to look
 * like columns when drawn. And published resume-NER results drop from ~99% F1 on
 * clean text to ~69% on noisy extracted text, which means every downstream score
 * computed on a bad parse is fiction delivered with a confident number.
 */
export interface ParseDiagnostics {
  /** False for a scanned/image-only PDF: nothing to extract without OCR. */
  hasTextLayer: boolean;
  /** Pages (1-based) that appear to be images with no selectable text. */
  imageOnlyPages: number[];
  /**
   * Multi-column layout suspected. Commercial parsing vendors estimate at least
   * ~15% of CVs use one, and handling it properly is a computer-vision problem
   * rather than a text problem — so this is a warning to the user about a real
   * risk, not a claim that extraction definitely failed.
   */
  columnLayoutSuspected: boolean;
  /** Tabular structure detected. Cell order is frequently mangled. */
  tablesDetected: boolean;
  /** Recognised standard headings, e.g. ['experience', 'education']. */
  headingsFound: string[];
  /**
   * Expected headings that were not found. A resume with no identifiable
   * Experience or Education heading reads as unstructured text to a parser.
   */
  headingsMissing: string[];
  /** Date-like strings found, and how many were parseable. */
  datesFound: number;
  datesParsed: number;
  /** Characters of extracted text. Very low = extraction effectively failed. */
  charCount: number;
  /** Words of extracted text. */
  wordCount: number;
  /** Extraction produced glyph soup (ligature/encoding damage). */
  encodingDamageSuspected: boolean;
  /** Contact essentials recoverable from the text. */
  hasEmail: boolean;
  hasPhone: boolean;
  /**
   * Pages actually read, and the count the document claims.
   *
   * Recorded so the diagnostics are SELF-DESCRIBING: `warningsFromDiagnostics`
   * rebuilds the user-facing advice from this object alone, long after the file
   * itself has been deleted by the 90-day retention window. Without these two, a
   * truncated read is indistinguishable from a short document, and the stored
   * report could not explain a warning it had originally shown.
   *
   * Optional because rows written before this field existed do not carry it.
   */
  pagesRead?: number;
  pagesInDocument?: number;
}

// -----------------------------------------------------------------------------
// Parsed job description
// -----------------------------------------------------------------------------
//
// The other half of a scan. Produced from pasted job text by the extraction step,
// then consumed by scoring.
//
// THE DIVISION OF LABOUR THAT MAKES THIS TESTABLE: a language model turns prose
// into these structures, and nothing more. Every score is then computed from
// `ResumeProfile` + `ParsedJobDescription` by pure functions. Asking a model to
// output "78/100" instead would give a number that changes between identical
// runs, cannot be explained to the user, and cannot be regression-tested. Keeping
// the model on extraction and the arithmetic in code means a scan is reproducible
// and every point of the score has a reason attached.

/** Bump when `ParsedJobDescription` changes shape. */
export const JD_SCHEMA_VERSION = 1;

/**
 * One requirement lifted from the posting.
 *
 * `terms` is what scoring actually matches on — the canonical skill tokens the
 * requirement implies. "Strong experience with React and TypeScript" carries
 * terms `['react', 'typescript']`, so the match does not depend on the resume
 * echoing the sentence.
 */
export interface JdRequirement {
  /** The requirement as the posting states it. */
  text: string;
  /** Whether the posting frames it as required or preferred. */
  kind: 'must' | 'nice';
  /** Canonical terms (via `normaliseTerm`) this requirement implies. */
  terms: string[];
}

/**
 * A hard gate declared by the posting.
 *
 * These are the conditions that genuinely auto-reject an application, as opposed
 * to the resume score, which affects the order a recruiter reviews candidates.
 * Keeping them separate is why `knockoutRisk` is its own sub-score.
 */
export interface JdKnockout {
  /** e.g. 'work_authorisation', 'location', 'years_experience', 'degree'. */
  kind: string;
  /** What the posting demands, in its own words. */
  requirement: string;
  /** For `years_experience`, the stated minimum. Null when not numeric. */
  minYears: number | null;
}

export interface ParsedJobDescription {
  schemaVersion: number;
  jobTitle: string | null;
  company: string | null;
  location: string | null;
  /** True when the posting says remote. Suppresses location knockouts. */
  isRemote: boolean;
  requirements: JdRequirement[];
  knockouts: JdKnockout[];
  /**
   * Skill terms the posting mentions, with how often.
   *
   * Frequency is a weighting signal, not a keyword-stuffing target: a term the
   * posting repeats five times is more central to the role than one mentioned in
   * passing. Recruiters search on job titles, hard skills, and location, so those
   * are what belong here.
   */
  keywords: { term: string; count: number }[];
}

/** An empty job description. Extraction fallback and test fixture base. */
export function emptyJobDescription(): ParsedJobDescription {
  return {
    schemaVersion: JD_SCHEMA_VERSION,
    jobTitle: null,
    company: null,
    location: null,
    isRemote: false,
    requirements: [],
    knockouts: [],
    keywords: [],
  };
}

// -----------------------------------------------------------------------------
// Match report
// -----------------------------------------------------------------------------

/** How well one job requirement is evidenced by the resume. */
export type RequirementStatus = 'met' | 'partial' | 'missing';

export interface RequirementMatch {
  /** The requirement as stated in the job description. */
  text: string;
  /** Whether the posting frames it as required or preferred. */
  kind: 'must' | 'nice';
  status: RequirementStatus;
  /**
   * Where the resume evidences it. Non-empty for 'met'. This is what makes the
   * report auditable rather than an opaque verdict — the user can see the
   * reasoning and disagree with it.
   */
  evidenceBulletIds: string[];
  /** One line explaining the status, shown in the report. */
  note: string | null;
}

/**
 * A genuine auto-rejection risk.
 *
 * These are the only conditions that actually reject an application without a
 * human involved: knockout questions on the form, where the employer sets a
 * disqualifying answer. Ranking by resume score affects the order a recruiter
 * works through candidates; it does not reject them. Keeping knockouts as their
 * own sub-score preserves that distinction instead of burying a hard gate inside
 * a keyword percentage.
 */
export interface KnockoutWarning {
  /** e.g. 'work_authorisation', 'location', 'years_experience', 'degree'. */
  kind: string;
  /** What the posting demands. */
  requirement: string;
  /** What the resume shows, or null when it says nothing. */
  resumeStates: string | null;
  severity: 'blocking' | 'likely' | 'unclear';
  note: string;
}

export interface KeywordMatch {
  /** Canonical skill/term. */
  term: string;
  /** Appears in the JD this many times. */
  jdCount: number;
  /** Appears in the resume this many times. */
  resumeCount: number;
  /** Matched via synonym/normalisation rather than an exact string hit. */
  viaSynonym: boolean;
}

export interface BulletFeedback {
  bulletId: string;
  /** Contains a concrete number, percentage, or scale figure. */
  isQuantified: boolean;
  /** Opens with a strong action verb rather than 'Responsible for'. */
  hasActionVerb: boolean;
  /** Describes an outcome rather than a duty. */
  describesOutcome: boolean;
  /** Shown to the user. Null when the bullet needs no comment. */
  note: string | null;
}

/**
 * A proposed replacement for one existing bullet.
 *
 * HARD PRODUCT CONSTRAINT: a rewrite may only rephrase, reframe, or sharpen
 * content already present in `sourceBulletId`. It must never introduce a skill,
 * employer, metric, date, or outcome the resume did not already claim. A student
 * who walks into an interview defending an achievement we invented for them is
 * the worst outcome this product can produce, and it is not recoverable by an
 * apology.
 *
 * `addedNoNewFacts` is the model's own assertion that it obeyed. It is not
 * trusted on its own — the scoring layer verifies it — but recording the claim
 * makes a violation detectable after the fact.
 */
export interface RewrittenBullet {
  sourceBulletId: string;
  original: string;
  rewritten: string;
  /** Why this is stronger. Shown next to the diff. */
  rationale: string;
  addedNoNewFacts: boolean;
}

/**
 * The full report for one resume x job description scan.
 *
 * Stored in `resume_scans.report`. The five numeric sub-scores live in their own
 * columns rather than in here, so they can be queried and trended without
 * unpacking jsonb.
 */
export interface MatchReport {
  schemaVersion: number;
  requirements: RequirementMatch[];
  knockouts: KnockoutWarning[];
  keywords: {
    matched: KeywordMatch[];
    missing: KeywordMatch[];
  };
  bulletFeedback: BulletFeedback[];
  rewrite: RewrittenBullet[];
  /**
   * Things the candidate genuinely does not have and should go and acquire.
   *
   * Deliberately separate from `rewrite`: the honest answer to a missing skill
   * is "go build this", not "phrase your resume as though you had it". Merging
   * the two lists is how a resume tool starts coaching people to lie.
   */
  genuineGaps: string[];
  /**
   * Findings from the parse-quality gate, restated for the report so a stored
   * scan is self-contained even after the resume row expires.
   */
  parseWarnings: string[];
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Canonical matching key for a skill or keyword.
 *
 * Lowercases, strips the punctuation that decorates tool names ('React.js',
 * 'Node.js', 'C++' → 'react', 'node', 'c++'), and collapses whitespace. The
 * point is that a candidate is never penalised for writing a technology the way
 * their industry writes it.
 *
 * `+` and `#` survive because they are load-bearing: 'c++' and 'c#' are not 'c'.
 */
export function normaliseTerm(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\.js\b/g, '')
    .replace(/[^a-z0-9+#\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Stable bullet id, e.g. `exp.0.2`. See `ResumeBullet.id`. */
export function bulletId(
  scope: 'exp' | 'proj',
  parentIndex: number,
  bulletIndex: number
): string {
  return `${scope}.${parentIndex}.${bulletIndex}`;
}

/**
 * Every bullet in the profile, in document order.
 *
 * Scoring, feedback, and rewriting all need one flat list; each of them
 * rebuilding it from `experience` and `projects` separately is how the three
 * quietly disagree about which bullets exist.
 */
export function allBullets(profile: ResumeProfile): ResumeBullet[] {
  const out: ResumeBullet[] = [];
  for (const role of profile.experience) out.push(...role.bullets);
  for (const project of profile.projects) out.push(...project.bullets);
  return out;
}

/** An empty profile. Used as the extraction fallback and in tests. */
export function emptyProfile(): ResumeProfile {
  return {
    contact: {
      name: null,
      email: null,
      phone: null,
      location: null,
      links: [],
    },
    summary: null,
    skills: [],
    experience: [],
    education: [],
    projects: [],
    certifications: [],
    sectionsFound: [],
  };
}
