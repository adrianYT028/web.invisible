/**
 * HeroSection — the structural shell for the top-of-page hero on `/` and the
 * single-CTA hero band on every other public route.
 *
 * The component is a server component (no `'use client'`) because all of its
 * output is static markup driven by props — the only interactive piece, the
 * optional pointer-tracked spotlight, is mounted as the dedicated
 * <HeroSpotlight /> client island and only when the caller opts in via the
 * `spotlight` prop. Keeping HeroSection on the server is what makes the
 * `<h1>` the LCP candidate paintable without any JS evaluating first
 * (Req 1.1).
 *
 * Slot composition (Req 6.1):
 *   - exactly one `eyebrow` (mono caption, tracking 0.10em)
 *   - exactly one display headline rendered as `<h1>` (≤80 chars at the
 *     copy layer; the type system intentionally accepts ReactNode so home
 *     callers can insert a `<br/>` between the two display lines)
 *   - exactly one sub-headline rendered as `<p class="hero-sub lede">`
 *     (≤160 chars at the copy layer)
 *   - exactly one primary CTA in the CTA group
 *   - at most one secondary CTA in the CTA group, which can either be a
 *     navigational `secondary` variant or the inert `coming-soon` state
 *     used for the Mac CTA on the home hero (Req 6.2)
 *
 * The secondary action discriminator distinguishes a real navigational
 * secondary (carries `href`) from the disabled `coming-soon` state (carries
 * `state: 'coming-soon'`) at the type level so callers cannot accidentally
 * mix the two — that prevents the bug class where a "Coming Soon" pill
 * silently navigates somewhere because someone added an `href`.
 *
 * Spotlight scoping (Req 2.5):
 *   `<HeroSpotlight />` is mounted only when `spotlight === true`. The home
 *   page passes `spotlight`; downloads, feedback, login, account, and the
 *   guide pages omit it. As a result, the spotlight DOM, its registered
 *   `--mx`/`--my` interpolation, and the pointer-tracking client bundle
 *   never reach the other routes.
 *
 * Antigravity scoping (Req 1.3, 8.x):
 *   `<HeroAntigravity />` is mounted only when the `antigravity` prop is
 *   truthy. Passing `true` opts into the defaults; passing an object
 *   forwards it as `HeroAntigravityProps` so callers can tune count,
 *   physics, and per-element styling without forking the component. The
 *   layer is positioned in DOM order between `<HeroSpotlight />` and
 *   `<div className="hero-content">` so the painter's algorithm produces
 *   the intended stacking — spotlight glow at the back, antigravity mass
 *   in the middle, headline + CTAs in front — without any z-index changes
 *   to the existing two layers (Req 1.3).
 *
 * What this component intentionally does NOT do:
 *   - No `<header>` or `<footer>` chrome — those live in <SiteShell />.
 *   - No `text-transform: uppercase` on `<h1>` (Req 3.7). The eyebrow caption
 *     keeps `text-transform: uppercase` because Req 3.7 scopes the rule to
 *     display/h1 sizes only.
 *   - No legacy `.hero-glow`, `.fade-in-up`, or scroll-reveal hooks. The
 *     hero paints in its final visual state on first frame.
 */

import type { ReactNode } from 'react';

import { CtaButton } from '@/components/sections/CtaButton';
import { HeroSpotlight } from '@/components/hero/HeroSpotlight';
import {
  HeroAntigravity,
  type HeroAntigravityProps,
} from '@/components/hero/HeroAntigravity';

/**
 * Variant of the secondary action that links somewhere. `href` is optional
 * at the type level so that callers can omit it during development; the
 * runtime falls back to `'#'` so the cascade doesn't crash, but in
 * production every secondary navigation CTA should set `href`.
 */
type SecondaryNav = {
  label: string;
  href?: string;
  variant?: 'primary' | 'secondary';
};

/**
 * Variant of the secondary action that renders the inert "Coming Soon"
 * pill. The `state: 'coming-soon'` literal acts as the discriminant; the
 * presence of this field flips the renderer from a navigational anchor to
 * the <DisabledCta /> client island via <CtaButton variant="disabled" />.
 */
type SecondaryComingSoon = {
  label: string;
  state: 'coming-soon';
  trailing?: ReactNode;
};

