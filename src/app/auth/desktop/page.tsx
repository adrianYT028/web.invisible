import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  isValidDeviceCode,
  isValidUuid,
  sha256Hex,
} from '@/lib/auth/desktop-tokens';

import RedirectToDesktop from './RedirectToDesktop';

/**
 * `/auth/desktop?device_code=...&device_id=...`
 *
 * The bridge page that runs after the user signs in on the website. The
 * Unviewable_Desktop EXE opened the user's default browser to this URL
 * with a freshly-generated 43-char base64url device_code and a UUIDv4
 * device_id. After we confirm the user has an authenticated Supabase
 * session, we record the device_code (hashed) in `desktop_link_codes`
 * and then redirect the browser to `unviewable://auth/callback?...`
 * which Windows hands back to the EXE.
 *
 * The desktop then redeems the device_code at /api/desktop/exchange to
 * obtain a refresh + access token. Property P2 (single-use device code)
 * is enforced by the atomic UPDATE inside the exchange route.
 *
 * Validates: 2.4, 2.6
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Linking your desktop',
  alternates: { canonical: '/auth/desktop' },
  robots: { index: false },
};

interface PageProps {
  searchParams: Promise<{ device_code?: string; device_id?: string }>;
}

export default async function AuthDesktopPage({ searchParams }: PageProps) {
  const { device_code, device_id } = await searchParams;

  // Sanity check the inputs early. Anything malformed: send back to /login
  // with no error message — this page is reached via a desktop redirect, so
  // a malformed entry is almost always a stale bookmark or a tampered URL,
  // and we don't want to leak details about the validation rules.
  if (!isValidDeviceCode(device_code) || !isValidUuid(device_id)) {
    redirect('/login');
  }

  // If the user isn't signed in yet, bounce to /login preserving the full
  // /auth/desktop URL in `redirectedFrom` so they come back here after
  // sign-in (LoginClient already reads `redirectedFrom` from query string).
  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    const ret = encodeURIComponent(
      `/auth/desktop?device_code=${device_code}&device_id=${device_id}`
    );
    redirect(`/login?redirectedFrom=${ret}`);
  }

  // Insert the link-code row server-side using the service-role client so
  // RLS doesn't block us. The exchange route will look it up by SHA-256
  // hash. We do this here (not by calling /api/desktop/link) because we
  // already have a verified Supabase session on this server-rendered
  // request, and avoiding the extra fetch saves ~200ms on cold start.
  const admin = supabaseAdmin();
  const codeHash = sha256Hex(device_code);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
  const { error } = await admin.from('desktop_link_codes').insert({
    user_id: user.id,
    device_code_hash: codeHash,
    device_id,
    expires_at: expiresAt,
  });
  if (error) {
    // We deliberately don't expose the DB error to the user. The desktop
    // will time out waiting for the unviewable:// callback and prompt the
    // user to try again.
    console.error('desktop_link_codes insert failed:', error.message);
  }

  // Browser-side redirect to unviewable://. Cannot do this from the server
  // because Next.js's `redirect()` only emits absolute or http(s)/relative
  // URLs — custom protocols must be set on `window.location`.
  return (
    <SiteShell hideFooter>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Linking your desktop</p>
          <h1>Sending you back to Unviewable…</h1>
          <p className="lede">
            Signed in as <strong>{user.email ?? 'your account'}</strong>. If the
            desktop app does not pop up in a few seconds, you can close this
            tab and try launching Unviewable again.
          </p>
          <RedirectToDesktop deviceCode={device_code!} />
        </div>
      </section>
    </SiteShell>
  );
}
