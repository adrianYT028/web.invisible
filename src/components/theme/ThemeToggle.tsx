'use client';

/**
 * Client-side theme toggle.
 *
 * Reads the active theme from `<html data-theme>` (the source of truth set by
 * the synchronous pre-paint script in `theme-script.tsx`) and flips it on
 * click, persisting the choice to `localStorage` under `THEME_KEY`.
 *
 * Hydration safety:
 *   `useSyncExternalStore` is used so the server snapshot (`'dark'`, the
 *   default rendered into the SSR HTML) and the client snapshot (the value
 *   the pre-paint script just wrote to `<html>`) are reconciled by React 19
 *   without triggering a hydration mismatch warning.
 *
 *   The `subscribe` callback registers in a module-scoped listener set. The
 *   ONLY writer of `data-theme` is this component's click handler, which
 *   notifies all subscribers after writing the attribute. We deliberately do
 *   not listen for `storage` events (cross-tab sync) — that is a future
 *   enhancement and not required by the current acceptance criteria.
 *
 * Persistence:
 *   `localStorage.setItem` is wrapped in try/catch so private-mode browsers,
 *   quota errors, or any other storage failure fall through silently. The
 *   in-memory toggle still works; persistence simply doesn't survive reload.
 *
 * Accessibility:
 *   - Native `<button type="button">` carries Enter and Space activation for
 *     free.
 *   - `aria-pressed` reports whether the alternate theme (light) is active —
 *     `true` when light, `false` when dark. This matches the screen-reader
 *     mental model of "is the light mode toggle switched on?".
 *   - `aria-label` is recomputed each render so it reads the destination
 *     theme, e.g. "Switch to light theme" while dark is active.
 *   - The hit target is ≥ 44×44 px (Req 12.2) via `min-width` / `min-height`
 *     in the `.theme-toggle` rule in `globals.css`.
 *   - Both icons are inline SVG with `aria-hidden="true"` so they never reach
 *     the accessibility tree; the button's label carries all semantics.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { THEME_KEY, type ThemeMode } from './theme-types';

// Module-scoped listener registry. The toggle's click handler writes
// `data-theme`, then calls `notify()` to flush all subscribers so React
// re-reads the snapshot. Kept tiny on purpose — we don't need a full event
// bus for a single-attribute store.
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function notify(): void {
  listeners.forEach((listener) => listener());
}

function getSnapshot(): ThemeMode {
  const value = document.documentElement.getAttribute('data-theme');
  return value === 'light' ? 'light' : 'dark';
}

function getServerSnapshot(): ThemeMode {
  // Must match the default the SSR HTML carries before any localStorage read.
  // The pre-paint script writes the persisted value before hydration, so the
  // first client snapshot may differ — `useSyncExternalStore` reconciles it.
  return 'dark';
}

type Props = {
  className?: string;
};

export function ThemeToggle({ className }: Props) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isLight = theme === 'light';
  const targetLabel = isLight ? 'Switch to dark theme' : 'Switch to light theme';

  const handleClick = useCallback(() => {
    // Re-read the live attribute instead of trusting the closed-over snapshot,
    // in case some other code path mutated `<html>` between renders.
    const current = document.documentElement.getAttribute('data-theme');
    const next: ThemeMode = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);

    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage unavailable (private mode, quota, disabled). Swallow silently
      // — the toggle still works for the current session, persistence just
      // doesn't survive reload. No user-visible error per design.
    }

    notify();
  }, []);

  const composedClassName = className ? `theme-toggle ${className}` : 'theme-toggle';

  return (
    <button
      type="button"
      className={composedClassName}
      aria-pressed={isLight}
      aria-label={targetLabel}
      title={targetLabel}
      onClick={handleClick}
    >
      {isLight ? <MoonIcon /> : <SunIcon />}
    </button>
  );
}

/**
 * Sun icon — shown when the dark theme is active to indicate that clicking
 * will switch to light. `aria-hidden` keeps it out of the a11y tree because
 * the button's `aria-label` already conveys the action.
 */
function SunIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="M4.93 4.93l1.41 1.41" />
      <path d="M17.66 17.66l1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M4.93 19.07l1.41-1.41" />
      <path d="M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

/**
 * Moon icon — shown when the light theme is active to indicate that clicking
 * will switch to dark.
 */
function MoonIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
