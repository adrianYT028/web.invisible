// -----------------------------------------------------------------------------
// Model routing — whose key pays for this request
// -----------------------------------------------------------------------------
//
// The desktop app sends a model name and an access token. It does not send a
// provider, and it is a shipped C++ binary that cannot be taught to. So the proxy
// has to work out, from the model name plus what the user has vaulted, which
// provider to call and which key to spend.
//
// ---------------------------------------------------------------------------
// WHY MODEL IDS CANNOT BE PARSED
//
// The obvious shortcut is to read the vendor prefix: `openai/...` means OpenAI.
// That is wrong, and wrong in a way that produces a 404 rather than a type error.
//
// Groq namespaces its catalogue by the model's ORIGINAL author, not by itself:
//
//     openai/gpt-oss-120b        <- a GROQ model
//     openai/gpt-4o              <- an OPENROUTER model id for OpenAI's GPT-4o
//     qwen/qwen3.6-27b           <- a GROQ model
//     meta-llama/llama-4-scout…  <- a GROQ model
//
// The current chat model this platform runs on is literally `openai/gpt-oss-120b`
// and it must go to Groq. A prefix rule would send it to api.openai.com, which
// has never heard of it. So attribution is an EXPLICIT TABLE, and anything not in
// it falls through to the user's own key rather than being guessed at.
//
// The one exception is a vendor namespace that cannot possibly mean anything else
// — see OPENROUTER_ONLY_VENDORS below.
//
// ---------------------------------------------------------------------------
// CAPABILITY IS FILTERED BEFORE PREFERENCE
//
// A user with a Groq key and an OpenRouter key who records a voice note should get
// Groq, even if OpenRouter is their stated default — because OpenRouter has no
// transcription endpoint at all. So candidates are filtered by whether they can
// serve the endpoint FIRST, and only then narrowed by preference. Applying the
// preference first would send audio to a provider that cannot accept it and
// return a confusing 404 instead of using the key that would have worked.

import type { AiEndpoint } from './models';
import {
  isProviderId,
  supportsEndpoint,
  type ProviderId,
} from './providers';

/**
 * Explicit model attribution. Lowercase keys; lookups are case-insensitive.
 *
 * Only models we can attribute with confidence belong here. Being INCOMPLETE is
 * safe — an unlisted model falls through to the user's own key — whereas being
 * WRONG sends a request to a provider that does not have the model. So when in
 * doubt, leave it out.
 */
const MODEL_PROVIDERS: Readonly<Record<string, ProviderId>> = Object.freeze({
  // --- Groq -----------------------------------------------------------------
  // Note the `openai/` and `qwen/` prefixes: these are Groq-hosted models named
  // after their original authors. This is the collision the header describes.
  'openai/gpt-oss-120b': 'groq',
  'openai/gpt-oss-20b': 'groq',
  // The current Groq vision model. MUST be kept in step with
  // `CURRENT_VISION_MODEL` in ./models.ts — an unmapped model resolves to `null`
  // here, and a null provider means a BYO-key request cannot be routed at all, so
  // a stale entry breaks vision for every user supplying their own key even after
  // the model id itself is correct.
  'qwen/qwen3.8-27b': 'groq',
  // Retired, kept so an older desktop build that pins it is still attributed to
  // Groq on its way through the remap.
  'qwen/qwen3.6-27b': 'groq',
  'qwen3-32b': 'groq',
  'llama-3.3-70b-versatile': 'groq',
  'llama-3.1-8b-instant': 'groq',
  'meta-llama/llama-4-scout-17b-16e-instruct': 'groq',
  'meta-llama/llama-4-maverick-17b-128e-instruct': 'groq',
  'whisper-large-v3': 'groq',
  'whisper-large-v3-turbo': 'groq',

  // --- OpenAI ---------------------------------------------------------------
  // Bare names with no vendor prefix are OpenAI's own convention.
  'gpt-4o': 'openai',
  'gpt-4o-mini': 'openai',
  'gpt-4.1': 'openai',
  'gpt-4.1-mini': 'openai',
  'gpt-4-turbo': 'openai',
  'whisper-1': 'openai',
  'gpt-4o-transcribe': 'openai',
  'gpt-4o-mini-transcribe': 'openai',
});

/**
 * Vendor namespaces that can only be reached through OpenRouter.
 *
 * This is a prefix rule, which the header warns against — it is safe only because
 * of a specific fact: Groq does not serve Claude or Gemini, and this platform has
 * no native Anthropic or Google provider. So `anthropic/…` and `google/…` have
 * exactly one possible destination.
 *
 * It earns its place because without it, a user holding BOTH a Groq and an
 * OpenRouter key who asks for `anthropic/claude-sonnet-4.5` would fall through to
 * the priority order, land on Groq, and get a 404 for a model Groq has never
 * hosted.
 *
 * `openai/` and `qwen/` and `meta-llama/` must NEVER be added here: Groq uses all
 * three.
 */
