// -----------------------------------------------------------------------------
// Job description → ParsedJobDescription
// -----------------------------------------------------------------------------
//
// Extraction only. The model identifies what the posting asks for; whether the
// candidate meets it is decided by deterministic code in
// src/lib/resume/scoring.

import {
  JD_SCHEMA_VERSION,
  normaliseTerm,
  type JdKnockout,
  type JdRequirement,
  type ParsedJobDescription,
} from '../schema';
import { structuredCompletion } from './client';
import { trimJobDescription } from './trim-jd';

/**
 * Output budget.
 *
 * Sized against the account's tokens-per-minute ceiling rather than against need —
 * Groq charges `prompt_tokens + max_completion_tokens` against TPM up front, so an
 * oversized budget is spent whether the model uses it or not. See the fuller note
 * in extract-profile.ts.
 *
 * A measured run of this prompt completed in 565 completion tokens (235 of them
 * reasoning) from a 284-token prompt. 2000 covers a long posting with many
 * requirements while keeping a scan's two calls comfortably inside one minute's
 * allowance.
 */
/**
 * RAISED FROM 1200, TWICE, against real postings rather than a fixture.
 *
 * A synthetic test JD completed in 565 tokens. A real 10,000-character company
 * posting truncated at 1200 — and the log showed why: 575 of those 1200 went on
 * reasoning, leaving roughly 600 for a JSON object holding a dozen requirements,
 * their terms, knockouts and keywords. Truncation fails the whole item.
 *
 * LOWERED TO 1300 when the pipeline moved to `RESUME_EXTRACTION_MODEL`.
 *
 * The 2500 above was the right answer for a model spending 575 tokens on
 * reasoning. The current extraction model spends 63 (measured), so ~500 of that
 * budget was reserved against the per-minute ceiling for reasoning that no longer
 * happens — and the ceiling, not need, is what constrains this call. Output need
 * is unchanged at roughly 625, so 1300 keeps the same real margin the 2500 had.
 *
 * Reservations for one prep item:
 *   job description  ~1,070 prompt + 1,300 = 2,370
 *   rewrite                              ~2,400
 *   email                                ~1,600
 *   ------------------------------------------
 *   ~6,370 against an 8,000/minute ceiling
 *
 * That is why ITEMS_PER_TICK is 1. The ceiling is also shared with the desktop
 * app's vision calls, so the remaining headroom is deliberate, not slack.
 */
const MAX_TOKENS = 1300;

/** Longest posting accepted, in characters. */
const MAX_JD_CHARS = 20_000;

/**
 * The extraction prompt.
 *
 * THE `terms` INSTRUCTION IS THE LOAD-BEARING PART. Without it, live output for
 * "Required: strong Python, PostgreSQL, REST API design" came back as
 * `['Python','PostgreSQL','REST','API','design']`, and other lines produced
 * 'experience', 'essential' and 'degree'. Those tokens are not skills, no resume
 * contains them, and each one counted against the candidate in requirement
 * coverage. The scoring layer now filters them defensively, but fixing it at the
 * source is cheaper and more accurate than compensating downstream.
 *
 * Everything is in one user message with no system prompt, following Groq's
 * guidance for reasoning models.
 */
function buildPrompt(jdText: string): string {
  return `Extract structured data from the job description below.

Return ONLY a JSON object with exactly this shape:
{
  "jobTitle": string | null,
  "company": string | null,
  "location": string | null,
  "isRemote": boolean,
  "requirements": [{ "text": string, "kind": "must" | "nice", "terms": [string] }],
  "knockouts": [{ "kind": "work_authorisation" | "location" | "years_experience" | "degree", "requirement": string, "minYears": number | null }],
  "keywords": [{ "term": string, "count": number }]
}

RULES

requirements
- One entry per distinct requirement. "text" is the posting's own wording, trimmed.
- "kind" is "must" when the posting frames it as required/essential/minimum, and
  "nice" when it frames it as preferred/bonus/nice to have.
- "terms" MUST contain ONLY concrete, matchable skill, technology, tool or domain
  names — the things a resume would literally name. For example: Python,
  PostgreSQL, Kubernetes, REST, machine learning, payment systems.
- "terms" MUST NOT contain generic or descriptive words. Never include:
  experience, essential, strong, proven, knowledge, understanding, ability,
  skills, degree, design, years, production, team, player, communication,
  or any adjective. If a requirement contains no concrete skill name, return an
  empty terms array rather than inventing one.
- Do not hyphenate or combine words into terms that would not appear in a resume.
  Write "Python", never "Python-first".

knockouts
- Include ONLY hard gates the posting actually states: legal work authorisation,
  a required physical location, a minimum number of years, or a required
  qualification.
- "minYears" is the number for years_experience, otherwise null.
- Do not invent a knockout that is not stated.

keywords
- The concrete skills, technologies and job-title words the posting mentions,
  with "count" being how many times each appears.
- Same restriction as terms: concrete names only, no generic words.

location / isRemote
- "isRemote" is true only when the posting says the role is remote.

JOB DESCRIPTION
${jdText}`;
}

