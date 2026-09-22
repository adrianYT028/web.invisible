// -----------------------------------------------------------------------------
// Structured JSON completions for the resume pipeline
// -----------------------------------------------------------------------------
//
// The one place the resume feature talks to a language model. Its only job is
// EXTRACTION — turning documents into the structures defined in
// src/lib/resume/schema.ts. No scoring happens here or in any prompt; scoring is
// deterministic arithmetic in src/lib/resume/scoring.
//
// ---------------------------------------------------------------------------
// WHO PAYS, AND WHY IT IS NOT THE USER
//
// Unlike the desktop AI proxy — where a `free` user supplies their own vaulted
// Groq key and our marginal cost is zero — resume inference is PLATFORM FUNDED on
// every plan, including free.
//
// That is forced by the product, not chosen for convenience. The free tier exists
// to show a real parse verdict and a real match report on one job before anyone
// pays (migration 011 seeds `free` at one upload and one scan per day). If that
// taster required the user to create a Groq account and paste an API key, nobody
// would complete it and the funnel would be worthless.
//
// So the bound on cost is VOLUME, not key ownership: `feature_limits`
// (max_resume_uploads_per_day / max_resume_scans_per_day) is what stops a single
// account running an unbounded bill, and the routes enforce it before calling
// here. A missing cap in that table means unlimited — see the warning in
// migration 011.
//
// ---------------------------------------------------------------------------
// SETTINGS ARE MEASURED, NOT GUESSED
//
// Every parameter below was verified against the live Groq API rather than
// inferred from documentation. The measurements, on an identical JD-extraction
// prompt:
//
//   reasoning_effort   reasoning tokens   result
//   (unset/default)    869                TRUNCATED at 1200, parsed only by luck
//   low                235                valid JSON, 1.17s
//   medium             567                valid JSON, 1.83s
//   high               —                  FAILED Groq's JSON validation outright
//
// Three conclusions are load-bearing:
//
//   1. `low` is the correct effort for extraction. It is 3.7x cheaper in
//      reasoning tokens than the default and 1.6x faster, with no loss of
//      accuracy on a task that is transcription rather than deduction.
//   2. `high` is not merely wasteful, it BREAKS structured output. Never raise it
//      for a JSON-mode call.
//   3. `include_reasoning: false` strips reasoning from the RESPONSE but does not
//      stop the model generating or billing it — the default run still spent 869
//      reasoning tokens. Cost control is `reasoning_effort`, not
//      `include_reasoning`.
//
// ---------------------------------------------------------------------------
// THE MEASUREMENTS ABOVE ARE MODEL-SPECIFIC, AND THAT ONCE BROKE THE PRODUCT
//
// They were taken against the chat model of the day. This module then imported
// `CURRENT_CHAT_MODEL`, so when that constant was repointed at `gpt-oss-120b` for
// the DESKTOP APP, every resume budget here was silently invalidated:
//
//   measured when the budgets were written   reasoning 124, output  678
//   gpt-oss-120b, same prompt, real resume   reasoning 733, output 1590
//
// 733 + 1590 = 2323 against a 1800 budget, so every scan of that resume returned
// `truncated` and told the user their resume was too long. It was not; the budget
// was measured for a different model.
//
// The fix is structural, not numeric: this module now pins
// `RESUME_EXTRACTION_MODEL` (see src/lib/ai/models.ts), which is independent of
// the chat model, and a test asserts the budgets' measured-against model still
// matches it. Re-point that constant and the suite fails rather than production.
//
// Current model, measured on a real one-page resume:
//
//   gpt-oss-20b @ low   reasoning  63   output 1123   completion 1186   2.1s
//
// Same extracted entities as the 120b run (3 roles, 35 skills, 3 projects), for
// 11.6x less reasoning.
//
// ---------------------------------------------------------------------------
// THE CAPACITY CEILING — READ THIS BEFORE SIZING ANY BUDGET
//
// Measured account limits on the `on_demand` service tier:
//
//     x-ratelimit-limit-tokens    8000   per MINUTE
//     x-ratelimit-limit-requests  1000
//
// Groq charges `prompt_tokens + max_completion_tokens` against the per-minute
// allowance UP FRONT, before the model runs. Two consequences:
//
//   AN OVERSIZED BUDGET IS NOT FREE HEADROOM. It is spent whether or not the model
//   uses it. Setting `max_completion_tokens: 8000` consumed the entire minute and
//   returned HTTP 413 with no output — that was the first live failure of this
//   module, and the reason both extractors now declare small, measured budgets.
//
//   THIS IS A THROUGHPUT CEILING FOR THE WHOLE PRODUCT, not a per-user one. A full
//   scan costs roughly 1100 (profile) + 850 (job description) tokens, so 8000 TPM
//   supports on the order of TWO scans per minute across ALL users. That is
//   adequate for validating demand and nowhere near adequate for launch traffic;
//   the tier has to be raised before this feature is promoted.
//
// Because the allowance is per-minute and charged up front, a scan's two
// extractions run SEQUENTIALLY rather than concurrently. Running them in parallel
// reserves both budgets in the same instant and roughly doubles the peak, which is
// what pushes a second concurrent user into a 413.

