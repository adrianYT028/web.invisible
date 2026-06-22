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
