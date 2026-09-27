import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { isValidDeviceCode } from '@/lib/auth/desktop-tokens';

import RedirectToDesktop from '../RedirectToDesktop';

/**
 * `/auth/desktop/open?device_code=...`
 *
 * Second step of desktop sign-in, reached only after the user clicked "Sign in
 * the desktop app" on /auth/desktop (see ../actions.ts). It records nothing; it
 * just hands the device code back to the app over unviewable://, exactly as the
 * old single-step page did. The code here is one the app generated and already
 * knows, so it is not a secret from the app or the user.
 *
 * Cookie-protected by src/proxy.ts like every non-public page.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Opening the desktop app',
  robots: { index: false },
};

interface PageProps {
  searchParams: Promise<{ device_code?: string }>;
}

export default async function OpenDesktopPage({ searchParams }: PageProps) {
  const { device_code } = await searchParams;
  if (!isValidDeviceCode(device_code)) redirect('/login');

  return (
    <SiteShell hideFooter>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Desktop app</p>
          <h1>Sending you back to Unviewable…</h1>
          <p className="lede">
            If the desktop app does not open in a few seconds, use the button
            below, or close this tab and launch Unviewable again.
          </p>
          <RedirectToDesktop deviceCode={device_code} />
        </div>
      </section>
    </SiteShell>
  );
}
