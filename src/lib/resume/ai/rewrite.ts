// -----------------------------------------------------------------------------
// Tailored rewrite — stronger bullets, no new facts
// -----------------------------------------------------------------------------
//
// Runs AFTER scoring, because scoring is what identifies which bullets are weak
// and which requirements went unevidenced. Rewriting before that would be guessing
// at what needs work.
//
// The hard guarantee: a suggestion may rephrase, reframe, and sharpen, but it may
// never introduce a number, technology, employer, or outcome the resume did not
// already claim. Every suggestion is checked by ./verify-no-new-facts.ts and
// DROPPED if it fails — the model's own `addedNoNewFacts` assertion is recorded but
// never trusted on its own.
//
// Dropping a suggestion costs the user one idea. Shipping a fabricated one costs
// them the interview, in a room where they have to defend a metric they never
// measured.

import {
  allBullets,
  type BulletFeedback,
  type MatchReport,
  type ParsedJobDescription,
  type ResumeProfile,
  type RewrittenBullet,
} from '../schema';
import { structuredCompletion } from './client';
import { verifyNoNewFacts } from './verify-no-new-facts';
import { logSafe } from '@/lib/http';

/**
 * How many bullets to rewrite in one request.
 *
 * Batched rather than one call per bullet: each call carries a fixed prompt cost
 * and, more importantly, reserves its budget against a per-minute token allowance
 * (see the capacity note in ./client.ts). Eight sequential single-bullet calls
 * would exhaust the minute; one batched call does not.
 */
const MAX_BULLETS = 8;

/**
 * Output budget. Eight rewrites is roughly 900 tokens of JSON plus ~63 reasoning
 * tokens on `RESUME_EXTRACTION_MODEL` at `low` effort.
 *
 * Sized as part of a scan's THREE-call total rather than in isolation — see the
 * reservation table in extract-profile.ts. The provider charges
 * prompt + max_completion_tokens against a per-minute allowance up front, so an
 * over-generous budget here is taken out of the other two calls.
 *
 * Lowered from 1500: that figure assumed ~250 reasoning tokens, and the measured
 * cost on the current extraction model is 63. The saving is returned to the
 * per-minute ceiling, which is what actually limits a scan.
 */
const MAX_TOKENS = 1200;

/** Bullets shorter than this are fragments, not achievement statements. */
const MIN_BULLET_CHARS = 25;

/**
 * Choose which bullets to rewrite, weakest first.
 *
 * A bullet with a note from the evidence scorer is one the deterministic pass
 * already identified as missing a figure, an outcome, or an action verb — so the
 * selection is driven by the same arithmetic the user sees, not by a second
 * opinion from the model.
 */
export function selectBulletsToRewrite(
  profile: ResumeProfile,
  feedback: BulletFeedback[],
  limit = MAX_BULLETS
): Array<{ id: string; text: string; note: string | null }> {
  const byId = new Map(allBullets(profile).map((b) => [b.id, b.text]));

  const scored = feedback
    .filter((f) => {
      const text = byId.get(f.bulletId);
      return typeof text === 'string' && text.trim().length >= MIN_BULLET_CHARS;
    })
    .map((f) => ({
      id: f.bulletId,
      text: byId.get(f.bulletId) as string,
      note: f.note,
      // Weakest first: no action verb is the most damaging, then no figure, then
      // no stated outcome.
      weakness:
        (f.hasActionVerb ? 0 : 4) +
        (f.isQuantified ? 0 : 2) +
        (f.describesOutcome ? 0 : 1),
    }))
    .filter((b) => b.weakness > 0)
    .sort((a, b) => b.weakness - a.weakness);

  return scored.slice(0, limit).map(({ id, text, note }) => ({ id, text, note }));
}

/**
 * Whether a rewrite differs from its source only in punctuation, case, or
 * whitespace.
 *
 * A suggestion that adds a full stop is not a suggestion. Showing it spends the
 * user's attention on a no-op and makes every other suggestion look less
 * trustworthy.
 */
export function isMateriallyUnchanged(
  original: string,
  rewritten: string
): boolean {
  const normalise = (s: string) =>
    s
      .toLowerCase()
      // Punctuation becomes a SPACE, not nothing. Deleting it would join the
      // words either side, so the non-breaking hyphen in "past‑tense" would
      // produce "pasttense" and compare unequal to "past tense" — reporting a
      // no-op edit as a genuine rewrite.
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  return normalise(original) === normalise(rewritten);
}

