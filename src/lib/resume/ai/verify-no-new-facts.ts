// -----------------------------------------------------------------------------
// Anti-fabrication verifier
// -----------------------------------------------------------------------------
//
// A rewritten bullet may rephrase, reframe, and sharpen. It may NOT introduce a
// number, technology, employer, or outcome the original did not already claim.
//
// `RewrittenBullet.addedNoNewFacts` is the model asserting it obeyed. This module
// exists because that assertion cannot be trusted: the failure mode is a model
// helpfully "improving" a vague bullet into a specific one, and the specific
// version is a lie the candidate then has to defend in an interview. A student
// discovering mid-interview that their resume claims a 40% improvement they never
// measured is the single worst outcome this product can cause, and no apology
// afterwards repairs it.
//
// So every rewrite is checked mechanically and DROPPED if it fails. A dropped
// rewrite costs the user a suggestion. A fabricated one costs them the interview.
//
// WHAT THIS CAN AND CANNOT DO. It catches invented figures and invented named
// technologies, which is where fabrication actually shows up. It cannot judge
// whether a reframing overstates a candidate's role — "supported the migration"
// becoming "led the migration" adds no new token, so no token-level check sees it.
// That limit is why the prompt forbids escalating scope and why the rationale is
// shown to the user for every suggestion: the human is the last check.

import { normaliseTerm, type ResumeProfile } from '../schema';

export interface VerificationResult {
  ok: boolean;
  /** Machine-readable reasons, for logging and tests. */
  violations: string[];
}

/**
 * Bare small integers that can appear in ordinary phrasing without asserting a
 * measurement — "one idempotent pass", "two services".
 *
 * This list ONLY applies to a number with no unit, magnitude word, or symbol
 * attached. That distinction is load-bearing: a naive whitelist containing '2'
 * would wave through "2 million events a day", which is a substantial invented
 * claim whose leading digit merely happens to be small. Innocuousness is a
 * property of the occurrence, not of the digit — hence `isMeasurement` below.
 */
const INNOCUOUS_BARE_INTEGERS = new Set(['0', '1', '2', '3']);

/** Magnitude words that turn a small digit into a large claim. */
const MAGNITUDE = String.raw`k|m|bn|million|billion|thousand|lakh|lakhs|crore|crores`;

/** Units and countable nouns that make a number a measurement. */
const UNITS = String.raw`ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|quarters?|years?|gb|mb|kb|tb|qps|rps|users?|customers?|clients?|students?|records?|rows?|tests?|bugs?|tickets?|members?|people|engineers?|interns?|teams?|projects?|events?|requests?|queries?|pages?|screens?|endpoints?|services?|repos?|commits?|releases?|deployments?`;

/** One number as it occurs in text, with whether it asserts a measurement. */
export interface NumericFact {
  /** Normalised value, so 180 and 180.0 and 2,000 and 2000 compare equal. */
  value: string;
  /** True when a unit, magnitude, percentage, multiplier or currency applies. */
  measurement: boolean;
}

/**
 * Every number in a string, each tagged as a measurement or as bare phrasing.
 *
 * Thousands separators are stripped first so a rewrite that merely reformats a
 * figure ("2,000" to "2000") is not treated as a fabrication.
 */
export function extractNumericFacts(text: string): NumericFact[] {
  const cleaned = text.replace(/(\d),(?=\d{3}\b)/g, '$1');
  const out: NumericFact[] = [];

  for (const match of cleaned.matchAll(/\d+(?:\.\d+)?/g)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const before = cleaned.slice(Math.max(0, index - 12), index);
    const after = cleaned.slice(index + raw.length, index + raw.length + 24);
    out.push({
      value: String(Number(raw)),
      measurement: isMeasurement(before, after),
    });
  }
  return out;
}

/** Whether the text around a number makes it a measured claim. */
function isMeasurement(before: string, after: string): boolean {
  const tail = after.toLowerCase();
  const head = before.toLowerCase();

  // '40%', '40 percent', '2.5pp'
  if (/^\s*(%|percent\b|pp\b)/.test(tail)) return true;
  // '3x', '2.5×'
  if (/^\s*[x×]\b/.test(tail)) return true;
  // '2 million', '50k'
  if (new RegExp(String.raw`^\s*(${MAGNITUDE})\b`).test(tail)) return true;
  // '180 ms', '4 engineers'
  if (new RegExp(String.raw`^\s*(${UNITS})\b`).test(tail)) return true;
  // '₹2.4', '$40', 'Rs 5000'
  if (/(₹|\$|€|£|\brs\.?\s*)$/.test(head)) return true;

  return false;
}

/** Backwards-compatible view: just the normalised values. */
export function extractNumbers(text: string): string[] {
  return extractNumericFacts(text).map((f) => f.value);
}

/**
 * Capitalised tokens that look like named things: technologies, products,
 * employers.
 *
 * SENTENCE-INITIAL WORDS ARE EXEMPT unless they look technology-shaped, and that
 * exemption is not a convenience — without it the verifier defeats the feature.
 * English capitalises the first word of a sentence regardless of whether it is a
 * name, and the rewrite prompt asks every bullet to OPEN WITH A STRONG ACTION
 * VERB. So a good rewrite beginning "Produced the weekly report" was read as
 * introducing a named entity called "Produced" and discarded. That happened on the
 * first live run, rejecting a correct suggestion.
 *
 * Extending a hardcoded verb list would only postpone the same failure for the
 * next unlisted verb. Capitalisation at a sentence boundary carries no information
 * about namehood, so the position is what gets ignored.
 *
 * A sentence-initial token is still checked when its SHAPE marks it as a name:
 * all-caps ('AWS'), containing a digit or symbol ('S3', 'C++', 'Node.js'), or
 * starting a multi-word capitalised run ('Google Cloud went down').
 */