import { RESUME_EXTRACTION_MODEL } from '@/lib/ai/models';
import { env } from '@/lib/env';
import { logSafe } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/admin';

/** Upstream timeout. Extraction is a single call, not a conversation. */
const TIMEOUT_MS = 45_000;

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Reasoning budget. See the measurement table above — `low` is the measured
 * optimum for JSON extraction and `high` fails validation.
 */
const REASONING_EFFORT = 'low' as const;

/**
 * A structured extraction failed in a way the caller can report.
 *
 * `truncated` is separated from `invalid_json` deliberately. A truncated response
 * can still happen to parse as valid JSON — the first live test did exactly that,
 * returning a complete-looking object from a response cut off at the token limit.
 * Treating the two identically would let silently incomplete data reach the
 * database and be scored as though it were whole.
 */
export class AiExtractionError extends Error {
  constructor(
    readonly code:
      | 'not_configured'
      | 'truncated'
      | 'invalid_json'
      | 'rate_limited'
      | 'upstream_unavailable'
      | 'upstream_error',
    message: string,
    /** Seconds to wait, when the upstream told us. */
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = 'AiExtractionError';
  }
}

export interface StructuredCompletionOptions {
  /** Whose usage this is charged to, for `api_usage`. */
  userId: string;
  /** Recorded in `api_usage.endpoint`. That column has no CHECK constraint. */
  endpoint: string;
  /**
   * The whole instruction, including the schema and the input document.
   *
   * A single USER message with no system prompt, on purpose: Groq's guidance for
   * reasoning models is to put instructions in the user message rather than a
   * system prompt.
   */
  prompt: string;
  /**
   * Output budget, EXCLUDING reasoning — except it does not exclude it, which is
   * the trap. Reasoning tokens are drawn from this same allowance, so a budget
   * sized for the JSON alone will truncate. Size it for the JSON plus roughly 250
   * reasoning tokens at `low` effort, then add margin.
   */
  maxCompletionTokens: number;
}

/**
 * Run a JSON-mode completion and return the parsed object.
 *
 * Throws `AiExtractionError` rather than returning a partial result: every caller
 * here is producing data that gets stored and scored, and a half-extracted
 * profile is worse than a failed scan the user can retry.
 */
