/**
 * FeatureCard — single feature article rendered inside <FeatureGrid />.
 *
 * Why this is a server component:
 *   The card is purely presentational. It carries no state, no event
 *   handlers, no effects. The legacy implementation used an `onMouseMove`
 *   handler to drive the `--mouse-x` / `--mouse-y` cursor-tracking gradient
 *   on the `.feature-card` surface (Req 7.4) — the redesign deletes that
 *   pattern entirely and replaces it with token-driven CSS hover transitions
 *   on `border-color` and `box-shadow` only. With the handler gone the file
 *   has no reason to cross the server/client boundary, so it stays a server
 *   component and ships zero JavaScript (Req 13.7, 13.8).
 *
 * Layout (Req 7.1, 7.2, 7.3):
 *   `<article>` so the card stands as a self-contained unit in the
 *   accessibility tree. Inside, three children sit in document order:
 *     1. `<div class="feature-icon">` — fixed 48×48 chrome box for the
 *        SVG mark. The icon is supplied as a `ReactNode` so callers can
 *        inline any SVG (every icon used by FeatureGrid follows the same
 *        24×24 viewBox, 1.5px stroke-width, `currentColor` stroke contract
 *        — see FeatureGrid for the icon set). The container box itself
 *        does NOT change between cards: same width, height, border, and
 *        radius, so the three cards read as a typographic family rather
 *        than three competing illustrations (Req 7.2).
 *     2. `<h3>{title}</h3>` — feature name, styled by the `.feature-card h3`
 *        rule in `globals.css` so the type rhythm matches the rest of the
 *        redesign without bespoke per-card overrides (Req 7.6).
 *     3. `<p>{description}</p>` — the technical claim. Description copy
 *        lives entirely in the consumer (FeatureGrid) so the card stays
 *        agnostic; this file enforces only the structural contract.
 *
 * Hover motion budget (Req 7.4, 7.5, 15.6):
 *   The `.feature-card` rule in `globals.css` transitions `border-color`
 *   and `box-shadow` over `--duration-base` (180ms). It does NOT animate
 *   background-fill, icon position, icon color, text content, or any
 *   transform. Hover therefore communicates affordance without reflowing
 *   the card or shifting attention away from the description.
 */

import type { ReactNode } from 'react';

export type FeatureCardProps = {
  /**
   * Inline SVG content for the feature mark. Rendered inside the fixed
   * 48×48 `.feature-icon` chrome box. The SVG is expected to use a 24×24
   * viewBox with `stroke="currentColor"`, `stroke-width="1.5"`, and
   * `aria-hidden="true"` — the chrome box inherits `color: var(--text)`
   * from the rule in `globals.css`, and the SVG inherits that color via
   * `currentColor`, so theme swaps recolor every icon at no JS cost.
   */
  icon: ReactNode;
  /** Feature name. Rendered as `<h3>`. */
  title: string;
  /** Technical claim copy. Rendered as `<p>`. */
  description: string;
};

export function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <article className="feature-card">
      <div className="feature-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </article>
  );
}
