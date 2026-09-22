// -----------------------------------------------------------------------------
// AI model classification + per-endpoint cap-column mapping.
//
// Two responsibilities for the AI proxy (design §3.6):
//
//   1. Classify a requested model as "premium" vs non-premium so the proxy can
//      gate premium models behind profiles.plan (Req 6.1, 6.2, 6.5). Premium
//      models are forwarded with the platform GROQ_API_KEY; non-premium models
//      use the caller's own vaulted key.
//
//   2. Map each AI endpoint to its feature_limits cap column and the strategy
//      used to count usage against that cap for the current UTC day
//      (Req 6.3, 6.4). The column names below are verified against
//      007_feature_limits.sql:
//        - max_questions_per_day
//        - max_vision_per_day
//        - max_transcription_minutes_per_day
//      NULL in any of these columns means "unlimited" (Req 6.3) — that check
//      lives in the proxy handler, not here.
//
// This module is pure and dependency-free so it is safe to import from either
// server route handlers or tests.
// -----------------------------------------------------------------------------

/**
 * The set of model identifiers that require a premium plan.
 *
 * Intentionally EMPTY for now (resolved Open Decision): no model is premium
 * today, so every request is treated as non-premium and uses the caller's
 * vaulted key. Premium model ids (e.g. 'gpt-4o', 'claude-3-5-sonnet') get added
 * here when paid plans ship — no other code change is required for gating.
 */
export const PREMIUM_MODELS = new Set<string>([]);

/** The AI proxy endpoints. */
export type AiEndpoint = 'chat' | 'transcribe' | 'vision';

// -----------------------------------------------------------------------------
// Vision model remap (production hotfix).
//
// Groq decommissioned the Llama-4 vision models (`meta-llama/llama-4-scout-…`
// and `-maverick-…`) — requests for them now return HTTP 404 "model does not
// exist". Every ALREADY-INSTALLED desktop app has the old id baked into its
// `config.ini` (`[AI] vision_model`) and cannot be updated remotely, so we
// remap dead vision ids to the current supported Groq vision model here,
// server-side. This fixes every existing user on the next deploy without a
// desktop release. When Groq changes the vision model again, update this one
// constant.
//
// Source: https://console.groq.com/docs/vision (current supported model).
// -----------------------------------------------------------------------------

/**
 * The current Groq vision model.
 *
 * WAS `qwen/qwen3.6-27b`, WHICH GROQ RETIRED. Measured against the live API with
 * the production key:
 *
 *   qwen/qwen3.6-27b                             404  model_not_found
 *   meta-llama/llama-4-scout-17b-16e-instruct    404  model_not_found
 *   meta-llama/llama-4-maverick-17b-128e-…       404  model_not_found
 *   qwen/qwen3.8-27b                             200  described the image
 *
 * That 404 is the whole of the production "vision analysis failed" bug. Chat and
 * transcription were unaffected because they resolve different models, which is
 * exactly why the failure looked like a vision-specific code fault rather than a
 * dead model id.
 *
 * THE REMAP TARGET IS THE THING THAT ROTS. Retired ids were already being
 * remapped here, but they were remapped ONTO a constant that had itself gone
 * stale, so the safety net pointed at a 404. When Groq moves the vision model
 * again, this constant is the one line to change — and it must be verified against
 * `GET /v1/models`, not assumed from the docs.
 */
export const CURRENT_VISION_MODEL = 'qwen/qwen3.8-27b';

/**
 * Vision model ids Groq has decommissioned (return 404), remapped on the fly.
 *
 * `qwen/qwen3.6-27b` is in here as well as being the FORMER value of
 * `CURRENT_VISION_MODEL`: any desktop build that pinned it in `config.ini` while it
 * was current would otherwise pass it straight through and 404. Adding a retired
 * target to this set is what makes replacing the constant safe.
 */
const DEPRECATED_VISION_MODELS = new Set<string>([
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3.6-27b',
]);

/**
 * Chat model ids Groq has retired, remapped on the fly to `CURRENT_CHAT_MODEL`.
 *
 * ACTIVATED 2026-08-25. This set was empty until now, and the earlier note here
 * said `llama-3.3-70b-versatile` "IS scheduled to shut down 2026-08-16 — before
 * then we must migrate it". That date passed with the set still empty, which
 * means every installed desktop app — the model id is baked into its
 * `config.ini` and cannot be updated remotely — was sending a retired model id
 * upstream and getting a 404 back.
 *
 * Groq retired `llama-3.3-70b-versatile` and `llama-3.1-8b-instant` for free and
 * developer tiers and directs new traffic to the GPT-OSS models. `qwen3-32b` was
 * announced in the same wave. Remapping a model that turns out to still be live
 * is harmless (it forwards a newer model); leaving a retired one unmapped is an
 * outage for paying users, so the set errs toward remapping.
 */
