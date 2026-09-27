import type { Metadata } from 'next';

import { SiteShell } from '@/components/chrome/SiteShell';
import { CheckoutButton } from '@/app/download/CheckoutButton';
import { hasDownloadAccess } from '@/lib/payments/entitlements';
import { readEffectivePlan } from '@/lib/plans/read-plan';
import {
  PLATFORM_SERVICES,
  SERVICE_LABELS,
  isBundlePlan,
  type PlatformService,
} from '@/lib/plans/services';
import {
  FULL_ACCESS_PRICE,
  FULL_ACCESS_PRODUCT,
  formatGstRate,
  formatInr,
  formatInrCompact,
  formatPriceDisclosure,
} from '@/lib/payments/pricing';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

/**
 * `/pricing` — the one thing that can be bought, and everything it unlocks.
 *
 * Entitlement-aware, decided server-side: a visitor who already owns something
 * is shown what they own rather than being sold it again. The order route also
 * refuses a duplicate purchase with a 409, so this is presentation, not the
 * enforcement.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS INCLUDED IS DERIVED, NOT WRITTEN
 *
 * The feature list comes from `PLATFORM_SERVICES` and `SERVICE_LABELS` — the same
 * registry `hasServiceAccess` gates on. Hand-writing it here would let the sales
 * copy drift from what the code actually unlocks, which is the version of this
 * bug that costs a refund.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Free: ATS check, daily resume match, job openings, a 50-job tracker and interview practice. Full access is one payment for more of everything plus the desktop app.',
  alternates: { canonical: '/pricing' },
};

/** One line per service, describing what FULL ACCESS adds, in the user's terms. */
const SERVICE_BLURBS: Record<PlatformService, string> = {
  resume:
    '20 uploads and 40 match scores a day, stronger wording, downloadable resume, and 10 LinkedIn rewrites a day.',
  jobs: 'Unlimited saved jobs, on top of the free openings and tracker.',
  outreach:
    'Prepare a batch of applications at once: match, rewrite, draft the cold email, find the contact.',
  desktop: 'The Windows app for notes on screen during the real interview, plus 10 practice sessions a day.',
};

/**
 * What every account gets without paying. Kept in step with the free caps in
 * migrations 011 and 023 (1 upload + 1 scan a day, 50 saved jobs, 1 LinkedIn
 * rewrite and 1 interview practice session a day).
 */
const FREE_FEATURES: readonly string[] = [
  'Free ATS check, no sign-up needed',
  'One resume check against a job every day, with the full report',
  'Job openings matched to your resume',
  'Job tracker for up to 50 jobs, with follow-up reminders',
  'Browser extension to save jobs from any site',
  'One interview practice session and one LinkedIn rewrite a day',
];

/**
 * Filled circle with a check. Authored SVG rather than a "✓" character: a text
 * glyph inherits the font's metrics and baseline, so it never aligns with the line
 * it labels and its weight changes with the typeface. `currentColor` lets one mark
 * serve both themes.
 */
