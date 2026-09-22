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
 * Sized so prompt cost lands near 1,200 tokens rather than 3,000. Requirements
 * appear early in essentially every posting, so a hard cap loses little even when
 * the boilerplate strip does not fire.
 */
const MAX_CHARS = 5000;

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

  return chosen.length > MAX_CHARS ? `${chosen.slice(0, MAX_CHARS)}\n[truncated]` : chosen;
}
