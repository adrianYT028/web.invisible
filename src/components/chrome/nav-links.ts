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