const DEPRECATED_CHAT_MODELS = new Set<string>([
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'qwen3-32b',
]);

/**
 * How to stop a model emitting its reasoning, per model family.
 *
 * This is NOT one parameter for all models, and getting it wrong is a 400 rather
 * than a no-op. Per Groq's reasoning documentation:
 *
 *   - `reasoning_effort` accepts `none`/`default` ONLY on Qwen 3.6 27B. On
 *     GPT-OSS it accepts only `low`/`medium`/`high` — so sending
 *     `reasoning_effort: "none"` to GPT-OSS is an invalid value, not a way to
 *     turn thinking off.
 *   - `reasoning_format` is NOT supported by GPT-OSS 20B/120B at all.
 *   - GPT-OSS instead honours `include_reasoning: false`.
 *   - `include_reasoning` and `reasoning_format` are mutually exclusive.
 *
 * GPT-OSS also puts reasoning in a separate `message.reasoning` field rather
 * than inside `content`, so it does not corrupt the answer text the way a raw
 * `<think>` block would. Setting `include_reasoning: false` drops it entirely,
 * which saves the tokens and the latency.
 */
export type ReasoningSuppression =
  | { param: 'reasoning_effort'; value: 'none' }
  | { param: 'include_reasoning'; value: false };

/** Model id → the parameter that disables its reasoning output. */
const REASONING_SUPPRESSION: Record<string, ReasoningSuppression> = {
  // The only Groq vision model, and it reasons by default. Keyed on the model id,
  // so this MUST move with `CURRENT_VISION_MODEL` — a stale key here does not
  // error, it silently stops suppressing reasoning, and vision answers start
  // arriving slower and padded with thinking. The 3.6 entry is kept because that
  // id can still arrive from an older desktop build before the remap runs.
  'qwen/qwen3.8-27b': { param: 'reasoning_effort', value: 'none' },
  'qwen/qwen3.6-27b': { param: 'reasoning_effort', value: 'none' },
  // The chat replacement. GPT-OSS rejects `reasoning_effort: "none"`.
  'openai/gpt-oss-120b': { param: 'include_reasoning', value: false },
  'openai/gpt-oss-20b': { param: 'include_reasoning', value: false },
};

/**
 * The parameter that disables this model's reasoning, or `null` when the model
 * does not reason (or needs no suppression).
 */
export function getReasoningSuppression(
  model: string | null | undefined
): ReasoningSuppression | null {
  if (typeof model !== 'string') return null;
  return REASONING_SUPPRESSION[model] ?? null;
}

/** True when the model reasons by default and its reasoning should be disabled. */
export function needsReasoningSuppression(model: string | null | undefined): boolean {
  return getReasoningSuppression(model) !== null;
}

/**
 * Resolve the model actually sent upstream. Missing or decommissioned model
 * ids are remapped to the current supported model for that endpoint; anything
 * else passes through unchanged. `transcribe` is never altered here (its model
 * is chosen server-adjacent and is not affected by these deprecations).
 */
export function resolveModel(
  endpoint: AiEndpoint,
  requested: string | undefined
): string | undefined {
  if (endpoint === 'vision') {
    if (!requested || DEPRECATED_VISION_MODELS.has(requested)) {
      return CURRENT_VISION_MODEL;
    }
  }
  if (endpoint === 'chat') {
    if (requested && DEPRECATED_CHAT_MODELS.has(requested)) {
      return CURRENT_CHAT_MODEL;
    }
  }
  return requested;
}

/**
 * The chat model retired ids are remapped to. ACTIVE as of 2026-08-25 — see
 * `DEPRECATED_CHAT_MODELS`.
 *
 * GPT-OSS 120B is a reasoning model, which was the stated reason for not
 * migrating earlier. That concern is handled by `REASONING_SUPPRESSION`:
 * GPT-OSS returns reasoning in a separate `message.reasoning` field rather than
 * inside `content`, and `include_reasoning: false` removes it altogether, so the
 * desktop app receives only the final answer.
 *
 * One caveat worth knowing when tuning prompts: Groq's guidance for reasoning
 * models is to put instructions in the USER message rather than a system prompt.
 * `src/lib/ai/prompt-policy.ts` currently injects a system message, which is
 * likely still fine but is worth A/B-ing against a user-message variant if
 * answer quality looks off after this migration.
 */
export const CURRENT_CHAT_MODEL = 'openai/gpt-oss-120b';