function CheckMark() {
  return (
    <svg
      className="plan-check"
      viewBox="0 0 20 20"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="10" cy="10" r="9" fill="currentColor" opacity="0.16" />
      <path
        d="M6 10.4l2.6 2.6L14.2 7.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The circular arrow that sits at the right end of the reference's CTA pill. */
function ArrowBadge() {
  return (
    <span className="plan-cta-badge" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
        <path
          d="M4.5 11.5L11.5 4.5M11.5 4.5H5.75M11.5 4.5V10.25"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export default async function PricingPage() {
  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Anonymous visitors still see the full page — it is a marketing surface. Only
  // the ownership state and the buy controls differ.
  let plan = 'free';
  let downloadAccess = false;
  if (user) {
    const admin = supabaseAdmin();
    [plan, downloadAccess] = await Promise.all([
      readEffectivePlan(admin, user.id),
      hasDownloadAccess(user.id),
    ]);
  }

  const ownsBundle = isBundlePlan(plan);
  // Bought the ₹99 licence back when ₹99 bought only the desktop app. They own the
  // whole product now without paying again, and the copy below says so rather than
  // leaving them to wonder.
  const ownsDesktopOnly = !ownsBundle && downloadAccess;
  // Ownership is the OR of the two markers, matching `alreadyOwns` in the order
  // route. Checking only the plan would show a buy button to the eight existing
  // licence holders and charge them twice.
  const alreadyOwns = ownsBundle || downloadAccess;

  const bundle = FULL_ACCESS_PRICE;

  return (
    <SiteShell>
      <section className="account-section">
        <div className="account-inner account-inner--wide">
          {/* ------------------------------------------------------------------
              Offer card, patterned on the reference pricing layout: centred
              header, then a single card carrying name, price, description, a
              full-width action, a rule, and a checked list of inclusions.

              ONE CARD, NOT THREE. The reference shows three tiers side by side.
              There is one product here, so there is one card. Splitting ~99 into
              invented Launch/Scale/Elevate tiers to fill a three-column grid
              would be fabricating a product line that does not exist and cannot
              be bought — the layout is the reference, the product truth is ours.
              ------------------------------------------------------------------ */}
          <header className="pricing-head">
            <h1 className="pricing-title">Start free. Pay once for more.</h1>
            <p className="pricing-sub">
              Most of Unviewable is free. Full access is a single payment: no
              subscription, no renewal, no card kept on file.
            </p>
          </header>

          <div className="plan">
            <div className="plan-top">
              <p className="plan-name">Free</p>
              <p className="plan-price">
                <span className="plan-price-amount">₹0</span>
                <span className="plan-price-unit">always</span>
              </p>
              <p className="plan-blurb">Everything you need to start applying.</p>
              {user ? (
                <a className="plan-cta" href="/services">
                  <span>Go to my dashboard</span>
                  <ArrowBadge />
                </a>
              ) : (
                <a className="plan-cta" href="/login?redirectedFrom=%2Fresume">
                  <span>Start free</span>
                  <ArrowBadge />
                </a>
              )}
            </div>
            <div className="plan-bottom">
              <p className="plan-included-label">Free includes</p>
              <ul className="plan-included">
                {FREE_FEATURES.map((feature) => (
                  <li key={feature}>
                    <CheckMark />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="plan">
            <div className="plan-top">
              <p className="plan-name">Full access</p>

              <p className="plan-price">
                <span className="plan-price-amount">
                  {formatInrCompact(bundle.baseAmountPaise)}
                </span>
                <span className="plan-price-unit">once</span>
              </p>

              <p className="plan-blurb">
                Everything in Free, plus everything below, unlocked permanently.
              </p>

              {alreadyOwns ? (
                <p className="plan-owned" role="status">
                  <strong>You already have full access.</strong>{' '}
                  {ownsDesktopOnly
                    ? 'Your earlier purchase now covers all four services, at no extra cost.'
                    : 'Everything below is unlocked.'}{' '}
                  <a href="/services">Go to your services</a>.
                </p>
              ) : !user ? (
                <a
                  className="plan-cta"
                  href="/login?redirectedFrom=%2Fpricing"
                >
                  <span>Sign in to buy</span>
                  <ArrowBadge />
                </a>
              ) : (
                <CheckoutButton
                  product={FULL_ACCESS_PRODUCT}
                  label={`Pay ${formatInr(bundle.totalAmountPaise)}`}
                  priceDisclosure={formatPriceDisclosure(bundle)}
                  description="Unviewable full access"
                />
              )}
            </div>

            <div className="plan-bottom">
              <p className="plan-included-label">Full access adds</p>
              <ul className="plan-included">
                {PLATFORM_SERVICES.map((service) => (
                  <li key={service}>
                    <CheckMark />
                    <span>
                      <strong>{SERVICE_LABELS[service]}</strong>
                      {' — '}
                      {SERVICE_BLURBS[service]}
                    </span>
                  </li>
                ))}
              </ul>

              {/* The tax breakdown stays on the card but below the rule, where a
                  buyer looks after deciding rather than before. */}
              <dl className="plan-tax">
                <div>
                  <dt>Unviewable full access</dt>
                  <dd>{formatInrCompact(bundle.baseAmountPaise)}</dd>
                </div>
                <div>
                  <dt>GST ({formatGstRate(bundle.gstBps)})</dt>
                  <dd>{formatInr(bundle.gstAmountPaise)}</dd>
                </div>
                <div className="plan-tax-total">
                  <dt>Total payable</dt>
                  <dd>{formatInr(bundle.totalAmountPaise)}</dd>
                </div>
              </dl>

              <p className="plan-fineprint">
                Prices in INR. Paid in India via Razorpay — UPI, cards,
                netbanking or wallets.
              </p>
            </div>
          </div>

          <p className="download-note">
            Read the <a href="/terms">Terms</a> and{' '}
            <a href="/refund">Refund Policy</a> before purchasing.
          </p>
        </div>
      </section>
    </SiteShell>
  );
}
