import { NextResponse } from 'next/server';

// -----------------------------------------------------------------------------
// Error envelope shared across all API routes.
//
// { code: snake_case, message: human-readable (no secrets) }
//
// Stable codes (matched by the desktop AuthError enum):
//   invalid_input            400  malformed body / missing field
//   code_already_consumed    400  /api/desktop/exchange
//   code_expired             400  /api/desktop/exchange
//   unknown_code             400  /api/desktop/exchange
//   not_authenticated        401  cookie-protected pages and /api/desktop/link
//   missing_bearer           401  proxy.ts for desktop-bearer routes
//   invalid_access_token     401  proxy.ts, AI proxy, activity batch
//   invalid_refresh_token    401  /api/desktop/refresh, /api/desktop/signout
//   expired_refresh_token    401  /api/desktop/refresh
//   session_revoked          401  /api/desktop/refresh
//   plan_limit_exceeded      429  any /api/ai/*
//   rate_limited             429  proxy.ts rate limiter
//   upstream_failure         502  any /api/ai/*
//   internal_error           500  catch-all
//
// ai-proxy-key-vault additions (see design §3.3 error-code table):
//   invalid_groq_key         400  /api/keys: empty/whitespace/>512 or Groq rejects
//   validation_unavailable   503  /api/keys: Groq unreachable / >10s during validation
//   no_api_key               403  /api/ai/*: Free_Plan user, non-premium model, no stored key
//   premium_required         403  /api/ai/*: premium model requested by Free_Plan user
//   key_decrypt_failed       500  /api/ai/*: unknown master-key version or auth-tag failure
//   upstream_unavailable     502  /api/ai/*: upstream >60s or transport failure
//   removal_failed           500  /api/keys DELETE could not remove the row
//
// razorpay pay-to-download additions:
//   payment_not_configured   503  Razorpay env vars absent — checkout disabled
//   already_purchased        409  /api/payments/*: user already has the license
//   order_create_failed      502  Razorpay Orders API rejected or timed out
//   invalid_signature        400  webhook/checkout HMAC did not verify
//   payment_required         402  /api/download/*: no download entitlement
//   release_not_found        404  /api/download|releases: no published build
//   download_unavailable     503  entitled, but the signed URL could not be minted
// -----------------------------------------------------------------------------

export type ErrorCode =
  | 'invalid_input'
  | 'code_already_consumed'
  | 'code_expired'
  | 'unknown_code'
  | 'not_authenticated'
  | 'missing_bearer'
  | 'invalid_access_token'
  | 'invalid_refresh_token'
  | 'expired_refresh_token'
  | 'session_revoked'
  | 'plan_limit_exceeded'
  | 'rate_limited'
  | 'upstream_failure'
  | 'internal_error'
  | 'invalid_groq_key'
  | 'validation_unavailable'
  | 'no_api_key'
  | 'premium_required'
  | 'key_decrypt_failed'
  | 'upstream_unavailable'
  | 'removal_failed'
  | 'payment_not_configured'
  | 'already_purchased'
  | 'order_create_failed'
  | 'invalid_signature'
  | 'payment_required'
  | 'release_not_found'
  | 'download_unavailable';

export function jsonError(
  status: number,
  code: ErrorCode,
  message?: string
): NextResponse {
  return NextResponse.json(
    {
      code,
      message:
        message ??
        DEFAULT_MESSAGES[code] ??
        'An error occurred while processing your request.',
    },
    { status }
  );
}

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  invalid_input: 'Request payload is missing or malformed.',
  code_already_consumed: 'This sign-in link has already been used.',
  code_expired: 'This sign-in link has expired. Please try again.',
  unknown_code: 'This sign-in link is not recognized.',
  not_authenticated: 'You must be signed in to perform this action.',
  missing_bearer: 'Missing Authorization: Bearer header.',
  invalid_access_token: 'Access token is invalid or expired.',
  invalid_refresh_token: 'Refresh token is not recognized.',
  expired_refresh_token: 'Refresh token has expired.',
  session_revoked: 'This session has been revoked.',
  plan_limit_exceeded: 'You have reached your plan limit for today.',
  rate_limited: 'Too many requests. Please slow down.',
  upstream_failure: 'Upstream service did not respond successfully.',
  internal_error: 'An unexpected error occurred.',
  invalid_groq_key: 'The provided Groq key is missing or invalid.',
  validation_unavailable: 'Could not validate the key right now. Please try again.',
  no_api_key: 'No Groq key is on file. Add one in your account to enable AI.',
  premium_required: 'This model requires a premium plan.',
  key_decrypt_failed: 'The stored key could not be processed.',
  upstream_unavailable: 'The AI provider did not respond in time.',
  removal_failed: 'The key could not be removed. Please try again.',
  payment_not_configured:
    'Payments are temporarily unavailable. Please try again later.',
  already_purchased: 'You already own this. Head to the download page.',
  order_create_failed:
    'We could not start the payment. No money has left your account — please try again.',
  invalid_signature: 'Payment verification failed.',
  payment_required: 'Purchase required to download.',
  release_not_found: 'No release is published for this platform yet.',
  download_unavailable:
    'Your download link could not be generated. Please try again in a moment.',
};

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7).trim();
  return token.length > 0 ? token : null;
}