const OPENROUTER_ONLY_VENDORS: readonly string[] = Object.freeze([
  'anthropic/',
  'google/',
]);

/** Attribute a model to a provider, or null when it cannot be attributed. */
export function providerForModel(model: unknown): ProviderId | null {
  if (typeof model !== 'string') return null;
  const normalised = model.trim().toLowerCase();
  if (normalised.length === 0) return null;

  const exact = MODEL_PROVIDERS[normalised];
  if (exact) return exact;

  for (const vendor of OPENROUTER_ONLY_VENDORS) {
    if (normalised.startsWith(vendor)) return 'openrouter';
  }
  return null;
}

/**
 * Order used to break a tie when the model is unattributable and the user has
 * expressed no preference.
 *
 * Groq is first so that behaviour does not change for anyone: before multiple
 * providers existed, every request went to Groq. A user who adds a second key
 * without nominating a default keeps working exactly as they did.
 */
const PROVIDER_PRIORITY: readonly ProviderId[] = Object.freeze([
  'groq',
  'openai',
  'openrouter',
]);

/** One vaulted key, as far as routing is concerned. */
export interface VaultedProvider {
  provider: ProviderId;
  isPreferred: boolean;
}

export type RoutingFailure =
  /** The user has vaulted no keys at all. */
  | 'no_api_key'
  /**
   * The model belongs to a provider the user has not vaulted a key for. Named
   * rather than substituted: sending an OpenAI model id to Groq is a 404, and
   * "add an OpenAI key" is the only useful thing to say.
   */
  | 'provider_key_missing'
  /**
   * No provider the user holds can serve this endpoint — a key whose provider has
   * no transcription API being asked to transcribe.
   */
  | 'endpoint_unsupported';

export type RoutingResult =
  | { ok: true; provider: ProviderId; reason: RoutingReason }
  | { ok: false; failure: RoutingFailure; provider: ProviderId | null };

/** Why this provider was chosen. Logged, and useful when a user disputes a bill. */
export type RoutingReason =
  /** The model is attributable and the user holds that key. */
  | 'model_attributed'
  /** Only one vaulted key can serve this endpoint. */
  | 'only_key'
  /** The user nominated this key as their default. */
  | 'preferred'
  /** Several candidates, no preference: fixed priority order. */
  | 'priority_fallback';

/**
 * Decide which provider serves this request.
 *
 * Does NOT consider platform-funded plans — a bundle subscriber's inference is
 * paid for with the platform Groq key and never reaches here. This answers only
 * the bring-your-own-key question.
 */
export function resolveProvider(args: {
  endpoint: AiEndpoint;
  model: unknown;
  vaulted: readonly VaultedProvider[];
}): RoutingResult {
  const { endpoint, model, vaulted } = args;

  // Ignore anything unrecognised that reached us from the database.
  const held = vaulted.filter((v) => isProviderId(v.provider));

  // --- 1. An attributable model decides on its own ---------------------------
  const attributed = providerForModel(model);
  if (attributed) {
    if (!supportsEndpoint(attributed, endpoint)) {
      // e.g. an OpenRouter-only model id sent to /transcribe.
      return { ok: false, failure: 'endpoint_unsupported', provider: attributed };
    }
    if (held.some((v) => v.provider === attributed)) {
      return { ok: true, provider: attributed, reason: 'model_attributed' };
    }
    return {
      ok: false,
      failure: 'provider_key_missing',
      provider: attributed,
    };
  }

  if (held.length === 0) {
    return { ok: false, failure: 'no_api_key', provider: null };
  }

  // --- 2. Capability before preference --------------------------------------
  const candidates = held.filter((v) => supportsEndpoint(v.provider, endpoint));
  if (candidates.length === 0) {
    // They have keys, but none of those providers can do this at all.
    return { ok: false, failure: 'endpoint_unsupported', provider: null };
  }

  // --- 3. One candidate needs no decision ----------------------------------
  if (candidates.length === 1) {
    return { ok: true, provider: candidates[0].provider, reason: 'only_key' };
  }

  // --- 4. The user's stated default ----------------------------------------
  const preferred = candidates.find((v) => v.isPreferred);
  if (preferred) {
    return { ok: true, provider: preferred.provider, reason: 'preferred' };
  }

  // --- 5. Deterministic tiebreak -------------------------------------------
  for (const provider of PROVIDER_PRIORITY) {
    if (candidates.some((v) => v.provider === provider)) {
      return { ok: true, provider, reason: 'priority_fallback' };
    }
  }

  // Unreachable while PROVIDER_PRIORITY covers every ProviderId, which a test
  // asserts. Kept so a new provider added without a priority entry degrades to
  // a defined answer instead of falling off the end of the function.
  return { ok: true, provider: candidates[0].provider, reason: 'priority_fallback' };
}

/** Exposed for the test that pins priority coverage. */
export const PROVIDER_PRIORITY_FOR_TESTS = PROVIDER_PRIORITY;
