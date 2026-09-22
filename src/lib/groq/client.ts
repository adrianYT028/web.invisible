// -----------------------------------------------------------------------------
// Groq client — now a thin binding over the provider-generic upstream client
// -----------------------------------------------------------------------------
//
// This module used to hold the base URL, the endpoint map, the bearer header and
// the body/usage helpers for the one provider that existed. Those now live in
// `src/lib/ai/upstream.ts`, with the URL and headers coming from the registry in
// `src/lib/ai/providers.ts`, so a second provider is configuration rather than a
// second client.
//
// What remains is the Groq-bound surface. It is kept for two honest reasons
// rather than deleted:
//
//   1. Its test suite exercises real wire behaviour — bearer attachment, per
//      endpoint URLs, JSON vs FormData encoding, usage parsing, abort
//      propagation. Pointed at these bindings it now covers `upstream.ts`, so the
//      coverage is retained rather than rewritten and thinned.
//   2. `src/__tests__/no_client_secret_import.test.ts` confines
//      `process.env.GROQ_API_KEY` to the env accessor and this directory. Keeping
//      the directory keeps that guard meaningful.
//
// There is deliberately NO logic here. Anything that looks like a decision
// belongs in upstream.ts or providers.ts, or it will need making twice the next
// time a provider is added.

import {
  forwardToProvider,
  validateProviderKey,
  type UpstreamUsage,
  type ValidateKeyResult,
} from '@/lib/ai/upstream';

/** The endpoints Groq serves. Unchanged shape; see AiEndpoint. */
export type GroqEndpoint = 'chat' | 'transcribe' | 'vision';

/** @deprecated Use `UpstreamUsage`. Retained for existing imports. */
export type GroqUsage = UpstreamUsage;

/** @deprecated Use `ValidateKeyResult`. Retained for existing imports. */
export type ValidateGroqKeyResult = ValidateKeyResult;

/**
 * Validate a Groq key before storing it.
 *
 * @deprecated Prefer `validateProviderKey(provider, key)` — a user may now vault
 * a key for any registered provider, and this binding can only check Groq.
 */
export async function validateGroqKey(
  key: string
): Promise<ValidateGroqKeyResult> {
  return validateProviderKey('groq', key);
}

/**
 * Forward a proxied AI request to Groq.
 *
 * @deprecated Prefer `forwardToProvider(provider, ...)`. This binding hardcodes
 * Groq, so a request that should go to a user's own OpenAI or OpenRouter key
 * would be sent to the wrong provider.
 */
export async function forwardToGroq(
  endpoint: GroqEndpoint,
  payload: unknown,
  apiKey: string,
  signal: AbortSignal
): Promise<{ status: number; body: ArrayBuffer; usage: GroqUsage | null }> {
  return forwardToProvider('groq', endpoint, payload, apiKey, signal);
}
