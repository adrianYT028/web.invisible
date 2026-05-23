'use client';

/**
 * Mobile primary-navigation overlay.
 *
 * Renders the same primary nav links and auth action that `<Header />` shows
 * inline at desktop widths, but stacked vertically inside a full-screen
 * dialog so they remain reachable on viewports below 768px (Req 5.4–5.7).
 *
 * Open/close lifecycle:
 *   - When `open` is `false`, the component returns `null` so no overlay
 *     markup exists in the DOM. The dialog enters the accessibility tree
 *     only while it is actually visible. The trigger button itself lives
 *     on the header, so re-opening the menu is always one tap away even
 *     though the dialog is unmounted.
 *   - When `open` flips to `true`, a single `useEffect` keyed on `open`
 *     locks document scroll, installs a `keydown` listener for the focus
 *     trap and `Escape` handling, and focuses the close button.
 *   - When `open` flips back to `false` (or the component unmounts), the
 *     effect cleanup restores `document.body.style.overflow`, removes the
 *     scrollbar-width compensation, removes the keydown listener, and moves
 *     keyboard focus back to `triggerRef.current` (Req 5.7, 14.11).
 *
 * Scroll lock with no Windows layout-shift:
 *   The dialog covers the page, but locking `overflow: hidden` on the body
 *   removes the vertical scrollbar on platforms that render one (Windows,
 *   most Linux desktops). Without compensation the page underneath would
 *   shift right by the scrollbar width — visible behind a translucent
 *   overlay or for the brief moment between open and close. We add a
 *   `padding-right` of exactly `window.innerWidth - documentElement.clientWidth`
 *   on the body to absorb that delta. The cleanup restores both styles to
 *   their previous (inline) values.
 *
 * Focus trap (manual, no library):
 *   We avoid pulling in `focus-trap-react` (~3 kB gzipped) because the JS
 *   budget on every non-home marketing page is 60 kB and the trap logic is
 *   short. On every `keydown` we re-query focusable elements (a fresh query
 *   tolerates DOM changes between keystrokes) and wrap Tab / Shift+Tab from
 *   the boundary nodes. Focusable selector is the well-known set used by
 *   most a11y libraries: anchors with hrefs, enabled buttons, and any node
 *   with a non-negative `tabindex`.
 *
 * Auth action (delegated to parent):
 *   The dialog mirrors the header's auth action contract. While
 *   unauthenticated, a single `Login` link to `/login` is rendered. While
 *   authenticated, an `Account` link to `/account` is always rendered, and
 *   a `Logout` button is rendered only when the parent passes an `onLogout`
 *   handler. This component does NOT call `supabase.auth.signOut()` itself —
 *   the parent `<Header />` owns the Supabase client lifecycle and the
 *   post-logout navigation, so it passes the callback in. The button still
 *   emits a `data-action="logout"` attribute so integration tests and any
 *   future analytics layer can identify the control without depending on
 *   text content.
 *
 * Accessibility contract:
 *   - `role="dialog"` + `aria-modal="true"` + `aria-label="Site menu"` mark
 *     the overlay as a modal dialog with a programmatic name.
 *   - `id="mobile-menu"` matches the trigger's `aria-controls` (set in the
 *     header).
 *   - The close button is the first focusable element in DOM order so the
 *     Tab cycle is `close → nav links → auth action → close` (Req 14.11).
 *   - The close button carries `aria-label="Close menu"` because its visible
 *     content is an icon.
 *   - Every nav link activates `onClose` so a normal pointer click closes
 *     the overlay along with navigation.
 */

import { useEffect, useRef } from 'react';
import { NAV_LINKS } from './nav-links';

