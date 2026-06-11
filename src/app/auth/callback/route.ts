import { NextResponse } from 'next/server';

import { createSupabaseRouteClient } from '@/lib/supabase/route';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const rawNext = url.searchParams.get('next') || '/';

  // Open-redirect guard: only allow same-origin relative paths. Reject
  // absolute URLs (http://evil), protocol-relative (//evil), and anything
  // not starting with a single '/'. This `next` carries the device-link URL
  // (/auth/desktop?device_code=...) for the Google OAuth flow.
  const next =
    rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  if (!code) {
    const loginUrl = new URL('/login', url.origin);
    return NextResponse.redirect(loginUrl);
  }

  const supabase = await createSupabaseRouteClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    const loginUrl = new URL('/login', url.origin);
    loginUrl.searchParams.set('error', 'oauth_failed');
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
