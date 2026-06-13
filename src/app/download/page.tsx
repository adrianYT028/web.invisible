import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { SITE_META } from '@/components/constants/site-meta';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

import { DownloadStarter } from './DownloadStarter';

/**
 * `/download` — login-gated download interstitial.
 *
 * Why a page and not a bare redirect:
 *   The earlier version was a route handler that 302'd straight to the
 *   release asset. That worked for a logged-in click, but after the Google
 *   OAuth round-trip the redirect chain (Google → Supabase → /auth/callback
 *   → /download → .exe) *terminated in a file download*. A download does not
 *   render a page, so the browser was left stranded on the last HTML it had
 *   rendered — Google's account chooser — even though the file downloaded.
 *
 *   Rendering a real "your download is starting" page fixes that: the chain
 *   now ends on this page, and <DownloadStarter /> kicks off the file
 *   download client-side. Because the asset is served with
 *   Content-Disposition: attachment, starting it does not navigate away, so
 *   the visitor is left looking at this confirmation page instead of a
 *   stuck OAuth screen.
 *
 * Gating:
 *   Reads the Supabase session server-side. Anonymous visitors are sent to
 *   /login?redirectedFrom=%2Fdownload (after login they bounce back here and
 *   the download starts). The page is `noindex` — it is a transient action
 *   surface, not content.
 *
 * `force-dynamic` because the session cookie is read on every request.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Downloading Unviewable',
  robots: { index: false },
};

export default async function DownloadPage() {
  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?redirectedFrom=%2Fdownload');
  }

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Download</p>
          <h1>
            Your download is <em>starting</em>
          </h1>
          <p className="lede">
            Unviewable for Windows (v{SITE_META.softwareVersion}) should begin
            downloading automatically. If it doesn&apos;t start in a few
            seconds, use the button below.
          </p>
          <DownloadStarter url={SITE_META.downloadUrl} />
        </div>
      </section>
    </SiteShell>
  );
}