export async function structuredCompletion<T>(
  options: StructuredCompletionOptions
): Promise<T> {
  const apiKey = env.groqApiKey;
  if (!apiKey) {
    // A paying subscriber — or a free user's one daily taster — cannot be served
    // at all without this. Logged loudly because it is a provisioning failure,
    // not a user error.
    logSafe('resume_ai_platform_key_missing', { endpoint: options.endpoint });
    throw new AiExtractionError(
      'not_configured',
      'Resume analysis is temporarily unavailable.'
    );
  }

  const startedAt = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let statusCode = 500;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let res: Response;
    try {
      res = await fetch(GROQ_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: RESUME_EXTRACTION_MODEL,
          messages: [{ role: 'user', content: options.prompt }],
          // Groq validates the output is JSON server-side and errors if it is not.
          response_format: { type: 'json_object' },
          // Extraction must be repeatable: the same document should yield the
          // same structures, because the scores computed from them are presented
          // as stable.
          temperature: 0,
          reasoning_effort: REASONING_EFFORT,
          include_reasoning: false,
          max_completion_tokens: options.maxCompletionTokens,
        }),
      });
    } catch {
      logSafe('resume_ai_upstream_unavailable', { endpoint: options.endpoint });
      throw new AiExtractionError(
        'upstream_unavailable',
        'The analysis service did not respond. Try again in a moment.'
      );
    }

    statusCode = res.status;
    const payload = (await res.json()) as GroqChatResponse;

    const usage = payload.usage;
    promptTokens = usage?.prompt_tokens ?? 0;
    completionTokens = usage?.completion_tokens ?? 0;
    totalTokens = usage?.total_tokens ?? 0;

    if (!res.ok) {
      // 429 is a rate limit; so is 413 here, despite the name. Groq returns
      // "Request too large ... on tokens per minute (TPM)" as 413, because it
      // charges `prompt_tokens + max_completion_tokens` against the per-minute
      // allowance UP FRONT rather than charging actual usage afterwards.
      //
      // This matters more than a normal upstream error: it is transient and
      // retryable, and on the measured account allowance it is the failure real
      // concurrent users will hit first. Collapsing it into `upstream_error`
      // would show them "rejected" for something that just needs a moment.
      if (res.status === 429 || res.status === 413) {
        const retryAfter = parseRetryAfter(res.headers);
        logSafe('resume_ai_rate_limited', {
          endpoint: options.endpoint,
          status: res.status,
          retry_after_seconds: retryAfter,
          remaining_tokens: res.headers.get('x-ratelimit-remaining-tokens'),
        });
        throw new AiExtractionError(
          'rate_limited',
          'Too many analyses are running right now. Try again in a moment.',
          retryAfter
        );
      }

      // Never log the message body: on a JSON-validation failure Groq echoes the
      // failed generation, which contains the user's document.
      logSafe('resume_ai_upstream_error', {
        endpoint: options.endpoint,
        status: res.status,
      });
      throw new AiExtractionError(
        'upstream_error',
        'The analysis service rejected the request.'
      );
    }

    const choice = payload.choices?.[0];

    // Truncation check BEFORE parsing. A cut-off response can still parse — the
    // first live test produced a complete-looking object from a truncated
    // response — so parsing success is not evidence of completeness.
    if (choice?.finish_reason === 'length') {
      logSafe('resume_ai_truncated', {
        endpoint: options.endpoint,
        completion_tokens: completionTokens,
        reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        budget: options.maxCompletionTokens,
      });
      throw new AiExtractionError(
        'truncated',
        'The document was too long to analyse in one pass. Try a shorter version.'
      );
    }

    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new AiExtractionError('invalid_json', 'The analysis returned nothing.');
    }

    try {
      return JSON.parse(content) as T;
    } catch {
      logSafe('resume_ai_invalid_json', { endpoint: options.endpoint });
      throw new AiExtractionError(
        'invalid_json',
        'The analysis returned a malformed result. Try again.'
      );
    }
  } finally {
    clearTimeout(timer);
    // One usage row per call, success or failure, with only the seven allowed
    // columns — the same contract the AI proxy honours (migration 006). No
    // document content ever reaches this table.
    await insertUsage({
      userId: options.userId,
      endpoint: options.endpoint,
      promptTokens,
      completionTokens,
      totalTokens,
      latencyMs: Date.now() - startedAt,
      statusCode,
    });
  }
}

/**
 * Seconds to wait before retrying, from the response headers.
 *
 * Prefers `retry-after`, then Groq's own token-window reset. The reset headers are
 * durations like `31.575s` or `5m45.6s`, not integers, so they need parsing rather
 * than `Number()`.
 */
function parseRetryAfter(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  }

  const reset = headers.get('x-ratelimit-reset-tokens');
  if (reset) {
    const match = reset.match(/^(?:(\d+)m)?([\d.]+)s$/);
    if (match) {
      const minutes = match[1] ? Number(match[1]) : 0;
      const seconds = Number(match[2]);
      if (Number.isFinite(seconds)) return Math.ceil(minutes * 60 + seconds);
    }
  }
  return null;
}

interface GroqChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

async function insertUsage(args: {
  userId: string;
  endpoint: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  statusCode: number;
}): Promise<void> {
  try {
    const { error } = await supabaseAdmin().from('api_usage').insert({
      user_id: args.userId,
      endpoint: args.endpoint,
      model: RESUME_EXTRACTION_MODEL,
      prompt_tokens: args.promptTokens,
      completion_tokens: args.completionTokens,
      total_tokens: args.totalTokens,
      latency_ms: args.latencyMs,
      status_code: args.statusCode,
    });
    if (error) {
      logSafe('resume_ai_usage_log_failed', {
        endpoint: args.endpoint,
        reason: error.message,
      });
    }
  } catch (err) {
    // Usage logging must never change what the caller sees.
    logSafe('resume_ai_usage_log_failed', {
      endpoint: args.endpoint,
      reason: err instanceof Error ? err.name : 'unknown',
    });
  }
}
