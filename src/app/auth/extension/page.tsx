import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { isValidDeviceCode, isValidUuid } from '@/lib/auth/desktop-tokens';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

import { approveExtension } from './actions';

/**
 * `/auth/extension?device_code=...&device_id=...`
 *
 * Sign-in page for the Unviewable browser extension. Same device-code model as
 * the desktop app (/auth/desktop): the extension generates the code, the signed-in
 * user approves it here, and the extension redeems it at /api/desktop/exchange for
 * a refresh + access token.
 *
 * Unlike /auth/desktop, approval is an explicit button press (a POST), never a
 * side effect of loading the page. See the note in ./actions.ts for why.
 *
 * Cookie-protected by src/proxy.ts, so an anonymous visitor is sent to /login and
 * returned here with the query string intact.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connect the browser extension',
  robots: { index: false },
};

interface PageProps {
  searchParams: Promise<{ device_code?: string; device_id?: string }>;
}

export default async function AuthExtensionPage({ searchParams }: PageProps) {
  const { device_code, device_id } = await searchParams;

  if (!isValidDeviceCode(device_code) || !isValidUuid(device_id)) {
    redirect('/login');
  }

  const sb = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    const ret = encodeURIComponent(
      `/auth/extension?device_code=${device_code}&device_id=${device_id}`
    );
    redirect(`/login?redirectedFrom=${ret}`);
  }

  return (
    <SiteShell hideFooter>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Browser extension</p>
          <h1>Connect the Unviewable extension?</h1>
          <p className="lede">
            This lets the extension save jobs to your tracker and check your
            resume match for <strong>{user.email ?? 'your account'}</strong>.
          </p>
          <p className="lede">
            Only continue if you just clicked <em>Connect</em> in the extension
            yourself. If someone sent you this link, close this tab.
          </p>
          <form action={approveExtension}>
            <input type="hidden" name="device_code" value={device_code} />
            <input type="hidden" name="device_id" value={device_id} />
            <button type="submit" className="cta cta-primary">
              Connect extension
            </button>
          </form>
          <p className="lede">
            <Link href="/account">Cancel</Link>
          </p>
        </div>
      </section>
    </SiteShell>
  );
}
