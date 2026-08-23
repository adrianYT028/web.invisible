/**
 * Single source of truth for site navigation links.
 *
 * Consumed by `<Header />`, `<MobileMenu />`, and `<Footer />` (secondary nav).
 * Declared `as const` so consumers receive string-literal types for both the
 * `label` and `href` of each entry, ruling out typos at the call site.
 *
 * Order matches the visual order used in the header and footer per design.md
 * → Page-by-Page Composition.
 *
 * Contract (Req 14.4 / 11.1):
 *   - `label`  is the visible text rendered inside the link.
 *   - `href`   is an absolute, in-app pathname (no trailing slash, no query).
 */

export const NAV_LINKS = [
  { label: 'Downloads', href: '/downloads' },
  { label: 'Setup Guide', href: '/guides/setup' },
  { label: 'Usage Guide', href: '/guides/usage' },
  { label: 'Feedback', href: '/feedback' },
] as const;

export type NavLink = (typeof NAV_LINKS)[number];

/**
 * Policy links, rendered only in the footer — deliberately kept out of
 * NAV_LINKS so they do not appear in the header or mobile menu.
 *
 * These must be reachable from every page: Razorpay's activation review looks
 * for About, Contact, Terms, Privacy, and Refund policies on the website, and
 * a reviewer who cannot find them from the homepage footer may reject the
 * application. They are also registered as public paths in `src/proxy.ts`.
 */
export const LEGAL_LINKS = [
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact' },
  { label: 'Terms', href: '/terms' },
  { label: 'Privacy', href: '/privacy' },
  { label: 'Refunds', href: '/refund' },
] as const;

export type LegalLink = (typeof LEGAL_LINKS)[number];
