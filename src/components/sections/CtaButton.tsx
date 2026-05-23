/**
 * CtaButton — the single call-to-action primitive used across the redesign.
 *
 * Three variants share a discriminated union so the caller only passes the
 * props that make sense for the chosen visual:
 *
 *   - `primary`   — filled accent button rendered as `<a href={…}>`. Used for
 *     the dominant action in the hero (e.g. download for Windows). Optional
 *     `download` boolean maps to the native `<a download>` attribute so the
 *     browser treats the click as a file download instead of a navigation.
 *     Optional `trailing` slot accepts any ReactNode (an inline badge, a
 *     small icon, a version pill) and renders after the label inside the
 *     same `inline-flex` row that the `.cta` base class establishes.
 *
 *   - `secondary` — transparent button with a 1px token border, also
 *     rendered as an `<a href={…}>`. Used for sibling actions where two
 *     CTAs sit beside each other and one must visually defer.
 *
 *   - `disabled`  — the "Coming Soon" state. Delegated to <DisabledCta />
 *     because that variant needs `onClick` and `onKeyDown` runtime handlers
 *     and therefore cannot ship from a server component. Splitting the
 *     disabled variant into its own client island keeps this file as a
 *     server component so the dominant primary/secondary variants ship
 *     zero JavaScript.
 *
 * Why this file stays a server component:
 *   The primary and secondary variants render plain anchors with no event
 *   handlers, so they have no reason to cross the server/client boundary.
 *   Marking the file `'use client'` would force every page that composes a
 *   CtaButton to ship the React handler runtime even when no handler is
 *   used. The disabled-variant client island is imported as a value here;
 *   Next.js handles the boundary automatically — the server component
 *   renders a placeholder for the client component and the client bundle
 *   loads only when a route actually composes a disabled CTA (Req 13.7,
 *   13.8).
 *
 * What this component intentionally does NOT do (Req 6.4):
 *   - No pulsing border, shimmer sweep, animated gradient stroke, or glow
 *     drop-shadow. The styling lives in `globals.css` under the `.cta`
 *     family and only animates `background-color`, `border-color`,
 *     `box-shadow`, and a 1px `translateY` over `--duration-base` (180ms).
 *   - No outline override beyond the 2px `--focus-ring` with 2px offset
 *     (Req 6.6).
 */

import type { ReactNode } from 'react';

import { DisabledCta } from './DisabledCta';

type CtaButtonProps =
  | {
      variant: 'primary';
      label: string;
      href: string;
      download?: boolean;
      trailing?: ReactNode;
    }
  | {
      variant: 'secondary';
      label: string;
      href: string;
    }
  | {
      variant: 'disabled';
      label: string;
      reason: 'coming-soon';
      trailing?: ReactNode;
    };

export function CtaButton(props: CtaButtonProps) {
  if (props.variant === 'disabled') {
    return (
      <DisabledCta
        label={props.label}
        reason={props.reason}
        trailing={props.trailing}
      />
    );
  }

  if (props.variant === 'primary') {
    return (
      <a
        href={props.href}
        className="cta cta-primary"
        // React renders `download={true}` as the bare `download` attribute
        // and omits it for `false`/`undefined`, which matches the native
        // anchor semantics we want.
        download={props.download}
      >
        {props.label}
        {props.trailing}
      </a>
    );
  }

  // secondary
  return (
    <a href={props.href} className="cta cta-secondary">
      {props.label}
    </a>
  );
}
