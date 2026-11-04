/**
 * Single source of truth for marketing-surface metadata that is reused across
 * the JSON-LD `SoftwareApplication` schema in `src/app/layout.tsx`,
 * the `<TrustStrip />` component, the footer contact row, and the social link
 * surfaces. Values are typed `as const` so consumers see narrow string-literal
 * types and the constant can never drift from the JSON-LD output.
 *
 * IMPORTANT: `softwareVersion` MUST stay byte-identical to the string that
 * appears in the JSON-LD schema.
 *
 * ---------------------------------------------------------------------------
 * REMOVED: `downloadUrl`.
 *
 * This constant used to hold a public GitHub Releases URL for the installer.
 * It was consumed by `<DownloadStarter />` on `/download`, which is a client
 * component — so the installer URL was compiled into the client bundle and
 * readable from page source by anyone, signed in or not. That made the
 * login gate (and now the paywall) decorative: one person copies the link,
 * everyone else skips payment.
 *
 * The installer now lives in a PRIVATE Supabase Storage bucket and is only
 * reachable through `/api/download/[platform]`, which verifies
 * `entitlements.download_access` and returns a five-minute signed URL. Release
 * coordinates live in the `releases` table (see `src/lib/releases.ts`).
 *
 * DO NOT reintroduce a direct asset URL here. Link to `/download` instead — it
 * is the only sanctioned entry point.
 * ---------------------------------------------------------------------------
 */
import { BUSINESS_INFO } from './business-info';

export const SITE_META = {
  softwareVersion: '2.2.1',
  // ratingValue / ratingCount were removed: they were hardcoded (4.9 / 124)
  // while production had 4 reviews. The public rating now comes from the real
  // `reviews` table — see src/lib/reviews/aggregate.ts. Do not re-add them here.
  // Derived, not duplicated: BUSINESS_INFO.email is what Razorpay KYC checks,
  // so the footer, /feedback and guides can never show a different address.
  contactEmail: BUSINESS_INFO.email,
  instagramUrl: 'https://www.instagram.com/unviewable.online/',
} as const;

export type SiteMeta = typeof SITE_META;
