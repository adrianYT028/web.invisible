// -----------------------------------------------------------------------------
// Job-description trimming
// -----------------------------------------------------------------------------
//
// Real job descriptions from company boards run 3,000 to 12,000 characters, and
// most of that is boilerplate: a company history, a benefits list, an equal
// opportunity statement, a note about recruiters. The requirements — the only part
// extraction needs — are usually a few hundred characters in the middle.
//
// WHY THIS EXISTS
//   The first live prep run failed on real postings while passing on a short test
//   JD. Two symptoms, one cause:
//
//     resume_jd_extract cost 2,787 and 2,922 tokens against a measured 850
//     two items failed with `truncated` at a 1,200-token output budget
//
//   A 12,000-character posting is roughly 3,000 prompt tokens, and the extractor
//   dutifully produced keywords for the benefits section until it ran out of room.
//   On a per-minute allowance shared with the desktop app, that is what pushed the
//   following rewrite call into a 429.
//
//   So the fix is upstream of the budgets: send less. Cutting boilerplate makes the
//   prompt smaller AND the output smaller, because there is less irrelevant text to
//   extract keywords from.

/**
 * Headings that begin a section extraction does not need.
 *
 * Matched at the start of a line, case-insensitively. Deliberately conservative:
 * cutting a requirement by accident is far worse than leaving boilerplate in, so
 * anything ambiguous ("About the role", "What you'll do") is KEPT — those describe
 * the job.
 */
const DROP_SECTIONS = [
  // A bare `about ` prefix, which catches the real-world form: postings write
  // "About PhonePe Limited:", "About Stripe", not "About us". This is only safe
  // because KEEP_SECTIONS is tested FIRST, so "About the role" and "About this
  // job" survive it.
  'about ',
  'who we are',
  'our story',
  'our mission',
  'our values',
  'why join',
  'why work',
  'life at',
  'benefits',
  'perks',
  'what we offer',
  'compensation and benefits',
  'our commitment',
  'equal opportunity',
  'equal employment',
  'eeo',
  'diversity',
  'accommodation',
  'accessibility',
  'privacy notice',
  'data protection',
  'gdpr',
  'to all recruitment agencies',
  'agency notice',
  'note to recruiters',
  'legal',
  'disclaimer',
];

/**
 * Headings worth keeping even when short — these carry the requirements.
 * Used to stop a drop from swallowing the rest of the document.
 */
const KEEP_SECTIONS = [
  'requirement',
  'qualification',
  'what you',
  'who you are',
  'you will',
  'you have',
  'responsibilit',
  'skills',
  'experience',
  'must have',
  'nice to have',
  'preferred',
  'the role',
  'about the role',
  'about the job',
  'about this role',
  'basic qualification',
  'minimum qualification',
  'preferred qualification',
];

/**
 * Characters kept after trimming.
 *
 * LOWERED FROM 5,000 after measuring where extraction actually fails.
 *
 * The old value was chosen to keep PROMPT cost near 1,200 tokens, which was the
 * wrong thing to size against. The binding constraint is the COMPLETION budget —
 * `MAX_TOKENS = 1300` in extract-jd.ts — and a longer posting produces more
 * requirements, so it produces more JSON. Measured against the live provider
 * (budget-headroom.integration.test.ts):
 *
 *     20 requirements   2,008 chars   OK, 22 extracted
 *     30 requirements   2,978 chars   OK, 32 extracted
 *     45 requirements   4,433 chars   TRUNCATED
 *
 * So the previous 5,000 cap sat ABOVE the point where extraction breaks. A posting
 * that trimmed to 4,500 characters was accepted, sent, and then failed with
 * "too long to analyse in one pass" — after the user's daily scan quota had already
 * been spent.
 *
 * 3,000 is the largest value proven to work. Requirements appear early in
 * essentially every posting, so the tail this removes is the least useful part.
 *
 * CHARACTERS ARE A PROXY, NOT THE REAL LIMIT. What actually drives output size is
 * the NUMBER of requirements, and a terse posting can pack more of them into 3,000
 * characters than the fixture above did. This cap makes truncation rare, not
 * impossible, which is why `MAX_REQUIREMENT_LINES` below bounds the real driver as
 * well. Raise both together, and only after the provider tier is raised — the Groq
 * account allows 8,000 tokens per minute in total, so a bigger budget buys fewer
 * concurrent scans.
 */
