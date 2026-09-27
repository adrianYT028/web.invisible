import { verifyAccessToken } from '@/lib/auth/desktop-tokens';
import { extractBearer } from '@/lib/http';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

// -----------------------------------------------------------------------------
// resolveRequestUserId — "cookie OR bearer" authentication for web API routes
// -----------------------------------------------------------------------------
//
// Most /api/* routes are called from the website and authenticate with the
// Supabase session cookie. The browser extension cannot use that cookie (it runs
// on a chrome-extension:// origin, and cookie-authenticated cross-origin calls
// would need CSRF defences these routes do not have), so it authenticates the
// same way the desktop app does: an HS256 access token from the
// /api/desktop/exchange device-code flow, sent as `Authorization: Bearer`.
//
// Rules, and why:
//
//   1. A bearer header, when present, is AUTHORITATIVE. If it is invalid the
//      request is rejected — we do NOT fall back to the cookie. Falling back would
//      make an expired extension token silently act as whoever happens to be
//      signed in on the site, which is a confusing identity switch at best.
//
//   2. The token is verified HERE, in the route, not by src/proxy.ts. Adding these
//      paths to the proxy's bearer list would 401 every cookie-authenticated
//      website call to them.
//
//   3. `x-uvw-user-id` is NEVER read. The proxy only sets (and overwrites) it on
//      its own bearer paths; on passthrough paths like these a client could send
//      it themselves, so trusting it would be an authentication bypass.
// -----------------------------------------------------------------------------

export type RequestAuth =
  | { ok: true; userId: string; via: 'bearer' | 'cookie' }
  | { ok: false; code: 'not_authenticated' | 'invalid_access_token' };

export async function resolveRequestUser(request: Request): Promise<RequestAuth> {
  const token = extractBearer(request);
  if (token) {
    const claims = await verifyAccessToken(token);
    if (!claims) return { ok: false, code: 'invalid_access_token' };
    return { ok: true, userId: claims.sub, via: 'bearer' };
  }

  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return { ok: false, code: 'not_authenticated' };
  return { ok: true, userId: user.id, via: 'cookie' };
}
