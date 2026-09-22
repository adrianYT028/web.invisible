import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CURRENT_CHAT_MODEL,
  EXTRACTION_BUDGETS_MEASURED_FOR,
  RESUME_EXTRACTION_MODEL,
} from '@/lib/ai/models';

// -----------------------------------------------------------------------------
// Token budgets vs the model they were measured against
//
// THE BUG THIS EXISTS TO PREVENT
//
// The resume pipeline imported `CURRENT_CHAT_MODEL`, so the model chosen for the
// desktop app's chat also decided how many reasoning tokens every resume scan
// would burn. When that constant was repointed at gpt-oss-120b, the budgets —
// measured when reasoning cost 124 tokens — were silently invalidated. Measured
// on a real resume the new model spent 733 reasoning + 1590 output = 2323 against
// a 1800 budget, so every scan returned `truncated` and told the user their resume
// was too long. Nothing failed except the product.
//
// A comment could not catch that, and did not: extract-profile.ts still claimed
// "reasoning 124" while production was spending 733. So the relationship is
// asserted here instead.
// -----------------------------------------------------------------------------

/** Read a `const MAX_TOKENS = <n>;` out of a module. */
function maxTokens(path: string): number {
  const source = readFileSync(path, 'utf8');
  const match = /^const MAX_TOKENS = (\d+);$/m.exec(source);
  expect(match, `no MAX_TOKENS found in ${path}`).not.toBeNull();
  return Number(match![1]);
}

const PROFILE = 'src/lib/resume/ai/extract-profile.ts';
const JD = 'src/lib/resume/ai/extract-jd.ts';
const REWRITE = 'src/lib/resume/ai/rewrite.ts';
const OUTREACH = 'src/lib/jobs/outreach.ts';

/**
 * Measured on a real one-page resume against gpt-oss-20b at reasoning_effort=low.
 * Prompt sizes are real, not estimated — they are what makes the reservation
 * arithmetic below correct.
 */
const MEASURED = {
  profile: { prompt: 1476, completion: 1186 },
  jd: { prompt: 1070, completion: 690 },
  rewrite: { prompt: 1200, completion: 960 },
} as const;

/** The account's measured tokens-per-minute ceiling on the on-demand tier. */
const TPM_CEILING = 8000;

describe('the extraction model is decoupled from the chat model', () => {
  // The coupling itself was the defect. Chat is chosen for answer quality on the
  // desktop app; extraction is chosen to fit a token budget. Those are different
  // jobs and must be separately changeable.
  it('does not reuse the chat model for extraction', () => {
    expect(RESUME_EXTRACTION_MODEL).not.toBe(CURRENT_CHAT_MODEL);
  });

  it('the resume client uses the extraction model, never the chat model', () => {
    const source = readFileSync('src/lib/resume/ai/client.ts', 'utf8');

    expect(source).toContain('RESUME_EXTRACTION_MODEL');

    // Comments are stripped first, on purpose. The file's header explains this
    // very bug and therefore NAMES `CURRENT_CHAT_MODEL` — that prose is the
    // documentation, not the defect. Only a live reference matters, including the
    // one in the api_usage row: logging the wrong model makes the cost record
    // useless for exactly the debugging this bug needed.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(code).not.toMatch(/\bCURRENT_CHAT_MODEL\b/);
    // Guard the guard: stripping must not have removed the whole file.
    expect(code).toMatch(/\bRESUME_EXTRACTION_MODEL\b/);
  });

  // The tripwire. Repointing the extraction model without re-measuring is the
  // exact sequence that shipped the truncation bug.
  it('the budgets were measured against the model actually in use', () => {
    expect(
      EXTRACTION_BUDGETS_MEASURED_FOR,
      'RESUME_EXTRACTION_MODEL changed. Re-measure every MAX_TOKENS in ' +
        'src/lib/resume/ai/ and src/lib/jobs/outreach.ts against the new model, ' +
        'then update EXTRACTION_BUDGETS_MEASURED_FOR. Reasoning cost varies by ' +
        '10x between models and is charged against the same budget as the output.'
    ).toBe(RESUME_EXTRACTION_MODEL);
  });
});

describe('each budget covers its measured need', () => {
  const cases = [
    ['profile', PROFILE, MEASURED.profile.completion],
    ['jd', JD, MEASURED.jd.completion],
    ['rewrite', REWRITE, MEASURED.rewrite.completion],
  ] as const;

  for (const [label, path, need] of cases) {
    it(`${label} has margin over its measured ${need} tokens`, () => {
      const budget = maxTokens(path);

      expect(budget, `${label} budget ${budget} < measured need ${need}`).toBeGreaterThan(need);
      // At least 20% margin: a longer document produces a longer profile, and the
      // failure mode is a truncation the user reads as "your resume is too long".
      expect(
        budget / need,
        `${label} margin is only ${((budget / need - 1) * 100).toFixed(0)}%`
      ).toBeGreaterThan(1.2);
    });
  }
});

describe('a whole scan fits the per-minute ceiling', () => {
  // Groq reserves prompt + max_completion_tokens UP FRONT, so what matters is the
  // sum of RESERVATIONS across the three calls a scan makes — not the sum of the
  // budgets. Getting this wrong is what put the real total at ~9550 while the
  // budget-only sum looked like a comfortable 5800.
  it('the three reservations stay under the TPM ceiling', () => {
    const reservations =
      MEASURED.profile.prompt +
      maxTokens(PROFILE) +
      MEASURED.jd.prompt +
      maxTokens(JD) +
      MEASURED.rewrite.prompt +
      maxTokens(REWRITE);

    expect(
      reservations,
      `a scan reserves ${reservations} against a ${TPM_CEILING}/min ceiling — ` +
        'the second or third call will 429'
    ).toBeLessThanOrEqual(TPM_CEILING);
  });

  // Documents the headroom honestly rather than asserting it is comfortable,
  // because it is not. A two-page resume will exceed the ceiling until the Groq
  // tier is raised.
  it('records how little headroom is left', () => {
    const reservations =
      MEASURED.profile.prompt +
      maxTokens(PROFILE) +
      MEASURED.jd.prompt +
      maxTokens(JD) +
      MEASURED.rewrite.prompt +
      maxTokens(REWRITE);

    const headroom = TPM_CEILING - reservations;
    // If this ever passes comfortably, the tier was raised and the constant here
    // should be raised with it.
    expect(headroom).toBeLessThan(1000);
    expect(headroom).toBeGreaterThan(0);
  });

  it('the outreach call is budgeted too, since it shares the same ceiling', () => {
    expect(maxTokens(OUTREACH)).toBeGreaterThan(0);
    expect(maxTokens(OUTREACH)).toBeLessThan(2000);
  });
});
