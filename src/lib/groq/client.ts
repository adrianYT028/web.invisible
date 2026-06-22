// -----------------------------------------------------------------------------
// Groq client wrapper
// -----------------------------------------------------------------------------
//
// A thin `fetch` wrapper that is the ONLY place a Groq key (user-supplied or
// the platform `GROQ_API_KEY`) is attached to an outbound request. Two
// responsibilities used by the AI Proxy + Key Vault feature:
//
//   validateGroqKey(key)  — cheapest authenticated Groq call, used before a
//                            key is stored (Req 1.3–1.5). 10s timeout.
//   forwardToGroq(...)    — forward a proxied AI request with the supplied
//                            bearer key (Req 3.6, 3.7). The caller owns the
//                            60s upstream timeout via the passed AbortSignal.
//
// Security: the bearer key is attached to the outbound request and nowhere
// else — it is never logged, returned, or written to the response body.

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

/** Endpoint → upstream URL. `vision` uses the chat-completions endpoint with
 *  image content, so it maps to the same URL as `chat`. */
const ENDPOINT_URLS: Record<GroqEndpoint, string> = {
  chat: `${GROQ_BASE_URL}/chat/completions`,
  transcribe: `${GROQ_BASE_URL}/audio/transcriptions`,
  vision: `${GROQ_BASE_URL}/chat/completions`,
};

/** Validation request timeout (Req 1.3/1.5). */
const VALIDATION_TIMEOUT_MS = 10_000;

export type GroqEndpoint = 'chat' | 'transcribe' | 'vision';

/** Token accounting parsed from an OpenAI-shaped Groq response, when present. */
export interface GroqUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type ValidateGroqKeyResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_key' | 'unavailable' };

/**
 * Lightweight validation request used before storing a key (Req 1.3).
 *
 * Performs the cheapest authenticated Groq call — `GET /models` with
 * `Authorization: Bearer <key>` — under a 10s `AbortController`:
 *   - 200            → { ok: true }
 *   - 401 / 403      → { ok: false, reason: 'invalid_key' }      (Req 1.4)
 *   - timeout / network / 5xx (and anything else)
 *                    → { ok: false, reason: 'unavailable' }      (Req 1.5)
 */
export async function validateGroqKey(
  key: string
): Promise<ValidateGroqKeyResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
  try {
    const res = await fetch(`${GROQ_BASE_URL}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'invalid_key' };
    }
    // 5xx and any other unexpected status → treat as unavailable, never as a
    // definitive "invalid key" verdict.
    return { ok: false, reason: 'unavailable' };
  } catch {
    // Abort (timeout) or transport failure — no key material to surface.
    return { ok: false, reason: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Forward a proxied AI request with the supplied bearer key. This is the ONLY
 * place an outbound Groq key is attached (Req 3.6).
 *
 * The 60s upstream timeout (Req 3.7) is enforced by the caller via `signal`;
 * if it aborts, the underlying `fetch` rejects and the caller maps it to
 * `upstream_unavailable`.
 *
 * Returns the upstream status, the raw response body (verbatim, so the route
 * can pass it through unchanged), and parsed token usage when the response
 * carries it — otherwise `null`.
 */
export async function forwardToGroq(
  endpoint: GroqEndpoint,
  payload: unknown,
  apiKey: string,
  signal: AbortSignal
): Promise<{ status: number; body: ArrayBuffer; usage: GroqUsage | null }> {
  const { body, contentType } = buildRequestBody(payload);

  const headers: Record<string, string> = {
    // The one and only outbound attachment of a Groq key.
    Authorization: `Bearer ${apiKey}`,
  };
  if (contentType) headers['Content-Type'] = contentType;

  const res = await fetch(ENDPOINT_URLS[endpoint], {
    method: 'POST',
    headers,
    body,
    signal,
  });

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
 * `FormData` for the transcribe endpoint, etc.) pass through untouched so
 * `fetch` can set the appropriate Content-Type (e.g. multipart boundaries).
 * Plain objects (chat / vision JSON payloads) are JSON-encoded.
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
    // Let fetch infer the Content-Type for these encoded body types.
    return { body: payload as BodyInit, contentType: undefined };
  }
  return { body: JSON.stringify(payload), contentType: 'application/json' };
}

/**
 * Parse OpenAI/Groq-shaped token usage from a response body when present.
 * Returns `null` for streaming (SSE) bodies, non-JSON bodies, or responses
 * without a `usage` object. Missing individual counts default to 0.
 */
function parseUsage(body: ArrayBuffer): GroqUsage | null {
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

    // Require at least one recognizable count to consider this real usage.
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