const MAX_CHARS = 3000;

/**
 * Most requirement-like lines kept.
 *
 * Bounds the thing the completion budget actually responds to. 32 requirements were
 * extracted successfully in the measurement above, and no real posting lists 40
 * distinct requirements — a document that appears to is almost always repeating
 * itself or has had another section misread as requirements.
 */
const MAX_REQUIREMENT_LINES = 40;

function startsAny(line: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => line.startsWith(p));
}

/**
 * Whether a line looks like a section heading rather than prose.
 *
 * Short, and not ending in sentence punctuation. Without this check a sentence
 * mentioning "benefits" mid-paragraph would truncate the document.
 */
function isHeadingLike(raw: string): boolean {
  const line = raw.trim();
  if (line.length === 0 || line.length > 60) return false;
  return !/[.,;]$/.test(line);
}

/**
 * Drop boilerplate sections and cap the length.
 *
 * Returns the original text when trimming would leave too little to work with —
 * an over-aggressive strip that removes the requirements is worse than a long
 * prompt.
 */
export function trimJobDescription(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let dropping = false;

  for (const line of lines) {
    const normalised = line.trim().toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

    if (isHeadingLike(line) && normalised.length > 0) {
      if (startsAny(normalised, KEEP_SECTIONS)) {
        // A requirements heading always ends a drop, so boilerplate in the middle
        // of a posting cannot swallow what follows it.
        dropping = false;
      } else if (startsAny(normalised, DROP_SECTIONS)) {
        dropping = true;
        continue;
      }
    }

    if (!dropping) kept.push(line);
  }

  const trimmed = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // If the strip removed almost everything, the headings were not what we assumed.
  // Fall back to the original rather than extracting from a fragment.
  const useTrimmed = trimmed.length >= Math.min(400, text.length * 0.25);
  const chosen = useTrimmed ? trimmed : text.trim();

  return capLength(capRequirementLines(chosen));
}

/** A bullet, dash, or numbered line — how a posting lists its requirements. */
function isRequirementLine(line: string): boolean {
  return /^\s*(?:[-*•‣◦·]|\d+[.)])\s+\S/.test(line);
}

/**
 * Keep at most `MAX_REQUIREMENT_LINES` requirement lines, dropping the rest.
 *
 * Bounds the real driver of output size. A character cap alone does not: a posting
 * with fifty terse one-line requirements is well under 3,000 characters and still
 * asks the model for fifty JSON objects.
 *
 * Non-requirement lines are untouched, so the job title, company and section
 * headings all survive — cutting those would cost more than it saves.
 */
function capRequirementLines(text: string): string {
  const lines = text.split('\n');
  let seen = 0;
  const out: string[] = [];
  let dropped = 0;

  for (const line of lines) {
    if (isRequirementLine(line)) {
      seen += 1;
      if (seen > MAX_REQUIREMENT_LINES) {
        dropped += 1;
        continue;
      }
    }
    out.push(line);
  }

  if (dropped === 0) return text;
  // Said explicitly rather than silently, so a reader of the prompt (or of a
  // logged prompt) can tell the difference between a short posting and a cut one.
  return `${out.join('\n')}\n[${dropped} further requirement line(s) omitted]`;
}

/**
 * Cap the length, cutting at a LINE boundary.
 *
 * `slice(0, MAX_CHARS)` cuts mid-word, which hands the model a fragment like
 * "- Strong experience with Postgre". That is worse than dropping the line: the
 * model will faithfully extract a requirement for a technology that does not
 * exist, and the resume then gets scored against it. A half-requirement is a
 * fabricated requirement.
 */
function capLength(text: string): string {
  if (text.length <= MAX_CHARS) return text;

  const hardCut = text.slice(0, MAX_CHARS);
  const lastBreak = hardCut.lastIndexOf('\n');

  // Only honour the line boundary if it does not throw away most of the budget —
  // a single very long line (a posting written as one paragraph) would otherwise
  // be cut to almost nothing.
  const body =
    lastBreak > MAX_CHARS * 0.5 ? hardCut.slice(0, lastBreak) : hardCut.trimEnd();

  return `${body.trimEnd()}\n[truncated]`;
}
