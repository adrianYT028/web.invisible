/**
 * TrustStrip — server component that surfaces the same product trust signals
 * the JSON-LD `SoftwareApplication` schema declares in `src/app/layout.tsx`:
 * the aggregate user rating, the rating count, and the current software
 * version. The strip is composed below the hero and above the feature grid
 * on `/` (Req 10.1, 10.2).
 *
 * Source of truth:
 *   The three values come from `SITE_META` in
 *   `src/components/constants/site-meta.ts` — the same constant the JSON-LD
 *   block consumes — so the displayed strings stay byte-identical to the
 *   structured data emitted in `<head>`. When any of `ratingValue`,
 *   `ratingCount`, or `softwareVersion` is null/undefined/empty at render
 *   time, the component returns `null` so we never fabricate default values
 *   (Req 10.5). `SITE_META` is typed `as const` and currently provides all
 *   three strings, but the runtime guard keeps us correct if a future edit
 *   loosens the type or wires the values to a CMS.
 *
 * No fabricated trust signals (Req 10.3):
 *   The strip renders ONLY the rating, rating count, and version. It does
 *   NOT render logos, testimonial quotes, press mentions, or partner
 *   badges — none of those are declared in the codebase.
 *
 * Star visualization:
 *   Five 18×18 SVG stars (single path each), rendered via a `<linearGradient>`
 *   so a single rule supports filled, half-filled, and empty without changing
 *   the path geometry. The numeric `ratingValue` is rounded to the nearest
 *   half, then each star receives an `offsetX` of either 0% (empty), 50%
 *   (half), or 100% (full). Filled portion uses `var(--accent)`; unfilled
 *   portion uses `var(--border-strong)` so the empty arms read as muted on
 *   both themes without competing with the accent fill.
 *
 *   Each gradient gets a unique ID (`trust-star-grad-1`..`-5`) so multiple
 *   gradients on the page do not collide. The two `<stop>` elements share
 *   the same `offset` value — the standard SVG trick for a hard color
 *   transition at any percentage without needing two paths or a clipPath.
 *
 * Layout:
 *   `<section class="trust-strip" aria-label="Product trust signals">`
 *   composes a `flex-wrap` row centered horizontally inside the page
 *   max-width. `flex-wrap` plus `gap` keep the strip from overflowing
 *   horizontally between 320px and 1920px (Req 10.2) — at narrow widths
 *   the version pill drops below the rating block; at wide widths they sit
 *   on the same row separated by `var(--space-8)`.
 *
 *   The `aria-label` on the section gives assistive tech a single concise
 *   region label so screen readers do not have to derive context from the
 *   stars or the version glyph.
 *
 * No client JS:
 *   This component is a pure server component. It renders deterministic
 *   markup at build time, ships zero JavaScript, and contributes zero CLS
 *   because the strip's geometry is fixed by the spacing tokens regardless
 *   of viewport width.
 */

import { SITE_META } from '@/components/constants/site-meta';

/**
 * Round to the nearest 0.5 step. We do this for visual fidelity only —
 * the displayed rating string remains the original `SITE_META.ratingValue`
 * so the visible number always matches the JSON-LD schema (Req 10.1).
 */
function roundToHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

/**
 * Map a half-step rating value to an offsetX percentage for a given star
 * index (1..5). Anything at or below `index - 1` is empty (0%), anything
 * at exactly `index - 0.5` is a half-fill (50%), and anything at or above
 * `index` is fully filled (100%).
 */
function offsetForStar(rating: number, index: number): number {
  if (rating >= index) return 100;
  if (rating >= index - 0.5) return 50;
  return 0;
}

export function TrustStrip() {
  const { ratingValue, ratingCount, softwareVersion } = SITE_META;

  // Runtime guard for Req 10.5. We accept only non-empty strings; empty,
  // null, or undefined values cause the component to render nothing rather
  // than fabricating defaults.
  if (!ratingValue || !ratingCount || !softwareVersion) {
    return null;
  }

  const numericRating = Number(ratingValue);

  // If `ratingValue` ever becomes a non-numeric string at runtime,
  // `Number()` returns NaN. Guarding here keeps the star fill logic from
  // emitting `NaN%` offsets and falls back to omitting the strip entirely
  // — same posture as Req 10.5: no fabricated signal.
  if (!Number.isFinite(numericRating)) {
    return null;
  }

  const displayRating = roundToHalf(numericRating);

  return (
    <section className="trust-strip" aria-label="Product trust signals">
      <div className="trust-stars" aria-hidden="true">
        {[1, 2, 3, 4, 5].map((index) => {
          const offset = offsetForStar(displayRating, index);
          const gradientId = `trust-star-grad-${index}`;
          return (
            <svg
              key={index}
              width="18"
              height="18"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <defs>
                <linearGradient
                  id={gradientId}
                  x1="0"
                  y1="0"
                  x2="1"
                  y2="0"
                >
                  {/* Two stops at the same offset produce a hard cut between
                      the filled accent color and the muted border color so
                      the half-star edge is crisp on every pixel ratio. */}
                  <stop offset={`${offset}%`} stopColor="var(--accent)" />
                  <stop offset={`${offset}%`} stopColor="var(--border-strong)" />
                </linearGradient>
              </defs>
              <path
                d="M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.57L12 17.58l-5.9 3.1 1.13-6.57L2.45 9.44l6.6-.96L12 2.5z"
                fill={`url(#${gradientId})`}
              />
            </svg>
          );
        })}
      </div>
      <p className="trust-rating">
        <strong>{ratingValue}</strong> from {ratingCount} reviewers
      </p>
      <p className="trust-version">Version {softwareVersion}</p>
    </section>
  );
}
