'use client';

import { useEffect, useRef } from 'react';

/**
 * HeroSpotlight
 *
 * Renders a single decorative `<div>` that paints a soft radial-gradient
 * spotlight behind the hero content. The gradient position is driven by two
 * registered custom properties (`--mx`, `--my`) declared in `globals.css`,
 * and the `.hero-spotlight` rule there owns all visual styling.
 *
 * Behavior (per design.md → Hero_Spotlight Component → JS Behavior):
 *
 * - On capability-limited devices the component ships zero listeners. We
 *   read `prefers-reduced-motion: reduce` (Req 2.4, 15.5) and `hover: none`
 *   (Req 2.6) on mount; if either matches we leave the parent's CSS custom
 *   properties at their `@property` initial values (`50%` / `35%`) so the
 *   gradient renders as a static centred wash.
 * - Otherwise we attach `pointermove` (passive) and `pointerleave` to the
 *   parent `<section class="hero">`. `pointermove` writes `--mx` / `--my`
 *   as percentages of the section's bounding rect; `pointerleave` re-anchors
 *   to `50%` / `35%` (Req 2.3 — re-anchor within 200–400ms via the CSS
 *   transition on `--mx` / `--my`).
 * - We do NOT use `requestAnimationFrame`. The `transition` declared on
 *   `.hero-spotlight` smooths the visual via the registered `@property`
 *   interpolation; setting two CSS variables per pointer event is cheap
 *   and the browser already coalesces paints (Req 15.7).
 * - Cleanup removes both listeners on unmount.
 *
 * The element carries `aria-hidden="true"` so screen readers ignore the
 * decoration (Req 2.7), and it has no children — purely presentational.
 */
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

    const onMove = (event: PointerEvent) => {
      const rect = hero.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      hero.style.setProperty('--mx', `${x}%`);
      hero.style.setProperty('--my', `${y}%`);
    };

    const onLeave = () => {
      hero.style.setProperty('--mx', '50%');
      hero.style.setProperty('--my', '35%');
    };

    hero.addEventListener('pointermove', onMove, { passive: true });
    hero.addEventListener('pointerleave', onLeave);

    return () => {
      hero.removeEventListener('pointermove', onMove);
      hero.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return <div ref={ref} className="hero-spotlight" aria-hidden="true" />;
}

export default HeroSpotlight;
