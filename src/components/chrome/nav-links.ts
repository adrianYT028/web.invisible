/**
 * Single source of truth for site navigation links.
 *
 * Consumed by `<Header />`, `<MobileMenu />`, and `<Footer />`.
 * Declared `as const` so consumers receive string-literal types for both the
 * `label` and `href` of each entry, ruling out typos at the call site.
 *
 * Contract (Req 14.4 / 11.1):
 *   - `label`  is the visible text rendered inside the link.
 *   - `href`   is an absolute, in-app pathname (no trailing slash, no query).
 */

/**
 * The header: four sections, named for what the user wants to do, not for our
 * feature names. Every page belongs to exactly one of them, and each section's
 * pages are linked from `SECTION_TABS` at the top of those pages, so nothing is
 * more than two clicks from the header.
 *
 *   Resume     check it against a job, download it, LinkedIn profile
 *   Jobs       your tracker, find openings, prepare applications in bulk
 *   Interview  practice questions, the desktop app for live help
 *   Pricing    free vs full access
 *
 * Section pages need a sign-in and send anonymous visitors to /login and back.
 * The free, no-login entry point is /ats-checker (homepage and footer).
 */
export const NAV_LINKS = [
  { label: 'Resume', href: '/resume' },
  { label: 'Jobs', href: '/jobs' },
  { label: 'Interview', href: '/interview' },
  { label: 'Pricing', href: '/pricing' },
] as const;

export type NavLink = (typeof NAV_LINKS)[number];

/** The pages inside each section, shown as tabs at the top of those pages. */
export const SECTION_TABS = {
  resume: [
    { label: 'Check my resume', href: '/resume' },
    { label: 'LinkedIn profile', href: '/linkedin' },
  ],
  jobs: [
    { label: 'My tracker', href: '/jobs' },
    { label: 'Find jobs', href: '/jobs/discover' },
    { label: 'Apply in bulk', href: '/prep' },
  ],
  interview: [
    { label: 'Practice', href: '/interview' },
    { label: 'Desktop app', href: '/download' },
  ],
} as const;

export type SectionKey = keyof typeof SECTION_TABS;

/**
 * Footer-only links: useful, but not what most visitors come for, so they stay
 * out of the header to keep it to four choices.
 */
export const FOOTER_LINKS = [
  { label: 'Free ATS checker', href: '/ats-checker' },
  { label: 'My dashboard', href: '/services' },
  { label: 'Desktop setup guide', href: '/guides/setup' },
  { label: 'Desktop usage guide', href: '/guides/usage' },
  { label: 'Feedback', href: '/feedback' },
] as const;

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
