import type { Metadata } from 'next';

import { SiteShell } from '@/components/chrome/SiteShell';
import { HeroSection } from '@/components/hero/HeroSection';
import { SITE_META } from '@/components/constants/site-meta';

export const metadata: Metadata = {
  title: 'Feedback — Share Your Unviewable Experience',
  description:
    'Tell us how Unviewable is working for you. Submit bug reports, feature requests, and general feedback to help us improve the product.',
  alternates: { canonical: '/feedback' },
  openGraph: {
    title: 'Feedback — Share Your Unviewable Experience',
    description:
      'Tell us how Unviewable is working for you. Submit feedback to help us improve.',
    url: '/feedback',
  },
};

/**
 * Feedback page — single-CTA hero plus a tokenized contact section.
 *
 * Server component (no `'use client'`). The hero ships zero JavaScript on
 * this route: the `spotlight` prop is intentionally omitted, so
 * <HeroSpotlight /> never mounts and the pointer-tracking client bundle
 * never reaches `/feedback` (Req 2.5). The hero CTA points users to the
 * auth-gated review form on `/` (the existing `/login?redirectedFrom=` flow
 * lands them at `#reviews` once authenticated), so the request shape and
 * redirect contract from the legacy implementation are preserved.
 *
 * The contact section is rendered inline (no dedicated component) using
 * the dedicated `.feedback-contact` block — every visual property is read
 * from the design-token cascade, so there is no `glass-panel` blur, no
 * inline `style={…}` overrides, and no legacy `.hero-glow` decoration on
 * this route (Req 12.1). Email and Instagram URLs read from `SITE_META` so
 * they stay byte-identical to the JSON-LD `Organization.sameAs` surface
 * and the footer contact row. The Instagram anchor carries
 * `rel="noopener noreferrer"` and `target="_blank"` because it leaves the
 * origin to a third-party social surface (Req 11.2).
 */
export default function FeedbackPage() {
  return (
    <SiteShell>
      <HeroSection
        eyebrow="Feedback"
        headline={
          <>
            Tell us how
            <br />
            it feels
          </>
        }
        sub="Your feedback shapes the product. Log in to submit bug reports, feature requests, and general impressions."
        primary={{
          label: 'Log in to submit feedback',
          href: '/login?redirectedFrom=%2F%23reviews',
          variant: 'primary',
        }}
      />

      <section className="feedback-contact" aria-labelledby="feedback-contact-heading">
        <h2 id="feedback-contact-heading">Prefer email?</h2>
        <p className="lede">
          Reach us directly at{' '}
          <a href={`mailto:${SITE_META.contactEmail}`}>{SITE_META.contactEmail}</a>{' '}
          or follow along on{' '}
          <a
            href={SITE_META.instagramUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Instagram @unviewable.online
          </a>
          .
        </p>
        <div className="feedback-contact-row">
          <a
            className="feedback-contact-link"
            href={`mailto:${SITE_META.contactEmail}`}
          >
            Email {SITE_META.contactEmail}
          </a>
          <a
            className="feedback-contact-link"
            href={SITE_META.instagramUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Instagram @unviewable.online
          </a>
        </div>
      </section>
    </SiteShell>
  );
}
