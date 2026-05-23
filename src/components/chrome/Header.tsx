'use client';

/**
 * Site header.
 *
 * Client component because it owns three pieces of runtime state that the
 * server cannot resolve:
 *   1. The Supabase user (read once on mount via the browser client) so the
 *      auth action can render as "Login" or "Account + Logout".
 *   2. An `IntersectionObserver` watching the `.header-sentinel` element
 *      that `<SiteShell />` places at the top of `<main>`. The observer
 *      toggles `data-scrolled="true|false"` on the `<header>` element so
 *      CSS can swap the backdrop-blur, background tint, and bottom-border
 *      between scrolled / un-scrolled states (Req 5.2). No `scroll` event
 *      listener is attached anywhere — the observer detaches on unmount.
 *   3. The mobile-menu open/close state, threaded through to `<MobileMenu />`
 *      together with a ref to the trigger button so focus returns there
 *      after the overlay closes (Req 5.7, 14.11).
 *
 * Layout (Req 5.1, 5.3, 5.4):
 *   `<header class="header">` is fixed at the top of the viewport with a
 *   constant height of `--nav-height` (64px). Inside, `.header-inner`
 *   constrains content to `--max-width` and uses flexbox to push the logo
 *   left and the nav + actions right.
 *
 *   The desktop primary nav (`.header-nav`) renders the four `NAV_LINKS` in
 *   a horizontal `<ul>`. CSS hides it below 768px so the mobile-menu
 *   trigger takes its place at narrow widths.
 *
 *   The actions cluster carries the theme toggle, the auth action, and the
 *   mobile-menu trigger (visible only below 768px). The auth action
 *   reserves placeholder space while `isLoggedIn === null` so login state
 *   changes contribute zero CLS (Req 19.4).
 *
 * Logo heartbeat (Req 5.8):
 *   The logo is a `next/image` with `alt=""` paired with a sibling
 *   `<span>UNVIEWABLE</span>` that carries the brand name for screen
 *   readers. The image element has no `::before` pseudo-element and no
 *   keyframed pulse animation; this is enforced by the absence of any
 *   matching CSS rule in `globals.css`.
 *
 * Logout flow:
 *   `handleLogout` calls `supabase.auth.signOut()` and then performs a
 *   hard navigation to `/login` via `window.location.href` so the server
 *   sees the cleared cookies on the next request. This preserves the
 *   existing behaviour of the legacy header.
 */

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';

import { MobileMenu } from './MobileMenu';
import { NAV_LINKS } from './nav-links';