/** Raw model output, before validation. Every field is untrusted. */
interface RawJd {
  jobTitle?: unknown;
  company?: unknown;
  location?: unknown;
  isRemote?: unknown;
  requirements?: unknown;
  knockouts?: unknown;
  keywords?: unknown;
}

const KNOCKOUT_KINDS = new Set([
  'work_authorisation',
  'location',
  'years_experience',
  'degree',
]);

/**
 * Extract a job description.
 *
 * The result is normalised and validated field by field rather than cast. Model
 * output is untrusted input: a stray type reaching `resume_scans.report` would be
 * stored as jsonb without complaint and only surface later as a render crash.
 */
export async function extractJobDescription(input: {
  userId: string;
  jdText: string;
}): Promise<ParsedJobDescription> {
  // Trimmed BEFORE the cap: dropping boilerplate sections is what makes the
  // remaining text fit, rather than slicing mid-requirement at 20,000 characters.
  const jdText = trimJobDescription(input.jdText).slice(0, MAX_JD_CHARS);

  const raw = await structuredCompletion<RawJd>({
    userId: input.userId,
    endpoint: 'resume_jd_extract',
    prompt: buildPrompt(jdText),
    maxCompletionTokens: MAX_TOKENS,
  });

  return {
    schemaVersion: JD_SCHEMA_VERSION,
    jobTitle: asStringOrNull(raw.jobTitle),
    company: asStringOrNull(raw.company),
    location: asStringOrNull(raw.location),
    isRemote: raw.isRemote === true,
    requirements: asRequirements(raw.requirements),
    knockouts: asKnockouts(raw.knockouts),
    keywords: asKeywords(raw.keywords),
  };
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRequirements(value: unknown): JdRequirement[] {
  if (!Array.isArray(value)) return [];
  const out: JdRequirement[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const text = asStringOrNull(row.text);
    if (!text) continue;
    out.push({
      text,
      // Anything other than an explicit "nice" is treated as required. Erring
      // toward `must` is the safer default: under-weighting a real requirement
      // tells a candidate they are a better fit than they are.
      kind: row.kind === 'nice' ? 'nice' : 'must',
      terms: Array.isArray(row.terms)
        ? row.terms
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
        : [],
    });
  }
  return out;
}

function asKnockouts(value: unknown): JdKnockout[] {
  if (!Array.isArray(value)) return [];
  const out: JdKnockout[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const kind = typeof row.kind === 'string' ? row.kind : '';
    const requirement = asStringOrNull(row.requirement);
    if (!requirement || !KNOCKOUT_KINDS.has(kind)) continue;

    const minYearsRaw = row.minYears;
    const minYears =
      typeof minYearsRaw === 'number' && Number.isFinite(minYearsRaw)
        ? minYearsRaw
        : null;

    out.push({ kind, requirement, minYears });
  }
  return out;
}

function asKeywords(value: unknown): Array<{ term: string; count: number }> {
  if (!Array.isArray(value)) return [];

  // Merge on the normalised form so a posting writing both "React" and "React.js"
  // contributes one weighted keyword rather than two competing ones.
  const merged = new Map<string, { term: string; count: number }>();
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const term = asStringOrNull(row.term);
    if (!term) continue;
    const key = normaliseTerm(term);
    if (key.length === 0) continue;

    const count =
      typeof row.count === 'number' && Number.isFinite(row.count) && row.count > 0
        ? Math.round(row.count)
        : 1;

    const existing = merged.get(key);
    if (existing) existing.count += count;
    else merged.set(key, { term, count });
  }
  return [...merged.values()];
}