// -----------------------------------------------------------------------------
// Logging redaction (Req 10.1, 10.4; design §"Error Handling → Web").
//
// `logSafe(event, fields)` is the only sanctioned way to emit a structured log
// line from a route handler. It guarantees that the redaction denylist — the
// plaintext Groq_Key, Key_Ciphertext, Key_Nonce, Key_Auth_Tag, Access_Token,
// and Master_Key — never reaches the log sink, by:
//   1. Dropping any field whose NAME is on the denylist (e.g. `access_token`).
//   2. Recursively scanning every string VALUE and replacing anything that
//      matches a known secret pattern (Bearer tokens, `gsk_`/`sk-` keys, JWTs,
//      long base64 blobs) or a registered secret with '[REDACTED]'.
//   3. In development (NODE_ENV !== 'production'), THROWING if a value matched a
//      known secret, so a leak is caught loudly in tests/dev rather than
//      silently shipped. In production the value is redacted and logging
//      proceeds — observability must never become a credential leak.
// Dependency-free: uses only the Node/JS standard library.
// -----------------------------------------------------------------------------

const REDACTED = '[REDACTED]';

// Field names whose values are always secrets regardless of content.
const SECRET_FIELD_NAMES = new Set<string>([
  'api_key',
  'apikey',
  'plaintext',
  'plaintext_key',
  'groq_key',
  'groqkey',
  'key',
  'key_ciphertext',
  'ciphertext',
  'key_nonce',
  'nonce',
  'iv',
  'key_auth_tag',
  'auth_tag',
  'authtag',
  'tag',
  'access_token',
  'accesstoken',
  'bearer',
  'authorization',
  'token',
  'refresh_token',
  'master_key',
  'masterkey',
  'key_vault_secret',
]);

// Value shapes that look like a secret. Kept deliberately broad: over-redacting
// a diagnostic log line is always preferable to leaking a credential.
const SECRET_PATTERNS: readonly RegExp[] = [
  /gsk_[A-Za-z0-9]{8,}/, // Groq API keys
  /sk-[A-Za-z0-9]{16,}/, // OpenAI-style API keys
  /bearer\s+[A-Za-z0-9._~+/\-]+=*/i, // "Bearer <token>"
  /eyJ[A-Za-z0-9._-]{16,}/, // JWT-shaped tokens (access tokens)
  /[A-Za-z0-9+/]{40,}={0,2}/, // long base64 blobs (ciphertext / master key)
];

// Exact secret values registered at runtime (e.g. the Master_Key material).
// Lets logSafe catch a leaked secret even when it does not match a pattern.
const knownSecrets = new Set<string>();

/**
 * Register an exact secret value so logSafe redacts it and (in dev) asserts on
 * it. Short values are ignored to avoid pathological over-redaction. Modules
 * that hold secrets may call this without exposing the secret elsewhere.
 */
export function registerSecret(value: string | null | undefined): void {
  if (typeof value === 'string' && value.length >= 8) knownSecrets.add(value);
}

function redactString(input: string): { value: string; leaked: boolean } {
  let value = input;
  let leaked = false;

  for (const secret of knownSecrets) {
    if (secret && value.includes(secret)) {
      value = value.split(secret).join(REDACTED);
      leaked = true;
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes('i') ? 'gi' : 'g'
    );
    if (global.test(value)) {
      value = value.replace(global, REDACTED);
      leaked = true;
    }
  }

  return { value, leaked };
}

function redactValue(
  key: string | null,
  value: unknown
): { value: unknown; leaked: boolean } {
  // Denylisted field name: drop the value entirely (no leak flag — this is the
  // expected, sanctioned path for passing a known-secret field).
  if (key !== null && SECRET_FIELD_NAMES.has(key.toLowerCase())) {
    return { value: REDACTED, leaked: false };
  }

  if (typeof value === 'string') {
    const { value: redacted, leaked } = redactString(value);
    return { value: redacted, leaked };
  }

  if (Array.isArray(value)) {
    let leaked = false;
    const out = value.map((item) => {
      const r = redactValue(null, item);
      leaked = leaked || r.leaked;
      return r.value;
    });
    return { value: out, leaked };
  }

  if (value !== null && typeof value === 'object') {
    let leaked = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = redactValue(k, v);
      leaked = leaked || r.leaked;
      out[k] = r.value;
    }
    return { value: out, leaked };
  }

  return { value, leaked: false };
}

/**
 * Emit a redacted structured log line. Returns the redacted field object (handy
 * for tests). Throws in development if any field value matched a known secret.
 */
export function logSafe(
  event: string,
  fields: Record<string, unknown> = {}
): Record<string, unknown> {
  const { value, leaked } = redactValue(null, fields);
  const safeFields = value as Record<string, unknown>;

  if (leaked && process.env.NODE_ENV !== 'production') {
    throw new Error(
      `logSafe: refusing event "${event}" — a field value matched a known secret. ` +
        'Pass the secret under a denylisted field name or do not log it.'
    );
  }

  console.log(JSON.stringify({ event, ...safeFields }));
  return safeFields;
}
