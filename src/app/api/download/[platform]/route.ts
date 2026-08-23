import { NextResponse } from 'next/server';

import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { jsonError, logSafe } from '@/lib/http';
import { getRequestIp, rateLimitDownloadByUser } from '@/lib/ratelimit';
import { hasDownloadAccess } from '@/lib/payments/entitlements';
import {
  createSignedDownloadUrl,
  getLatestRelease,
  isPlatform,
  recordDownloadEvent,
} from '@/lib/releases';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// GET /api/download/[platform] — the ONLY way to obtain the installer.
//
// This route is the fix for the bypass that made the paywall decorative. The
// old flow shipped a public GitHub Releases URL to the browser (and into the
// JSON-LD in <head> on every page), so a single paying customer could publish
// one link and the gate was gone for everyone.
//
// Now: the binary sits in a PRIVATE Supabase Storage bucket, and this route
// hands out a signed URL that expires in 5 minutes — and only after checking
// `entitlements.download_access`. The object key never reaches a client.
//
// The response is a 302 to the signed URL. Because Storage serves it with
// `Content-Disposition: attachment`, following the redirect starts a file save
// instead of a navigation, so the caller's page stays put. `no-store` on the
// redirect is essential: a cached 302 would pin a URL that stops working when
// the signature expires.
//
// Fails CLOSED at every step. There is no fallback to a public URL anywhere in
// this file — an outage yields an error, never a free installer.
// -----------------------------------------------------------------------------

export async function GET(
  request: Request,
  context: { params: Promise<{ platform: string }> }
) {
  const { platform: rawPlatform } = await context.params;

  if (!isPlatform(rawPlatform)) {
    return jsonError(404, 'release_not_found', 'Unknown platform.');
  }
  const platform = rawPlatform;

  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return jsonError(401, 'not_authenticated');

  // Entitlement gate. `hasDownloadAccess` fails closed on a database error, so
  // a Supabase outage returns 402 rather than leaking the build.
  if (!(await hasDownloadAccess(user.id))) {
    logSafe('download_denied_unpaid', { user_id: user.id, platform });
    return jsonError(402, 'payment_required');
  }

  // Anti-redistribution throttle. Signed URLs expire quickly, so the way to
  // share a paid build is to script fresh URL generation; 30/hour makes that
  // slow while leaving genuine retries unaffected.
  const rl = await rateLimitDownloadByUser(user.id);
  if (!rl.ok) {
    logSafe('download_rate_limited', { user_id: user.id, platform });
    return jsonError(429, 'rate_limited');
  }

  const release = await getLatestRelease(platform);
  if (!release) {
    // Expected for `macos` until the mac client ships.
    logSafe('download_no_release', { user_id: user.id, platform });
    return jsonError(404, 'release_not_found');
  }

  const signedUrl = await createSignedDownloadUrl(release);
  if (!signedUrl) {
    // Entitled but we could not mint a URL. Explicitly a 503 so the client
    // retries — never a redirect to anything public.
    return jsonError(503, 'download_unavailable');
  }

  // Best-effort audit trail; must not block a paid download.
  await recordDownloadEvent({
    userId: user.id,
    release,
    ip: getRequestIp(request),
    userAgent: request.headers.get('user-agent'),
  });

  logSafe('download_granted', {
    user_id: user.id,
    platform,
    version: release.version,
  });

  return NextResponse.redirect(signedUrl, {
    status: 302,
    headers: {
      // The signed URL is short-lived and user-specific. It must never be
      // cached by a browser, a CDN, or Vercel's edge.
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
    },
  });
}
