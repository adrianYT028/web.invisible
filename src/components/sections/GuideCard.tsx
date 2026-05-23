import Link from 'next/link';

import type { ReactNode } from 'react';

/**
 * GuideCard — a single card in the home-page "Get Started" surface.
 *
 * Server component. Ships zero JavaScript. Rendered twice by
 * `<GuideCards />` to point at `/guides/setup` and `/guides/usage`.
 *
 * Contracts (Req 9.1, 12.2):
 *   - The whole card is a SINGLE link — `<Link href={…} className="guide-card">`.
 *     No nested anchors anywhere inside, so the entire surface is the hit
 *     target and the accessible name is the link's text content (icon is
 *     `aria-hidden`, so the heading + description + bullets carry the name).
 *   - Renders one icon, one `<h3>` (8–32 chars enforced at build via the
 *     calling page), one `<p>` description (40–140 chars enforced upstream),
 *     a `<ul>` with exactly four `<li>` bullets (TypeScript narrows the
 *     `bullets` prop to a 4-tuple at the type level), and a CTA span.
 *   - Hit target ≥ 44×44 — guaranteed by the `.guide-card` rule's
 *     `min-height: 44px` and the natural padded height of the card body.
 *   - Adjacent-card separation ≥ 8px on `(pointer: coarse)` — handled by
 *     the `.guide-cards-grid` gap override at the section level.
 *
 * The wrapping element is `<Link>` from `next/link` so in-app navigation
 * stays client-side: clicking the card swaps routes via the Next.js
 * router instead of a full document load. `<Link>` renders a single
 * `<a>` element by default in App Router, satisfying the "no nested
 * anchors" rule from the task description.
 *
 * `ctaLabel` defaults to `'Read'` so callers don't need to specify it
 * for the home-page composition — the design fixes both cards to "Read".
 * The slot is exposed in case the surface gets reused on another route
 * with a slightly different verb.
 */
export type GuideCardProps = {
  href: string;
  icon: ReactNode;
  title: string;
  description: string;
  bullets: [string, string, string, string];
  ctaLabel?: string;
};

export function GuideCard({
  href,
  icon,
  title,
  description,
  bullets,
  ctaLabel = 'Read',
}: GuideCardProps) {
  return (
    <Link href={href} className="guide-card">
      <span className="guide-card-icon" aria-hidden="true">
        {icon}
      </span>
      <h3 className="guide-card-title">{title}</h3>
      <p className="guide-card-desc">{description}</p>
      <ul className="guide-card-bullets">
        {bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>
      <span className="guide-card-cta">
        {ctaLabel}
        <ArrowIcon />
      </span>
    </Link>
  );
}

/**
 * Trailing arrow inside the "Read" CTA. Inline SVG so the icon ships in
 * the same HTML payload as the card text — no extra request, no font
 * dependency. `aria-hidden` because the visible "Read" label already
 * carries the accessible name; doubling it via the SVG's title would
 * read out twice for screen-reader users.
 */
function ArrowIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}
