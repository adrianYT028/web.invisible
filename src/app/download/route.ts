import { NextResponse, type NextRequest } from 'next/server';

import { SITE_META } from '@/components/constants/site-meta';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

/**
 * `/download` — login-gated download dispatcher.
 *
 * The marketing pages (`/`, `/downloads`) are public so Google and AI
 * answer engines can index them, but the actual installer should only be
 * handed out to signed-in users. Every "Download for Windows" CTA points
 * here instead of linking the release URL directly.
 *
 * Flow:
 *   - Signed-in visitor  → 302 redirect to `SITE_META.downloadUrl` (the
 *     public GitHub release asset), so the browser begins the download.
 *   - Anonymous visitor  → 302 redirect to
 *     `/login?redirectedFrom=%2Fdownload`. After a successful login,
 *     `LoginClient` reads `redirectedFrom` and returns the user to
 *     `/download`, which then dispatches them to the file — a seamless
 *     "log in, then your download starts" round-trip.
 *
 * Honest scope note: the release asset itself is a public GitHub URL, so
 * this gates the *website flow*, not the file. Truly locking the binary
 * would require moving it off public GitHub (private repo + token, or
 * Supabase Storage signed URLs) — a separate task.
 *
 * `force-dynamic` because the route reads the Supabase session cookie on
 * every request; it must never be statically cached.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { origin } = new URL(request.url);

  if (!user) {
    return NextResponse.redirect(
      `${origin}/login?redirectedFrom=%2Fdownload`,
      { status: 302 },
    );
  }

  return NextResponse.redirect(SITE_META.downloadUrl, { status: 302 });
}
