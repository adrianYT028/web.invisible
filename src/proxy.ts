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
  // Marketing / content pages: crawlable and indexable so Google and AI
  // answer engines can surface them. These pages carry no private data —
  // the downloads page links to the purchase flow, and the guides are
  // public documentation. The installer itself is served only by
  // /api/download/[platform] after an entitlement check, so making these
  // pages public does not expose the file to anonymous users.
  if (pathname === '/downloads') return true;
  if (pathname === '/guides/setup') return true;
  if (pathname === '/guides/usage') return true;
  if (pathname === '/feedback') return true;
  // The /download page runs its own session check and redirects anonymous
  // users to /login itself (see src/app/download/page.tsx), so it is "public"
  // to the middleware. Gating happens in two places the middleware does not
  // need to know about: that page checks the session and the entitlement to
  // decide whether to show checkout or the download, and
  // /api/download/[platform] independently re-checks both before minting a
  // signed URL. The middleware is deliberately not the authority here.
  if (pathname === '/download') return true;
  // Policy pages. These MUST be reachable anonymously: Razorpay's activation
  // review fetches them without a session, and cookie-gating them would fail
  // onboarding. They contain no user data.
  if (pathname === '/terms') return true;
  if (pathname === '/privacy') return true;
  if (pathname === '/refund') return true;
  if (pathname === '/contact') return true;
  if (pathname === '/about') return true;
  // Generated social-share images (next/og). Social platforms and AI
  // crawlers fetch these unauthenticated, so they must never be gated.
  if (pathname === '/opengraph-image') return true;
  if (pathname === '/twitter-image') return true;
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