export function extractNamedThings(text: string): string[] {
  const out = new Set<string>();

  for (const m of text.matchAll(
    /\b[A-Z][A-Za-z0-9+#.]*(?:\s+[A-Z][A-Za-z0-9+#.]*)*/g
  )) {
    const token = m[0].trim();
    if (token.length < 2) continue;

    const index = m.index ?? 0;
    if (isSentenceInitial(text, index) && !looksLikeAName(token)) continue;

    out.add(normaliseTerm(token));
  }

  // Lowercase technology spellings a resume commonly uses, where capitalisation
  // gives no signal at all.
  for (const m of text.matchAll(
    /\b(?:node|react|redis|python|java|sql|aws|gcp|api|css|html)\b/gi
  )) {
    out.add(normaliseTerm(m[0]));
  }

  return [...out].filter((t) => t.length > 1);
}

/** Whether a match begins the text or follows sentence-ending punctuation. */
function isSentenceInitial(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd();
  if (before.length === 0) return true;
  return /[.!?;:]$/.test(before);
}

/**
 * Whether a token's shape marks it as a name irrespective of position.
 *
 * Ordinary English words fail all three tests; technology names pass at least one.
 */
function looksLikeAName(token: string): boolean {
  // Multi-word capitalised run: 'Google Cloud'.
  if (/\s/.test(token)) return true;
  // Contains a digit or a symbol: 'S3', 'C++', 'Node.js'.
  if (/[0-9+#.]/.test(token)) return true;
  // All caps beyond a single letter: 'AWS', 'SQL'.
  if (token.length > 1 && token === token.toUpperCase()) return true;
  // Internal capital: 'PostgreSQL', 'MongoDB', 'GitHub'.
  if (/[a-z][A-Z]/.test(token)) return true;
  return false;
}

/**
 * Words too generic to count as a named fact.
 *
 * Without this list every sentence-initial verb registers as a new named entity
 * and nothing ever passes.
 */
const GENERIC_TOKENS = new Set([
  'i', 'a', 'an', 'the', 'and', 'or', 'but', 'for', 'with', 'from', 'to', 'of',
  'in', 'on', 'at', 'by', 'as', 'built', 'created', 'designed', 'developed',
  'implemented', 'launched', 'delivered', 'reduced', 'increased', 'improved',
  'optimised', 'optimized', 'automated', 'migrated', 'refactored', 'wrote',
  'led', 'cut', 'shipped', 'drove', 'grew', 'ran', 'saved', 'rebuilt', 'scaled',
  'analysed', 'analyzed', 'resolved', 'debugged', 'tested', 'documented',
  'mentored', 'coordinated', 'streamlined', 'consolidated', 'integrated',
  'eliminated', 'accelerated', 'established', 'introduced', 'redesigned',
  'team', 'teams', 'service', 'services', 'system', 'systems', 'project',
  'projects', 'data', 'users', 'customers', 'time', 'work', 'new', 'other',
]);

/**
 * Verify a rewrite introduced no facts absent from its source.
 *
 * `profile` widens what counts as already-claimed: a skill the candidate lists
 * elsewhere on the resume is a fact they already assert, so naming it in a bullet
 * is a reframing rather than an invention. A number, by contrast, is only
 * acceptable if it appears in THIS bullet — carrying a figure across from a
 * different role would attribute someone's achievement to the wrong job.
 */
export function verifyNoNewFacts(
  original: string,
  rewritten: string,
  profile: ResumeProfile
): VerificationResult {
  const violations: string[] = [];

  // --- numbers: must come from this bullet -------------------------------
  //
  // A measured figure is only acceptable if THIS bullet already contained it.
  // A bare small integer with no unit attached is ordinary phrasing and passes.
  const originalValues = new Set(extractNumericFacts(original).map((f) => f.value));

  for (const fact of extractNumericFacts(rewritten)) {
    if (originalValues.has(fact.value)) continue;
    if (!fact.measurement && INNOCUOUS_BARE_INTEGERS.has(fact.value)) continue;
    violations.push(`invented_number:${fact.value}`);
  }

  // --- named things: may come from this bullet or the wider resume -------
  const allowed = new Set<string>(extractNamedThings(original));
  for (const skill of profile.skills) allowed.add(normaliseTerm(skill.name));
  for (const role of profile.experience) {
    if (role.company) allowed.add(normaliseTerm(role.company));
    if (role.title) for (const w of normaliseTerm(role.title).split(' ')) allowed.add(w);
  }
  for (const project of profile.projects) {
    if (project.name) allowed.add(normaliseTerm(project.name));
    for (const tech of project.technologies) allowed.add(normaliseTerm(tech));
  }

  for (const thing of extractNamedThings(rewritten)) {
    if (allowed.has(thing)) continue;
    if (GENERIC_TOKENS.has(thing)) continue;
    // Multi-word phrases pass if every word is individually accounted for —
    // 'Redis cache' is fine when 'redis' and 'cache' are both known.
    const words = thing.split(' ');
    if (
      words.length > 1 &&
      words.every((w) => allowed.has(w) || GENERIC_TOKENS.has(w))
    ) {
      continue;
    }
    violations.push(`invented_entity:${thing}`);
  }

  return { ok: violations.length === 0, violations };
}
