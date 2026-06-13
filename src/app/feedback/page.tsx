import type { Metadata } from 'next';

import { SiteShell } from '@/components/chrome/SiteShell';
import { HeroSection } from '@/components/hero/HeroSection';
import { SITE_META } from '@/components/constants/site-meta';
import { createSupabaseRouteClient } from '@/lib/supabase/route';

import { FeedbackReview } from './FeedbackReview';

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
 * The route reads the Supabase session via cookies on every request, which
 * makes it dynamic. We declare it explicitly so future refactors cannot
 * accidentally tip the page into static generation and cache a stale
 * "log in" CTA for an authenticated visitor.
 */
export const dynamic = 'force-dynamic';

/**
 * `/feedback` — auth-aware feedback surface.
 *
 * Server component. Reads the Supabase session on every request and branches
 * the page composition based on authentication state:
 *
 *   - Authenticated visitor:
 *       Hero says "Tell us how it feels" with a single primary CTA jumping
 *       to the inline review form (`#reviews`) rendered directly below.
 *       The form is the same `<ReviewForm />` used on `/`, mounted via the
 *       `<FeedbackReview />` client island, so the byte-identical
 *       `/api/reviews` POST contract is preserved.
 *
 *   - Unauthenticated visitor:
 *       Hero CTA points at `/login?redirectedFrom=%2Ffeedback` so the
 *       login flow returns the user to this page after sign-in. The
 *       existing contact section renders below either way for users who
 *       prefer email or social.
 *
 * Why server-side auth check (not client-side):
 *   The legacy implementation showed the "Log in to submit feedback" CTA
 *   to every visitor regardless of session state. That meant authenticated
 *   users had to click through a login round-trip even though their cookie
 *   was already valid — a clunky UX that we fix by branching the render at
 *   the server level. Cookies are read in `createSupabaseRouteClient()`,
 *   so the page emits the correct CTA on first paint with zero hydration
 *   flicker.
 */
export default async function FeedbackPage() {
  const supabase = await createSupabaseRouteClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isLoggedIn = Boolean(user);
  const userEmail = user?.email ?? '';

  return (
    <SiteShell>
      <HeroSection
        eyebrow="Feedback"
        headline={
          <>
            Tell us how
            <br />
            it <em>feels</em>
          </>
        }
        sub={
          isLoggedIn
            ? 'Share your experience so we can harden the product. Your email stays private and is only used to follow up if there is an issue.'
            : 'Your feedback shapes the product. Log in to submit bug reports, feature requests, and general impressions.'
        }
        primary={
          isLoggedIn
            ? {
                label: 'Submit feedback',
                href: '#reviews',
                variant: 'primary',
              }
            : {
                label: 'Log in to submit feedback',
                href: '/login?redirectedFrom=%2Ffeedback',
                variant: 'primary',
              }
        }
      />

      {isLoggedIn ? <FeedbackReview userEmail={userEmail} /> : null}

      <section className="feedback-contact" aria-labelledby="feedback-contact-heading">
        <h2 id="feedback-contact-heading">
          Prefer <em>email</em>?
        </h2>
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
