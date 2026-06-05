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
  | 'internal_error';

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
};

export function extractBearer(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const token = auth.slice(7).trim();
  return token.length > 0 ? token : null;
}
