'use client';

/**
 * HeroSpotlight — multi-layer aurora hero effect.
 *
 * The original spotlight used a single radial gradient pinned to the
 * cursor. That read as a static "halo follows mouse" — fine, but it does
 * not communicate the depth and motion that brands like Linear, Anthropic,
 * Resend, and Antigravity use as their signature first-paint hook. This
 * version replaces the single-gradient pattern with two independent glow
 * layers that:
 *
 *   1. React to the pointer at DIFFERENT magnitudes — the inner glow
 *      tracks the cursor closely (foreground), the outer glow drifts at
 *      ~45% of the cursor delta (background). The asymmetry produces
 *      parallax: the eye reads the two glows as occupying different
 *      depths, so the hero feels three-dimensional even though it is two
 *      gradient passes.
 *
 *   2. Have an additional ambient drift animation in CSS that keeps the
 *      glow alive when the cursor is still. The drift is slow (~26s
 *      cycle) so it never crosses into "decorative motion" territory; it
 *      reads as the kind of subtle breathing effect that high-end SaaS
 *      heroes use to signal "the page is alive, not frozen."
 *
 *   3. Lag behind the cursor via the existing CSS `transition` on the
 *      registered `@property` custom properties. The pointer fires
 *      coalesced events; the gradients catch up with a 350ms ease-out
 *      curve, which gives the glow a sense of mass — it feels like a
 *      light source moving through fluid rather than a halo glued to
 *      the cursor.
 *
 * The effect respects every capability gate Req 2.4 / 2.6 / 15.5 calls
 * for: when `prefers-reduced-motion: reduce` is set, OR the device has
 * no hover (touch primary), we attach no listeners — the gradients still
 * paint statically via the @property initial values, but they no longer
 * track or animate. This keeps the hero pleasant on both phones and
 * accessibility-conscious users while not penalizing the desktop
 * experience.
 *
 * The pointer math sets four custom properties on the parent .hero
 * section:
 *   --mx, --my       → 0..100% mapped from cursor X/Y inside the hero
 *                      (consumed by the foreground glow, full magnitude)
 *   --mx2, --my2     → same coordinates with 45% magnitude offset from
 *                      center (consumed by the background glow). The
 *                      offset is computed by linearly interpolating
 *                      between the geometric center (50%/35%) and the
 *                      raw cursor position; the result is a softer,
 *                      slower-following point that sits "behind" the
 *                      foreground glow on the parallax axis.
 *
 * Cleanup is unchanged from the previous implementation: both listeners
 * are removed on unmount, and `pointerleave` re-anchors all four custom
 * properties to their geometric center defaults so the hero settles to
 * a calm static state when the cursor leaves the section.
 */

import { useEffect, useRef } from 'react';

/**
 * Linearly interpolate `value` toward `center` by `(1 - magnitude)`. With
 * magnitude = 1 the function returns `value` (full tracking); with
 * magnitude = 0 it returns `center` (no tracking). 0.45 produces the
 * soft-follow behaviour the background glow uses for parallax.
 */
function dampen(value: number, center: number, magnitude: number): number {
  return center + (value - center) * magnitude;
}

export function HeroSpotlight() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Capability gates — bail before attaching any listeners (Req 2.4, 2.6, 15.5).
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const noHover = window.matchMedia('(hover: none)').matches;
    if (reduced || noHover) return;

    // The component is mounted as a direct child of `<section class="hero">`,
    // so its parentElement is the spotlight target. If for some reason it is
    // not present (e.g. portaled), we silently skip rather than throw.
    const hero = ref.current?.parentElement;
    if (!hero) return;

    // Background-layer parallax magnitude. 0.45 produces a noticeably
    // softer follow than the foreground (which tracks at 1.0). Anything
    // below 0.3 reads as static; anything above 0.7 reads as a duplicate
    // foreground layer rather than a parallax layer.
    const PARALLAX = 0.45;
    // Geometric defaults that match the @property initial values. The
    // foreground glow sits at 50%/35%; the background glow sits a little
    // higher at 50%/30% so the two layers do not stack perfectly when
    // the cursor is at the center, which would collapse the parallax.
    const FG_CENTER_X = 50;
    const FG_CENTER_Y = 35;
    const BG_CENTER_X = 50;
    const BG_CENTER_Y = 30;

    const onMove = (event: PointerEvent) => {
      const rect = hero.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;

      // Foreground tracks the cursor 1:1 — full magnitude.
      hero.style.setProperty('--mx', `${x}%`);
      hero.style.setProperty('--my', `${y}%`);

      // Background tracks at 45% of cursor delta, biased toward its own
      // geometric center. Two-layer math gives the eye depth.
      hero.style.setProperty('--mx2', `${dampen(x, BG_CENTER_X, PARALLAX)}%`);
      hero.style.setProperty('--my2', `${dampen(y, BG_CENTER_Y, PARALLAX)}%`);
    };

    const onLeave = () => {
      hero.style.setProperty('--mx', `${FG_CENTER_X}%`);
      hero.style.setProperty('--my', `${FG_CENTER_Y}%`);
      hero.style.setProperty('--mx2', `${BG_CENTER_X}%`);
      hero.style.setProperty('--my2', `${BG_CENTER_Y}%`);
    };

    hero.addEventListener('pointermove', onMove, { passive: true });
    hero.addEventListener('pointerleave', onLeave);

    return () => {
      hero.removeEventListener('pointermove', onMove);
      hero.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  // The DOM is intentionally minimal: a single decorative wrapper that
  // hosts the two gradient pseudo-elements declared in `globals.css`.
  // Both pseudo-elements draw on top of the hero background and below
  // the hero content (z-index controlled by the .hero-spotlight rule).
  return <div ref={ref} className="hero-spotlight" aria-hidden="true" />;
}

export default HeroSpotlight;