/**
 * Standard focusable-element selector. Matches anchors with hrefs (every
 * link in the dialog is a real anchor), enabled buttons (close + logout),
 * and any other node that explicitly opts into the tab order. The negation
 * on `[tabindex="-1"]` keeps elements that have been programmatically taken
 * out of the cycle from re-entering it via this query.
 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Props = {
  /** Whether the overlay is visible. When `false`, the component returns `null`. */
  open: boolean;
  /** Invoked when the user presses Escape, clicks the close button, or activates a link. */
  onClose: () => void;
  /**
   * Ref to the `<button>` that opened the menu. Focus returns here after the
   * dialog closes so keyboard users land back on the control they used to
   * open the menu (Req 5.7, 14.11). Typed to allow `null` because React 19
   * `useRef<HTMLButtonElement>(null)` produces `RefObject<HTMLButtonElement | null>`.
   */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** When true, the dialog renders Account (and Logout if `onLogout` is provided). When false, it renders Login. */
  isLoggedIn: boolean;
  /**
   * Optional logout handler. When provided AND `isLoggedIn === true`, the
   * dialog renders a Logout button that invokes this callback on click.
   * The button additionally closes the overlay before invoking the handler
   * so the parent can navigate without the menu sticking around in the DOM.
   * When omitted, no Logout button is rendered — useful for surfaces where
   * the parent doesn't yet have a Supabase client wired up.
   */
  onLogout?: () => void;
};

export function MobileMenu({ open, onClose, triggerRef, isLoggedIn, onLogout }: Props) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    // ── Scroll lock + scrollbar-width compensation ──
    // Capture the previous inline values so the cleanup can restore them
    // exactly, even if some other code path had already set `overflow` or
    // `padding-right` on the body.
    const previousOverflow = document.body.style.overflow;
    const previousPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    // ── Initial focus ──
    // Prefer the close button so Tab from there walks down the link list,
    // and a quick Enter / Space dismisses the menu without exploration.
    // Fall back to the first focusable in case the close button ref hasn't
    // populated yet for any reason.
    const focusables = overlay.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    const initialTarget = closeButtonRef.current ?? focusables[0] ?? null;
    initialTarget?.focus();

    // ── Keydown handler: Escape + Tab cycle ──
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // Re-query each keystroke so the trap stays correct if the focusable
      // set changes (e.g. logout button mounting after a session check).
      const items = overlay.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (items.length === 0) {
        // No focusables means there is nothing to cycle through; keep focus
        // pinned to the dialog itself so it doesn't escape to the page.
        event.preventDefault();
        overlay.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        // Shift+Tab from the first focusable (or from outside the dialog
        // entirely) wraps to the last focusable.
        if (active === first || !overlay.contains(active)) {
          last.focus();
          event.preventDefault();
        }
      } else {
        // Tab from the last focusable wraps to the first.
        if (active === last) {
          first.focus();
          event.preventDefault();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPaddingRight;
      // Restore focus to the trigger so keyboard users land back on the
      // control they used to open the menu. Optional chaining covers the
      // case where the trigger has been unmounted (parent re-render).
      triggerRef.current?.focus();
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      id="mobile-menu"
      role="dialog"
      aria-modal="true"
      aria-label="Site menu"
      className="mobile-menu"
      // The dialog itself is a programmatic focus target only when no
      // focusable descendant exists; tabindex={-1} keeps it out of the Tab
      // order during normal use.
      tabIndex={-1}
    >
      <div className="mobile-menu-header">
        <button
          ref={closeButtonRef}
          type="button"
          className="mobile-menu-close"
          aria-label="Close menu"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>

      <nav aria-label="Primary mobile" className="mobile-menu-nav">
        {NAV_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="mobile-menu-link"
            onClick={onClose}
          >
            {link.label}
          </a>
        ))}
      </nav>

      <div className="mobile-menu-actions">
        {isLoggedIn ? (
          <>
            <a
              href="/account"
              className="mobile-menu-link"
              onClick={onClose}
            >
              Account
            </a>
            {onLogout ? (
              <button
                type="button"
                className="mobile-menu-link mobile-menu-logout"
                data-action="logout"
                onClick={() => {
                  // Close the overlay before invoking the parent's handler
                  // so a hard navigation (or router push) doesn't race with
                  // the unmount-driven focus restore.
                  onClose();
                  onLogout();
                }}
              >
                Logout
              </button>
            ) : null}
          </>
        ) : (
          <a className="mobile-menu-link" href="/login" onClick={onClose}>
            Login
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * Inline X icon for the close button. `aria-hidden` keeps it out of the
 * accessibility tree because the surrounding button already carries
 * `aria-label="Close menu"`.
 */
function CloseIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}
