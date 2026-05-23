'use client';

/**
 * Reveal — minimal, premium scroll-driven entrance animation.
 *
 * Mirrors the kind of subtle reveal Stripe, Linear, Anthropic, and Vercel
 * use on their marketing surfaces: a small upward translate (12px) plus
 * fade, on a generous ease-out curve, lasting ~600ms, triggered once the
 * element enters the viewport. No spring, no bounce, no parallax — just
 * a calm "this content has arrived" affordance.
 *
 * Behavior:
 *
 *   - Until the element enters the viewport (with a 10% bottom rootMargin
 *     so the trigger fires slightly before the element hits the fold),
 *     the wrapper is `opacity: 0` and translated 12px down.
 *   - On intersection, we add `is-visible`, which transitions opacity and
 *     transform to their final state. The IntersectionObserver disconnects
 *     immediately so the reveal only happens once per mount.
 *   - When the user agent reports `prefers-reduced-motion: reduce`, the
 *     CSS rule pins the wrapper to its final state regardless of JS state,
 *     so the content paints in place with no transition. The component
 *     also short-circuits the observer in JS for that case so we do not
 *     attach a listener at all.
 *   - On the server, the snapshot renders with the pre-reveal styles. The
 *     element flips to visible after hydration. Any visible-on-first-paint
 *     content (e.g. above-the-fold heros) should NOT be wrapped in Reveal —
 *     keep it for content the user has to scroll to.
 *
 * `delay` (milliseconds) staggers the reveal so adjacent cards in a grid
 * arrive in a wave. 0 / 80 / 160 ms is the typical 3-column rhythm. Larger
 * delays read as "this content is more important; pay attention."
 *
 * The wrapper is intentionally a plain `<div>` so it sits transparently
 * inside grid layouts — it adds no padding, no background, no display
 * mode beyond the default block. Consumers compose it as a direct child
 * of any grid container.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** Stagger offset in milliseconds. Adjacent siblings can pass increasing values for a wave reveal. */
  delay?: number;
  /** Optional extra class names applied to the wrapper element. */
  className?: string;
};

export function Reveal({ children, delay = 0, className }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Skip the observer entirely when the user opted out of motion. The
    // CSS reduced-motion rule has already pinned the visual to its final
    // state; we only need to flip our React state so server/client agree.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVisible(true);
      return;
    }

    // If the element is already past the trigger band on mount (e.g. the
    // user navigated to a deep anchor and the section is already in
    // view), reveal it without waiting for the next intersection event.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.9 && rect.bottom > 0) {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            return;
          }
        }
      },
      {
        // Trigger when 15% of the element is in view, biased so the
        // reveal fires slightly before the element fully enters the
        // viewport — keeps the page feeling responsive on scroll.
        threshold: 0.15,
        rootMargin: '0px 0px -10% 0px',
      },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const composedClassName = [
    'reveal',
    visible ? 'is-visible' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  // Stagger via inline `transition-delay`. Avoids a per-instance class
  // and keeps the staggering data-driven from the call site.
  const style = delay > 0 ? { transitionDelay: `${delay}ms` } : undefined;

  return (
    <div ref={ref} className={composedClassName} style={style}>
      {children}
    </div>
  );
}

export default Reveal;