export function Header() {
  // ── Refs ──────────────────────────────────────────────────────────────
  // The header element is the observer target for `data-scrolled` toggling.
  // The trigger ref is forwarded to `<MobileMenu />` so closing the overlay
  // restores keyboard focus to the button that opened it (Req 5.7, 14.11).
  const headerRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // ── State ─────────────────────────────────────────────────────────────
  // `null` while the auth check is in flight. The header reserves a fixed
  // slot for the auth action regardless of state so the slot does not
  // shrink or grow when the result arrives (Req 19.4 — zero CLS).
  const [isLoggedIn, setIsLoggedIn] = useState<boolean | null>(null);
  // Held for completeness so future auth-aware affordances (e.g. an avatar
  // or initials chip) can read the email without a second Supabase call.
  // Currently not rendered into the DOM by the header itself.
  const [, setUserEmail] = useState<string>('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Memoise the Supabase client so the auth effect doesn't re-create it on
  // every render. The browser client wraps a single shared instance under
  // the hood, but memoising avoids needless re-references in deps.
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  // ── Effect 1: Auth bootstrap ──────────────────────────────────────────
  // Read the current user once on mount. The cancelled flag prevents a
  // late-arriving response from writing into unmounted component state.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        if (cancelled) return;
        const user = data?.user ?? null;
        setIsLoggedIn(Boolean(user));
        setUserEmail(user?.email ?? '');
      } catch {
        // Network failure or misconfigured client — treat as unauthenticated
        // so the header still renders a usable Login link rather than a
        // perpetual placeholder slot.
        if (cancelled) return;
        setIsLoggedIn(false);
        setUserEmail('');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // ── Effect 2: Sentinel-based scroll detection ─────────────────────────
  // A single `IntersectionObserver` watches the 1px `.header-sentinel`
  // placed at the very top of `<main>` by `<SiteShell />`. While the
  // sentinel is intersecting the viewport the page is at the top, so
  // `data-scrolled` is `'false'`. Once it leaves, the page has scrolled
  // and `data-scrolled` flips to `'true'`. CSS handles the visual change
  // (backdrop-blur, border, background tint) — see the `.header` rules
  // added to `globals.css` for the visual contract.
  useEffect(() => {
    const headerEl = headerRef.current;
    if (!headerEl) return;

    const sentinel = document.querySelector('.header-sentinel');
    if (!sentinel) {
      // No sentinel rendered (route forgot to use `<SiteShell />` or
      // mounted the header standalone for a smoke test). Default to the
      // un-scrolled state so the header still has a defined attribute
      // value for CSS to read.
      headerEl.dataset.scrolled = 'false';
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        headerEl.dataset.scrolled = entry.isIntersecting ? 'false' : 'true';
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────
  const handleOpenMobileMenu = useCallback(() => setMobileMenuOpen(true), []);
  const handleCloseMobileMenu = useCallback(() => setMobileMenuOpen(false), []);

  const handleLogout = useCallback(async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // Ignore — even if Supabase fails to clear cookies server-side, we
      // still navigate to /login so the user lands somewhere sensible.
    }
    // Hard navigation so the server sees the cleared session cookies on
    // the next request (preserves legacy header behaviour).
    window.location.href = '/login';
  }, [supabase]);

  return (
    <>
      <header ref={headerRef} className="header" data-scrolled="false">
        <div className="header-inner">
          {/* Logo + brand name. `alt=""` is correct because the visible
              "UNVIEWABLE" word-mark sibling already carries the accessible
              name (Req 14.6, 5.8). */}
          <Link href="/" className="header-logo" aria-label="Unviewable home">
            <Image
              src="/logo.png"
              alt=""
              width={36}
              height={36}
              priority
            />
            <span className="header-logo-text">UNVIEWABLE</span>
          </Link>

          {/* Desktop primary nav. CSS hides this below 768px (Req 5.4). */}
          <nav className="header-nav" aria-label="Primary">
            <ul>
              {NAV_LINKS.map(({ label, href }) => (
                <li key={href}>
                  <Link href={href}>{label}</Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="header-actions">
            <ThemeToggle />

            {/* Auth action slot. While `isLoggedIn === null` we still
                render an element of the same shape (an empty placeholder
                with the same min-width) so the row width does not change
                when the result arrives — zero CLS (Req 19.4). */}
            <div className="header-auth" aria-live="polite">
              {isLoggedIn === null ? (
                <span className="header-auth-placeholder" aria-hidden="true" />
              ) : isLoggedIn ? (
                <>
                  <Link className="header-link" href="/account">
                    Account
                  </Link>
                  <button
                    type="button"
                    className="header-link header-logout"
                    data-action="logout"
                    onClick={handleLogout}
                  >
                    Logout
                  </button>
                </>
              ) : (
                <Link className="header-link" href="/login">
                  Login
                </Link>
              )}
            </div>

            {/* Mobile-menu trigger. CSS hides this at >= 768px (Req 5.4). */}
            <button
              ref={triggerRef}
              type="button"
              className="header-mobile-trigger"
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-menu"
              aria-label="Open menu"
              onClick={handleOpenMobileMenu}
            >
              <MenuIcon />
            </button>
          </div>
        </div>
      </header>

      <MobileMenu
        open={mobileMenuOpen}
        onClose={handleCloseMobileMenu}
        triggerRef={triggerRef}
        isLoggedIn={Boolean(isLoggedIn)}
        onLogout={handleLogout}
      />
    </>
  );
}

/**
 * Inline hamburger icon. `aria-hidden` keeps it out of the accessibility
 * tree because the surrounding button already carries `aria-label="Open menu"`.
 */
function MenuIcon() {
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
      <path d="M3 6h18" />
      <path d="M3 12h18" />
      <path d="M3 18h18" />
    </svg>
  );
}
