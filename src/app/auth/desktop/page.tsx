import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { isValidDeviceCode, isValidUuid } from '@/lib/auth/desktop-tokens';

import { approveDesktop } from './actions';

/**
 * `/auth/desktop?device_code=...&device_id=...`
 *
 * The bridge page that runs after the user signs in on the website. The
 * Unviewable_Desktop EXE opened the user's default browser to this URL
 * with a freshly-generated 43-char base64url device_code and a UUIDv4
 * device_id. After we confirm the user has an authenticated Supabase
 * session, we ask them to confirm. Only on that click (./actions.ts) is the
 * device_code (hashed) recorded in `desktop_link_codes`; the browser then
 * goes to /auth/desktop/open, which redirects to
 * `unviewable://auth/callback?...` for Windows to hand back to the EXE.
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

  // Nothing is recorded on page load. The link code is stored only when the
  // user clicks "Sign in the desktop app" (./actions.ts explains why), which
  // then continues to /auth/desktop/open for the unviewable:// hand-off.
  return (
    <SiteShell hideFooter>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Desktop app</p>
          <h1>Sign in the Unviewable desktop app?</h1>
          <p className="lede">
            This signs the desktop app in as{' '}
            <strong>{user.email ?? 'your account'}</strong>.
          </p>
          <p className="lede">
            Only continue if you just clicked <em>Sign in</em> in the desktop app
            yourself. If someone sent you this link, close this tab.
          </p>
          <form action={approveDesktop}>
            <input type="hidden" name="device_code" value={device_code} />
            <input type="hidden" name="device_id" value={device_id} />
            <button type="submit" className="cta cta-primary">
              Sign in the desktop app
            </button>
          </form>
        </div>
      </section>
    </SiteShell>
  );
}
