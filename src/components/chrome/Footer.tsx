import Link from 'next/link';

import { SITE_META } from '@/components/constants/site-meta';

import { NAV_LINKS } from './nav-links';

/**
 * Site footer.
 *
 * Server component — ships zero JS. Rendered by `<SiteShell />` on every
 * public route. The DOM is intentionally flat: a single `<footer>` element
 * containing a `.footer-inner` top row with the secondary nav and contact
 * links side-by-side, and a separate `.footer-copy` bottom row carrying the
 * copyright line. The top row collapses to a single column at narrow widths
 * so the footer reads cleanly at 360px / 768px / 1440px.
 *
 * Contracts (Req 11.1, 11.2, 11.3):
 *   - Renders the four secondary nav links from `NAV_LINKS` so the
 *     header, mobile menu, and footer share one source of truth (Req 11.1).
 *   - The contact link is a `mailto:` to `SITE_META.contactEmail` and the
 *     Instagram link opens `SITE_META.instagramUrl` in a new browsing
 *     context with `rel="noopener noreferrer"` to prevent reverse-tabnabbing
 *     (Req 11.2).
 *   - The copyright line uses `new Date().getFullYear()` so the displayed
 *     year always matches the current calendar year at render time (Req 11.1).
 *   - All visual treatment comes from token variables in `globals.css`. No
 *     gradients, drop shadows, or background images appear here or in the
 *     `.footer` rule block (Req 11.3).
 *
 * Internal navigation uses `<Link>` from `next/link` so route transitions
 * remain client-side; the `mailto:` and external Instagram URL use plain
 * `<a>` because they leave the app entirely.
 *
 * The `aria-label="Site footer"` and the nested
 * `<nav aria-label="Secondary">` give assistive tech a way to distinguish
 * this region from the primary navigation in `<Header />`.
 */
export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="footer" aria-label="Site footer">
      <div className="footer-inner">
        <nav className="footer-nav" aria-label="Secondary">
          {NAV_LINKS.map(({ label, href }) => (
            <Link key={href} className="footer-link" href={href}>
              {label}
            </Link>
          ))}
        </nav>

        <div className="footer-contact">
          <a className="footer-link" href={`mailto:${SITE_META.contactEmail}`}>
            {SITE_META.contactEmail}
          </a>
          <a
            className="footer-link"
            href={SITE_META.instagramUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Instagram
          </a>
        </div>
      </div>

      <p className="footer-copy">© {year} Unviewable</p>
    </footer>
  );
}
