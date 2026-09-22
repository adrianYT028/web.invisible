// -----------------------------------------------------------------------------
// Upstream client — the only place a provider key leaves this process
// -----------------------------------------------------------------------------
//
// Generalises what `src/lib/groq/client.ts` did for a single provider. The URL
// and the auth headers now come from the provider registry
// (`src/lib/ai/providers.ts`) rather than from constants, so adding an
// OpenAI-shaped provider is a registry entry and not a new client.
//
// Security posture is unchanged and load-bearing: the key is attached to the
// outbound request and nowhere else. It is never logged, never returned, and
// never written into a response body.
//
// The response body is returned VERBATIM as bytes. The desktop app parses replies
// by scanning for `"content":`, so any reshaping here would break shipped
// binaries — which is also why only OpenAI-shaped providers may be registered.

import {
  authHeaders,
  endpointUrl,
  validateUrl,
  type ProviderId,
} from './providers';
import type { AiEndpoint } from './models';

/** Validation request timeout (Req 1.3/1.5). */
const VALIDATION_TIMEOUT_MS = 10_000;

/** Token accounting parsed from an OpenAI-shaped response, when present. */
export interface UpstreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type ValidateKeyResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_key' | 'unavailable' };

/**
 * Prove a key works before storing it.
 *
 * Uses the provider's `validatePath`, which must be an endpoint that actually
 * REQUIRES the credential. That is not a given: OpenRouter's `/models` is public
 * and returns 200 for a made-up key, which is why the registry points its probe
 * at `/key` instead. See the note on `validatePath` in providers.ts.
 *
 *   200         -> ok
 *   401 / 403   -> invalid_key
 *   anything else, timeout, transport failure -> unavailable
 *
 * A 5xx is never reported as `invalid_key`: refusing to store a good key because
 * the provider was briefly down would be a worse failure than asking again.
 */
export async function validateProviderKey(
  provider: ProviderId,
  key: string
): Promise<ValidateKeyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    const res = await fetch(validateUrl(provider), {
      method: 'GET',
      headers: authHeaders(provider, key),
      signal: controller.signal,
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'invalid_key' };
    }
    return { ok: false, reason: 'unavailable' };
  } catch {
    // Abort (timeout) or transport failure — no key material to surface.
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

export class UnsupportedEndpointError extends Error {
  constructor(
    readonly provider: ProviderId,
    readonly endpoint: AiEndpoint
  ) {
    super(`${provider} does not serve the ${endpoint} endpoint`);
    this.name = 'UnsupportedEndpointError';
  }
}

/**
 * Forward a proxied AI request to a provider with the supplied key.
 *
 * The upstream timeout is enforced by the caller via `signal`; if it aborts, the
 * underlying fetch rejects and the caller maps it to `upstream_unavailable`.
 *
 * Throws `UnsupportedEndpointError` rather than guessing a URL when the provider
 * has no path for the endpoint. Callers are expected to have already ruled this
 * out via `resolveProvider`, so reaching it is a bug — but inventing
 * `https://openrouter.ai/api/v1/audio/transcriptions` and returning its 404
 * would turn that bug into a mystery.
 */
export async function forwardToProvider(
  provider: ProviderId,
  endpoint: AiEndpoint,
  payload: unknown,
  apiKey: string,
  signal: AbortSignal
): Promise<{ status: number; body: ArrayBuffer; usage: UpstreamUsage | null }> {
  const url = endpointUrl(provider, endpoint);
  if (url === null) throw new UnsupportedEndpointError(provider, endpoint);

  const { body, contentType } = buildRequestBody(payload);

  const headers: Record<string, string> = {
    // The one and only outbound attachment of a provider key.
    ...authHeaders(provider, apiKey),
  };
  if (contentType) headers['Content-Type'] = contentType;

  const res = await fetch(url, { method: 'POST', headers, body, signal });

  const responseBody = await res.arrayBuffer();
  return {
    status: res.status,
    body: responseBody,
    usage: parseUsage(responseBody),
  };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

/**
 * Build the outbound request body. Already-encoded bodies (strings, binary,
 * `FormData` for the transcribe endpoint, etc.) pass through untouched so `fetch`
 * can set the appropriate Content-Type — notably the multipart boundary, which we
 * must not compute ourselves. Plain objects (chat / vision JSON) are JSON-encoded.
 */
function buildRequestBody(payload: unknown): {
  body: BodyInit | undefined;
  contentType: string | undefined;
} {
  if (payload == null) {
    return { body: undefined, contentType: undefined };
  }
  if (
    typeof payload === 'string' ||
    payload instanceof ArrayBuffer ||
    ArrayBuffer.isView(payload) ||
    payload instanceof Blob ||
    payload instanceof FormData ||
    payload instanceof URLSearchParams ||
    payload instanceof ReadableStream
  ) {
    return { body: payload as BodyInit, contentType: undefined };
  }
  return { body: JSON.stringify(payload), contentType: 'application/json' };
}

/**
 * Parse OpenAI-shaped token usage from a response body when present.
 *
 * Returns null for streaming (SSE) bodies, non-JSON bodies, and responses with no
 * `usage` object. Missing individual counts default to 0.
 */
function parseUsage(body: ArrayBuffer): UpstreamUsage | null {
  try {
    const text = new TextDecoder().decode(body);
    if (text.trim().length === 0) return null;

    const parsed = JSON.parse(text) as { usage?: unknown };
    const usage = parsed?.usage;
    if (!usage || typeof usage !== 'object') return null;

    const u = usage as Record<string, unknown>;
    const prompt = u.prompt_tokens;
    const completion = u.completion_tokens;
    const total = u.total_tokens;

    // Require at least one recognisable count to consider this real usage.
    if (
      typeof prompt !== 'number' &&
      typeof completion !== 'number' &&
      typeof total !== 'number'
    ) {
      return null;
    }

    return {
      prompt_tokens: typeof prompt === 'number' ? prompt : 0,
      completion_tokens: typeof completion === 'number' ? completion : 0,
      total_tokens: typeof total === 'number' ? total : 0,
    };
  } catch {
    return null;
  }
}