/**
 * The model the RESUME pipeline uses for structured extraction.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `CURRENT_CHAT_MODEL`
 *
 * It used to be. `src/lib/resume/ai/client.ts` imported `CURRENT_CHAT_MODEL`, so
 * the model chosen for the DESKTOP APP'S CHAT also silently decided the cost
 * profile of every resume scan — and the resume pipeline's token budgets are
 * sized in single hundreds of tokens against an 8000/minute ceiling. That
 * coupling broke the product:
 *
 *   Measured on a real one-page resume, gpt-oss-120b at reasoning_effort=low
 *   spent 733 reasoning + 1590 output = 2323 completion tokens against a budget
 *   of 1800. Every scan of that resume failed with `truncated`, surfacing as
 *   "This resume or job description was too long to analyse in one pass."
 *
 *   The budgets had been measured when reasoning cost 124 tokens. Nothing linked
 *   the two, so a model change aimed at chat quietly invalidated them.
 *
 * Same prompt, same resume, gpt-oss-20b at reasoning_effort=low:
 *
 *   model          reasoning  output  completion  latency  extracted
 *   gpt-oss-120b   733        1590    2323        7.0s     exp 3, skills 35, proj 3
 *   gpt-oss-20b     63        1123    1186        2.1s     exp 3, skills 35, proj 3
 *
 * Identical extraction, 11.6x less reasoning, 3.3x faster, and it fits the
 * budget. Extraction is transcription rather than deduction — the prompt forbids
 * inference — so the larger model's reasoning was being billed for nothing.
 *
 * `qwen/qwen3.6-27b` was also measured and is UNUSABLE here: it enforces a
 * 1000-token OUTPUT-per-minute limit (OTPM) and returns 429 before running.
 *
 * ---------------------------------------------------------------------------
 * IF YOU CHANGE THIS, RE-MEASURE THE BUDGETS
 *
 * Every `MAX_TOKENS` in `src/lib/resume/ai/` and `src/lib/jobs/outreach.ts` is
 * sized against this model's reasoning overhead. `EXTRACTION_BUDGETS_MEASURED_FOR`
 * below pins that relationship and a test asserts it, so changing this constant
 * fails the suite instead of silently truncating scans in production.
 */
export const RESUME_EXTRACTION_MODEL = 'openai/gpt-oss-20b';

/**
 * The model the resume pipeline's token budgets were measured against.
 *
 * Guarded by a test rather than a comment, because a comment is exactly what
 * failed last time: extract-profile.ts documented "reasoning 124" for a model
 * that had since been replaced by one spending 733, and nothing noticed.
 */
export const EXTRACTION_BUDGETS_MEASURED_FOR = 'openai/gpt-oss-20b';

/** The feature_limits cap columns (verified against 007_feature_limits.sql). */
export type CapColumn =
  | 'max_questions_per_day'
  | 'max_vision_per_day'
  | 'max_transcription_minutes_per_day';

/**
 * How usage is tallied against a cap for the current UTC day:
 *   - 'count'        — one unit per api_usage row (chat, vision)
 *   - 'sum_minutes'  — sum of audio minutes across today's rows; a row whose
 *                      WAV duration is undeterminable counts as 1 minute
 *                      (transcribe)
 */
export type CountStrategy = 'count' | 'sum_minutes';

/** Per-endpoint cap column + counting strategy (design §3.6). */
export interface EndpointCapConfig {
  capColumn: CapColumn;
  strategy: CountStrategy;
}

/**
 * Endpoint → feature_limits cap column + counting strategy.
 *
 *   chat       → max_questions_per_day               (count of rows today)
 *   vision     → max_vision_per_day                  (count of rows today)
 *   transcribe → max_transcription_minutes_per_day   (sum of audio minutes
 *                                                     today; default 1 minute
 *                                                     when WAV duration is
 *                                                     undeterminable)
 */
export const ENDPOINT_CAP_CONFIG: Record<AiEndpoint, EndpointCapConfig> = {
  chat: { capColumn: 'max_questions_per_day', strategy: 'count' },
  vision: { capColumn: 'max_vision_per_day', strategy: 'count' },
  transcribe: {
    capColumn: 'max_transcription_minutes_per_day',
    strategy: 'sum_minutes',
  },
};

/**
 * Default minutes charged for a transcription request whose WAV duration cannot
 * be determined from the audio header (design §3.6, Req 6.4).
 */
export const DEFAULT_TRANSCRIPTION_MINUTES = 1;

/** True when the model requires a premium plan (Req 6.1). */
export function isPremiumModel(model: string): boolean {
  return PREMIUM_MODELS.has(model);
}

/** The cap-column + counting-strategy config for an endpoint (Req 6.3, 6.4). */
export function getEndpointCapConfig(endpoint: AiEndpoint): EndpointCapConfig {
  return ENDPOINT_CAP_CONFIG[endpoint];
}
