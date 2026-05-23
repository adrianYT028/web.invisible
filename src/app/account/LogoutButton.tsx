'use client';

/**
 * `<LogoutButton />` — client component used on `/account`.
 *
 * Calls `supabase.auth.signOut()` and then performs a hard navigation to
 * `/login` via `window.location.href`. The hard navigation guarantees the
 * server sees the cleared session cookies on the next request — same
 * approach the `<Header />` uses for its inline Logout control, so the
 * two surfaces stay behaviour-equivalent (Req 17.5).
 *
 * Visual: styled with the shared CTA secondary variant (`cta cta-secondary`).
 * That class pair is the same one used by `<HeroSection />` for its
 * non-primary action, so the logout control inherits the same hover lift,
 * focus ring, and 44px hit-target floor as every other secondary CTA on
 * the marketing surface — no per-component overrides required.
 *
 * Failure handling (Req 17.5):
 *   `signOut()` is wrapped in try/catch and the catch block is intentionally
 *   empty. Even if Supabase fails to clear cookies server-side (network
 *   blip, expired refresh token), we still navigate the user to `/login`
 *   so they land somewhere sensible rather than getting stuck on a stale
 *   account view. Mirrors the `<Header />` logout fallback.
 */

import { createSupabaseBrowserClient } from '@/lib/supabase/browser';

export function LogoutButton() {
  async function handleLogout() {
    try {
      const supabase = createSupabaseBrowserClient();
      await supabase.auth.signOut();
    } catch {
      // ignore — proceed with navigation regardless so the user lands
      // somewhere sensible even when the sign-out request fails.
    }
    // Hard navigation so the server sees the cleared session cookies on
    // the next request. Matches the legacy header behaviour.
    window.location.href = '/login';
  }

  return (
    <button
      type="button"
      className="cta cta-secondary"
      onClick={handleLogout}
      data-action="logout"
    >
      Sign out
    </button>
  );
}