function buildPrompt(
  bullets: Array<{ id: string; text: string; note: string | null }>,
  jd: ParsedJobDescription,
  unevidenced: string[]
): string {
  const bulletBlock = bullets
    .map((b) => `- id: ${b.id}\n  text: ${b.text}${b.note ? `\n  weakness: ${b.note}` : ''}`)
    .join('\n');

  const targetBlock =
    unevidenced.length > 0
      ? unevidenced.map((r) => `- ${r}`).join('\n')
      : '(none — the resume already evidences the stated requirements)';

  return `Rewrite resume bullet points to be stronger, for a specific job.

Return ONLY a JSON object of this exact shape:
{ "rewrites": [ { "id": string, "rewritten": string, "rationale": string, "addedNoNewFacts": boolean } ] }

THE ABSOLUTE RULE

You may rephrase, restructure, tighten, and lead with the strongest part.
You may NOT add any fact the original bullet does not already contain.

Specifically forbidden:
- Inventing or estimating a number, percentage, duration, or amount. If the
  original has no figure, the rewrite has no figure.
- Naming a technology, tool, company, or product the original did not name.
- Inventing an outcome, result, or impact that is not already stated.
- Escalating the person's role. "Supported" must not become "led". "Helped
  build" must not become "built". "Part of a team that" must not become "I".
- Adding scale that is not stated ("across the company", "for thousands of
  users").

If a bullet genuinely cannot be improved without adding facts, return it with
"rewritten" set to the ORIGINAL text unchanged and say so in the rationale. That
is a correct and useful answer. Do not invent something to fill the slot.

WHAT GOOD LOOKS LIKE
- Open with a strong past-tense action verb.
- Lead with the result when the original states one.
- Cut filler: "responsible for", "worked on", "helped with", "various".
- Use the job's own vocabulary WHERE THE ORIGINAL ALREADY SUPPORTS IT. Do not
  bolt on a keyword the bullet does not earn.
- Keep it to one sentence, under about 30 words.

"rationale" is one short sentence, addressed to the candidate, explaining what
changed and why it is stronger. Do not mention these instructions.

"addedNoNewFacts" is your own assertion that you obeyed the absolute rule. It is
independently verified, and a rewrite that fails verification is discarded.

TARGET ROLE
${jd.jobTitle ?? 'unspecified'}${jd.company ? ` at ${jd.company}` : ''}

REQUIREMENTS THE RESUME DOES NOT YET EVIDENCE
(only lean toward these where a bullet already supports it — never fabricate)
${targetBlock}

BULLETS TO REWRITE
${bulletBlock}`;
}

interface RawRewrites {
  rewrites?: unknown;
}

export interface RewriteOutcome {
  rewrites: RewrittenBullet[];
  /** Suggestions discarded by verification, for logging. */
  rejected: Array<{ bulletId: string; violations: string[] }>;
}

/**
 * Generate verified rewrites for the weakest bullets.
 *
 * Never throws on a bad suggestion — a rewrite is an enhancement, so a failure
 * here must degrade to "no suggestions" rather than failing the whole scan the
 * user paid for.
 */
export async function generateRewrites(input: {
  userId: string;
  profile: ResumeProfile;
  jd: ParsedJobDescription;
  report: Pick<MatchReport, 'bulletFeedback' | 'requirements'>;
}): Promise<RewriteOutcome> {
  const { userId, profile, jd, report } = input;

  const bullets = selectBulletsToRewrite(profile, report.bulletFeedback);
  if (bullets.length === 0) return { rewrites: [], rejected: [] };

  const unevidenced = report.requirements
    .filter((r) => r.status !== 'met')
    .map((r) => r.text)
    .slice(0, 8);

  const raw = await structuredCompletion<RawRewrites>({
    userId,
    endpoint: 'resume_rewrite',
    prompt: buildPrompt(bullets, jd, unevidenced),
    maxCompletionTokens: MAX_TOKENS,
  });

  const originals = new Map(bullets.map((b) => [b.id, b.text]));
  const rewrites: RewrittenBullet[] = [];
  const rejected: Array<{ bulletId: string; violations: string[] }> = [];

  if (!Array.isArray(raw.rewrites)) return { rewrites: [], rejected: [] };

  for (const entry of raw.rewrites) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;

    const id = typeof row.id === 'string' ? row.id : '';
    const original = originals.get(id);
    // An id we did not ask about cannot be matched to a source bullet, so there
    // is nothing to verify it against.
    if (!original) continue;

    const rewritten =
      typeof row.rewritten === 'string' ? row.rewritten.trim() : '';
    if (rewritten.length === 0) continue;

    // An unchanged bullet is a legitimate answer — the prompt explicitly invites
    // it when a bullet cannot improve without inventing facts — but there is
    // nothing to show the user, so it is dropped rather than rendered as a diff
    // where nothing changed.
    //
    // The comparison ignores punctuation, case and whitespace because an exact
    // `===` does not survive a trailing full stop. A live run returned
    // "…constraints." against an original of "…constraints" with the rationale
    // "kept unchanged", and that slipped through as a suggestion.
    if (isMateriallyUnchanged(original, rewritten)) continue;

    const verdict = verifyNoNewFacts(original, rewritten, profile);
    if (!verdict.ok) {
      rejected.push({ bulletId: id, violations: verdict.violations });
      continue;
    }

    rewrites.push({
      sourceBulletId: id,
      original,
      rewritten,
      rationale:
        typeof row.rationale === 'string' && row.rationale.trim().length > 0
          ? row.rationale.trim()
          : 'Tightened and led with the strongest part.',
      // Recorded as the model's claim. Verification above is what actually gated
      // this suggestion reaching the user.
      addedNoNewFacts: row.addedNoNewFacts === true,
    });
  }

  if (rejected.length > 0) {
    // Worth watching: a rising rejection rate means the prompt is drifting, and
    // the violation codes say which rule is being broken. No bullet text logged.
    logSafe('resume_rewrite_rejected', {
      count: rejected.length,
      requested: bullets.length,
      violations: rejected.flatMap((r) => r.violations).slice(0, 12),
    });
  }

  return { rewrites, rejected };
}
