'use client';

/**
 * Controlled star-rating radiogroup (Req 12.2, 14.9, 14.10).
 *
 * Renders five native `<input type="radio">` elements paired with `<label>`
 * children that carry the visible star SVG. The component is fully
 * controlled — the parent owns `value` and supplies `onChange`. The form
 * submitting page (review form) reads `value` directly from its own state.
 *
 * Native radio buttons are used (not buttons or divs) so the browser
 * automatically:
 *   - exposes `aria-checked` on the focused/checked input,
 *   - emits `change` events for click and Space activation,
 *   - groups the inputs by `name` attribute so only one is checked at a time.
 *
 * Accessibility model:
 *   - The wrapping element carries `role="radiogroup"` plus `aria-label` so
 *     a screen reader announces the group name when focus enters.
 *   - Roving tabindex: only the *checked* input has `tabIndex={0}`; the
 *     others are `tabIndex={-1}`. When nothing is selected yet, the FIRST
 *     input receives `tabIndex={0}` so Tab can land in the group cleanly.
 *     This means Shift+Tab moves the user OUT of the group rather than
 *     stepping through five inputs one by one (Req 14.10).
 *   - Keyboard handler is attached to the `<div>` (not each `<input>`) so
 *     arrows respond regardless of which input currently has focus. Arrow
 *     presses do NOT directly move focus — they only call `onChange`, and
 *     a `useEffect` watching `value` focuses the now-checked radio after
 *     the next render so the visible focus ring stays in sync with the
 *     committed selection.
 *   - ArrowRight / ArrowUp increment, ArrowLeft / ArrowDown decrement,
 *     clamped to the 1..5 range. Pressing ArrowRight while value === 5 is
 *     a no-op (no `onChange`, no focus jump) — same for ArrowLeft at 1.
 *
 * Visual model:
 *   - The inputs are visually hidden with the standard absolute / 1px /
 *     opacity-0 pattern but remain focusable so the browser still drives
 *     `:focus-visible` for the keyboard-only outline.
 *   - Each label houses one star SVG. The fill state is driven by a
 *     `data-filled` attribute (true for every star whose index is `<=
 *     value`) so the CSS can paint cumulatively without needing the
 *     `:has()` selector for the *committed* state. Hover cumulative fill
 *     uses `:has()` purely as polish; browsers without `:has()` still get
 *     a working single-star hover state.
 */

import { Fragment, useCallback, useEffect, useId, useRef } from 'react';

type Props = {
  value: number | null;
  onChange: (v: number) => void;
  /** Form input name. Defaults to `'rating'` to match the existing review-form contract. */
  name?: string;
  /** Group label announced by screen readers. Defaults to `'Rating'`. */
  ariaLabel?: string;
};

// 1..5 — fixed sequence, never user-configurable per design.md → StarRating.
const STARS: ReadonlyArray<number> = [1, 2, 3, 4, 5];

export function StarRating({
  value,
  onChange,
  name = 'rating',
  ariaLabel = 'Rating',
}: Props) {
  // `useId` produces a stable unique base so multiple instances on the same
  // page don't collide on input IDs. The `htmlFor` / `id` pairing is what
  // makes label clicks check the right radio.
  const reactId = useId();
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Only handle the four navigation keys we care about. Other keys
      // (Tab, Enter, Space, etc.) keep their native behavior — Space on a
      // focused radio still selects it via the input's own `change` event.
      let next: number | null = null;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          next = Math.min(5, (value ?? 0) + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          // From a null starting value, decrementing lands on 1 — same as
          // incrementing — so the very first keystroke always selects a
          // valid rating regardless of direction.
          next = Math.max(1, (value ?? 1) - 1);
          break;
        default:
          return;
      }

      // Prevent the page scroll that arrow keys would otherwise trigger
      // when the document is the active element.
      e.preventDefault();

      // Only fire onChange when the value actually changes. ArrowRight at
      // 5 (and ArrowLeft at 1) are genuine no-ops, so a parent's onChange
      // isn't called repeatedly with the same value.
      if (next !== value) {
        onChange(next);
      }
      // Note: we do NOT move browser focus here. The `useEffect` below
      // watches `value` and focuses the now-checked radio after the next
      // render. This keeps the focus update colocated with the actual
      // selection state instead of speculatively focusing on every
      // (potentially clamped) keystroke.
    },
    [value, onChange],
  );

  // Keep the visible focus ring synchronized with the selected radio.
  // After the parent commits a new `value`, focus the matching input so
  // the user keeps typing into the right control. Skip the very first
  // render (when `value` is null) so opening the form doesn't steal
  // focus on mount.
  const previousValue = useRef<number | null>(value);
  useEffect(() => {
    if (value === null) {
      previousValue.current = null;
      return;
    }
    if (value === previousValue.current) {
      return;
    }
    previousValue.current = value;
    // Only refocus when one of our radios already had focus — otherwise
    // a parent setting `value` programmatically (e.g. resetting after
    // submit) would yank focus into the group unexpectedly.
    const ownsFocus = inputRefs.current.some(
      (el) => el !== null && el === document.activeElement,
    );
    if (ownsFocus) {
      inputRefs.current[value - 1]?.focus();
    }
  }, [value]);

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="star-rating"
      onKeyDown={handleKeyDown}
    >
      {STARS.map((n) => {
        const inputId = `${reactId}-star-${n}`;
        const isChecked = value === n;
        // A star is "filled" when its index is at or below the committed
        // value. Drives the colored-in CSS for the SVG below.
        const isFilled = value !== null && n <= value;
        // Roving tabindex: the checked radio is the entry point. When the
        // group has no selection yet, the FIRST radio holds tabIndex=0 so
        // Tab can step into the group; once a value is selected, only that
        // radio holds tabIndex=0.
        const isRovingFocus = isChecked || (value === null && n === 1);

        return (
          <Fragment key={n}>
            <input
              ref={(el) => {
                inputRefs.current[n - 1] = el;
              }}
              id={inputId}
              type="radio"
              name={name}
              value={n}
              checked={isChecked}
              tabIndex={isRovingFocus ? 0 : -1}
              className="star-rating-input"
              onChange={() => onChange(n)}
              aria-label={`${n} star${n === 1 ? '' : 's'}`}
            />
            <label
              htmlFor={inputId}
              className="star-rating-label"
              data-filled={isFilled ? 'true' : 'false'}
            >
              <StarSvg />
            </label>
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * Five-pointed star drawn as a single path. `aria-hidden` because the
 * label/input already carries the accessible name — a screen reader doesn't
 * need to enumerate the SVG geometry.
 */
function StarSvg() {
  return (
    <svg
      className="star-rating-icon"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 2.5l2.9 6 6.6.5-5.1 4.5 1.6 6.4-6-3.6-6 3.6 1.6-6.4-5.1-4.5 6.6-.5z" />
    </svg>
  );
}
