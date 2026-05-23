'use client';

/**
 * DisabledCta — the keyboard- and pointer-inert "Coming Soon" variant of
 * <CtaButton />.
 *
 * Why this is a separate file instead of inline in `CtaButton.tsx`:
 *   `CtaButton.tsx` is a server component so that the dominant primary and
 *   secondary anchor variants ship zero JavaScript. The disabled variant has
 *   to attach an `onClick` and an `onKeyDown` handler — both are runtime
 *   values that React Server Components cannot serialise — so it must live
 *   on the client side of the boundary. Splitting the disabled variant into
 *   its own `'use client'` module is the smallest possible client island
 *   and keeps the per-route JS budget (Req 13.7, 13.8) tight: the chunk only
 *   ships when a route actually composes a disabled CTA.
 *
 * Why the markup is `<button type="button" aria-disabled="true">`:
 *   - `<button>` (not `<a href>`) means there is no implicit navigation
 *     target. Even without our handlers, activating the button never
 *     follows a URL, never starts a download, and never changes scroll.
 *   - `type="button"` means the click never submits an enclosing form. If a
 *     future change wraps this control in a form, the activation still
 *     produces no side effect.
 *   - `aria-disabled="true"` (rather than the native `disabled` attribute)
 *     keeps the control reachable by Tab focus and by screen readers, so
 *     keyboard and assistive-tech users can still discover the label and
 *     any trailing badge that explains the "Coming Soon" reason. The
 *     native `disabled` attribute would remove the element from the focus
 *     order entirely, hiding the explanation.
 *
 * Why both `onClick` and `onKeyDown` handlers exist:
 *   On a native `<button>`, Enter and Space already dispatch a synthetic
 *   click event, so `onClick={preventDefault}` is sufficient to neutralise
 *   activation across mouse, touch, Enter, and Space. The explicit
 *   `onKeyDown` handler is redundant for that path but adds defence in
 *   depth: if a future refactor swaps the underlying element to something
 *   that does not synthesise click on key activation (e.g. a `<div>` with
 *   `role="button"`), the keyboard path stays inert.
 *
 * Both handlers are hoisted to module scope so React does not allocate a
 * fresh function instance on every render — the handlers are
 * identity-stable, which matters when this component is composed inside a
 * memoised parent that compares props by reference.
 */

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

type DisabledCtaProps = {
  label: string;
  reason: 'coming-soon';
  trailing?: ReactNode;
};

function preventClickDefault(event: MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

function preventKeyDefault(event: KeyboardEvent<HTMLButtonElement>): void {
  // Space on a native <button> would scroll the page if its default were
  // not suppressed; Enter would submit any enclosing form. Both are
  // already neutralised by the click handler on a native button, but
  // calling preventDefault here too keeps the inert behaviour intact if
  // the underlying element ever changes.
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
  }
}

export function DisabledCta({ label, reason, trailing }: DisabledCtaProps) {
  return (
    <button
      type="button"
      className="cta cta-disabled"
      aria-disabled="true"
      data-reason={reason}
      onClick={preventClickDefault}
      onKeyDown={preventKeyDefault}
    >
      {label}
      {trailing}
    </button>
  );
}
