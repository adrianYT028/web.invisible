import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { SiteShell } from '@/components/chrome/SiteShell';
import { createSupabaseRouteClient } from '@/lib/supabase/route';
import { hasDownloadAccess } from '@/lib/payments/entitlements';
import { getLatestRelease } from '@/lib/releases';
import {
  DOWNLOAD_LICENSE_PRICE,
  formatInr,
  formatInrCompact,
  formatGstRate,
  formatPriceDisclosure,
} from '@/lib/payments/pricing';

import { DownloadStarter } from './DownloadStarter';
import { CheckoutButton } from './CheckoutButton';

/**
 * `/download` — login-gated, entitlement-aware purchase-or-download page.
 *
 * Two states, decided server-side:
 *
 *   NOT ENTITLED -> price breakdown + <CheckoutButton /> (Razorpay).
 *   ENTITLED     -> <DownloadStarter /> pointing at /api/download/windows.
 *
 * Why the interstitial page (not a bare redirect):
 *   An earlier version 302'd straight to the release asset. After the Google
 *   OAuth round-trip, the chain (Google -> Supabase -> /auth/callback ->
 *   /download -> .exe) *terminated in a file download*. A download does not
 *   render a page, so the browser was left showing Google's account chooser
 *   even though the file had downloaded. Rendering a real page fixes that.
 *
 * Gating:
 *   Anonymous visitors go to /login?redirectedFrom=%2Fdownload and bounce back
 *   here. Entitlement is read with the service-role client, and the installer
 *   itself is protected independently by /api/download/[platform] — so even a
 *   hand-crafted request cannot skip payment by hitting the API directly.
 *
 * `noindex`: transient action surface, not content. The public marketing page
 * is /downloads.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Download Unviewable',
  robots: { index: false },
};

const PLATFORM = 'windows' as const;

export default async function DownloadPage() {
  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login?redirectedFrom=%2Fdownload');
  }

  const [entitled, release] = await Promise.all([
    hasDownloadAccess(user.id),
    getLatestRelease(PLATFORM),
  ]);

  // ---------------------------------------------------------------------------
  // Entitled — hand over the build.
  // ---------------------------------------------------------------------------
  if (entitled) {
    if (!release) {
      // Paid, but nothing published. Never a dead end without an explanation.
      return (
        <SiteShell>
          <section className="account-section">
            <div className="account-inner">
              <p className="eyebrow">Download</p>
              <h1>
                No build <em>available</em>
              </h1>
              <p className="lede">
                Your purchase is active, but there is no published Windows build
                right now. This is on us, not you — please check back shortly.
                Your access does not expire.
              </p>
            </div>
          </section>
        </SiteShell>
      );
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
              Unviewable for Windows (v{release.version}) should begin
              downloading automatically. If it doesn&apos;t start in a few
              seconds, use the button below.
            </p>
            <DownloadStarter
              href={`/api/download/${PLATFORM}`}
              fileName={release.fileName}
            />
            {release.sha256 ? (
              <p className="download-checksum">
                SHA-256 <code>{release.sha256}</code>
              </p>
            ) : null}
            <p className="download-note">
              Your license is permanent. You can come back to this page and
              re-download at any time.
            </p>
          </div>
        </section>
      </SiteShell>
    );
  }

  // ---------------------------------------------------------------------------
  // Not entitled — sell it.
  //
  // GST-exclusive pricing means the advertised ₹99 is NOT what gets debited.
  // The total is stated plainly here and again on the button, because a
  // surprise delta at the Razorpay sheet is the most common cause of abandoned
  // checkouts and payment disputes.
  // ---------------------------------------------------------------------------
  const price = DOWNLOAD_LICENSE_PRICE;

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner">
          <p className="eyebrow">Get Unviewable</p>
          <h1>
            One payment, <em>yours for good</em>
          </h1>
          <p className="lede">
            Unviewable for Windows
            {release ? ` (v${release.version})` : ''} is a one-time purchase.
            No subscription, and no recurring charge.
          </p>

          <div className="surface">
            <ul className="price-breakdown">
              <li>
                <span>Unviewable for Windows — lifetime license</span>
                <span>{formatInrCompact(price.baseAmountPaise)}</span>
              </li>
              <li>
                <span>GST ({formatGstRate(price.gstBps)})</span>
                <span>{formatInr(price.gstAmountPaise)}</span>
              </li>
              <li className="price-breakdown-total">
                <span>Total payable</span>
                <span>{formatInr(price.totalAmountPaise)}</span>
              </li>
            </ul>
            <p className="price-note">
              Prices in INR. Payments are processed in India via Razorpay (UPI,
              cards, netbanking, wallets).
            </p>
          </div>

          <CheckoutButton
            label={`Pay ${formatInr(price.totalAmountPaise)}`}
            priceDisclosure={formatPriceDisclosure(price)}
          />

          <p className="download-note">
            Your license covers the current Windows feature set, permanently.
            Read the{' '}
            <a href="/terms">Terms</a> and{' '}
            <a href="/refund">Refund Policy</a> before purchasing.
          </p>
        </div>
      </section>
    </SiteShell>
  );
}
