import { NextResponse, type NextRequest } from 'next/server';

import { createServerClient } from '@supabase/ssr';

import { env } from '@/lib/env';
import { verifyAccessToken } from '@/lib/auth/desktop-tokens';
import { extractBearer, jsonError } from '@/lib/http';

// -----------------------------------------------------------------------------
// Path classifications
// -----------------------------------------------------------------------------
//
// Three categories of routes:
//
//  1. Public — no auth check (browser pages, static assets)
//  2. Cookie-protected — must have a valid Supabase session cookie
//  3. Desktop-bearer-protected — must have a valid Authorization: Bearer
//     header carrying a desktop access token (HS256 JWT)
//
// Any /api/* path NOT in the bearer or open-bearer lists is currently treated
// as public for backwards compatibility with the existing /api/reviews and
// /api/signups routes. New routes should opt in to the appropriate list.

function isPublicPath(pathname: string) {
  if (pathname === '/') return true;
  if (pathname === '/login') return true;
  if (pathname === '/login/reset') return true;
  if (pathname === '/auth/callback') return true;
  if (pathname.startsWith('/_next')) return true;
  if (pathname === '/favicon.ico') return true;
  if (pathname === '/favicon.svg') return true;
  if (pathname.match(/\.(?:png|jpg|jpeg|gif|webp|svg|ico|txt|xml)$/i)) return true;
  return false;
}

// Routes the desktop calls WITHOUT a bearer token (the bearer doesn't exist
// yet, or the token's authorization model is the body field itself).
const DESKTOP_OPEN_PATHS = [
  '/api/desktop/exchange',
  '/api/desktop/refresh',
  '/api/desktop/signout',
];

// Routes the desktop calls WITH a bearer access token (verified here, with
// claims forwarded as headers to the route handler).
const DESKTOP_BEARER_PATHS = [
  '/api/ai/chat',
  '/api/ai/transcribe',
  '/api/ai/vision',
  '/api/activity/batch',
];

// All other /api/* routes are passed through (legacy + cookie-protected
// routes called from the website itself, e.g. /api/desktop/link and
// /api/account/signout-all, which read the Supabase cookie inside the
// route handler).
function isApiPassthrough(pathname: string) {
  return pathname.startsWith('/api');
}

function isBearerProtected(pathname: string) {
  return DESKTOP_BEARER_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  );
}

function isOpenDesktopRoute(pathname: string) {
  return DESKTOP_OPEN_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + '/')
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static / public pages.
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Bearer-protected routes: verify the access token here so route handlers
  // can trust x-uvw-user-id / x-uvw-device-id headers (Property P1).
  if (isBearerProtected(pathname)) {
    const token = extractBearer(request);
    if (!token) return jsonError(401, 'missing_bearer');
    const claims = await verifyAccessToken(token);
    if (!claims) return jsonError(401, 'invalid_access_token');

    const headers = new Headers(request.headers);
    headers.set('x-uvw-user-id', claims.sub);
    headers.set('x-uvw-device-id', claims.device_id);
    return NextResponse.next({ request: { headers } });
  }

  // Open desktop routes (exchange/refresh/signout) and any other /api/* —
  // pass through and let the route handler do its own validation.
  if (isOpenDesktopRoute(pathname) || isApiPassthrough(pathname)) {
    return NextResponse.next();
  }

  // Cookie-protected pages: existing logic.
  const response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          request.cookies.set({ name, value, ...options });
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const loginUrl = request.nextUrl.clone();
    // Preserve the full original path INCLUDING query string so that, after
    // sign-in, LoginClient can return the user to the exact URL (critical for
    // /auth/desktop?device_code=...&device_id=... — the codes must survive
    // the round-trip through /login).
    const original = pathname + request.nextUrl.search;
    loginUrl.pathname = '/login';
    loginUrl.search = ''; // drop any inherited params; set only what we need
    loginUrl.searchParams.set('redirectedFrom', original);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