export type HeroSectionProps = {
  eyebrow: string;
  headline: ReactNode;
  sub: string;
  primary: {
    label: string;
    href: string;
    variant?: 'primary' | 'secondary';
    download?: boolean;
    trailing?: ReactNode;
  };
  secondary?: SecondaryNav | SecondaryComingSoon;
  spotlight?: boolean;
  /**
   * Optional demo panel rendered beside the hero copy (the "Two Screens"
   * split layout). When present the section gains the `hero--split`
   * modifier and the copy + demo sit in a two-column grid at >=1024px.
   * Routes that omit it keep the single-column editorial hero. The node
   * is typically the <ScreenSimulator /> client island; passing it as a
   * prop keeps HeroSection itself a server component.
   */
  demo?: ReactNode;
  /**
   * Controls the optional cursor-repelled mass layer rendered between the
   * spotlight glow and the hero content. Pass `true` to mount with
   * defaults, or pass a `HeroAntigravityProps` object to tune count,
   * physics, and per-element styling. Falsy values (the default) skip
   * the mount entirely so non-home routes never ship the antigravity
   * DOM or its client bundle (Req 8.1, 8.2, 8.3).
   */
  antigravity?: boolean | HeroAntigravityProps;
};

/**
 * Type guard that narrows the secondary discriminator. Using `'state' in s`
 * lets TypeScript infer the `SecondaryComingSoon` branch in the truthy
 * arm and the `SecondaryNav` branch in the falsy arm without runtime cost.
 */
function isComingSoon(
  secondary: SecondaryNav | SecondaryComingSoon,
): secondary is SecondaryComingSoon {
  return 'state' in secondary && secondary.state === 'coming-soon';
}

export function HeroSection({
  eyebrow,
  headline,
  sub,
  primary,
  secondary,
  spotlight,
  antigravity,
  demo,
}: HeroSectionProps) {
  return (
    <section className={demo ? 'hero hero--split' : 'hero'}>
      {/* The spotlight is mounted as a sibling of `.hero-content` so the
          radial-gradient sits behind the text via z-index (the gradient is
          z-0 from `.hero-spotlight`; `.hero-content` is z-1). It is gated
          on the `spotlight` prop so non-home routes never ship the
          decoration or the client bundle that drives it (Req 2.5). */}
      {spotlight ? <HeroSpotlight /> : null}

      {/* Antigravity layer. DOM order matters: this sits *after* the
          spotlight and *before* `.hero-content`, so the painter's
          algorithm puts the mass on top of the spotlight glow and behind
          the headline + CTAs (Req 1.3). Passing `true` mounts with
          defaults; passing an object forwards it as props (Req 8.1, 8.2,
          8.3); falsy values skip the mount entirely. */}
      {antigravity ? (
        <HeroAntigravity
          {...(typeof antigravity === 'object' ? antigravity : {})}
        />
      ) : null}

      <div className="hero-content">
        <div className="hero-copy">
          {/* Eyebrow caption — mono, uppercase, tracked. Req 3.7's no-uppercase
              rule applies to display/h1 sizes only, so the eyebrow keeping
              uppercase is allowed here. */}
          <p className="eyebrow">{eyebrow}</p>

          {/* Display headline. This is the LCP candidate: rendered server-side,
              no client JS required to paint, and with no `text-transform:
              uppercase` (Req 1.1, 3.7). */}
          <h1 className="hero-headline">{headline}</h1>

          {/* Sub-headline rendered as a `lede` paragraph. The shared `.lede`
              class carries the body-lg type rhythm; `.hero-sub` adds the
              hero-specific measure cap. */}
          <p className="hero-sub lede">{sub}</p>

          <div className="hero-ctas">
            {/* Primary CTA. We pass `variant="primary"` explicitly rather than
                spreading the caller's `primary.variant` so HeroSection always
                renders the primary slot as the dominant accent button — the
                caller's optional `variant` is ignored on purpose. */}
            <CtaButton
              variant="primary"
              label={primary.label}
              href={primary.href}
              download={primary.download}
              trailing={primary.trailing}
            />

            {secondary
              ? isComingSoon(secondary)
                ? (
                    <CtaButton
                      variant="disabled"
                      label={secondary.label}
                      reason="coming-soon"
                      trailing={secondary.trailing}
                    />
                  )
                : (
                    <CtaButton
                      variant="secondary"
                      label={secondary.label}
                      href={secondary.href ?? '#'}
                    />
                  )
              : null}
          </div>
        </div>

        {/* Optional demo column (home route only). Rendered after the copy
            so source order matches the visual order when the grid stacks. */}
        {demo ? <div className="hero-demo">{demo}</div> : null}
      </div>
    </section>
  );
}

export default HeroSection;
