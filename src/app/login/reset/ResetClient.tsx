'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';

import { createSupabaseBrowserClient } from '@/lib/supabase/browser';

/**
 * `/login/reset` — client island.
 *
 * Owns the password-reset flow:
 *   1. On mount, if the URL carries a Supabase recovery `code=…` query
 *      parameter, exchange it for a session via `exchangeCodeForSession`
 *      so the subsequent `updateUser` call is authorised. Failures here
 *      surface a generic prompt to request a new reset link — the exact
 *      message string is preserved verbatim from the pre-redesign code
 *      so behaviour stays identical.
 *   2. On form submit, call `supabase.auth.updateUser({ password })` with
 *      the same payload shape the legacy implementation used. On success
 *      we redirect to `/login` via `window.location.href` (full-page
 *      navigation) so the next request resolves the new session through
 *      Supabase's cookie-based middleware path.
 *
 * Visual surface lives in the existing `.auth-shell` / `.auth-card`
 * tokenised rule blocks in `globals.css` (task 5.3). The component does
 * not render `<SiteShell />` itself — the parent server `page.tsx` is
 * responsible for the chrome wrapper, which keeps `<Header />`,
 * `<Footer />`, and `<SkipToContent />` as true server components in
 * the tree (no `'use client'` directive crosses their boundary).
 *
 * What is intentionally preserved (Req 17.1–17.8):
 *   - Input `type` / `required` / `autoComplete` / `aria-label` attrs.
 *   - Validation behaviour (none — we let Supabase reject empty/short
 *     passwords with its own error messages, as the legacy code did).
 *   - Error message text, including the generic
 *     `'Auth session missing. Please request a new reset link.'` and
 *     the fallback `'Password update failed.'`.
 *   - Supabase call surface: `exchangeCodeForSession`, `updateUser`.
 *   - The redirect target on success (`/login`).
 */
export default function ResetClient() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const url = window.location.href;
      const hasCode = url.includes('code=');
      if (!hasCode) return;

      const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(url);
      if (!cancelled && exchangeError) {
        setError('Auth session missing. Please request a new reset link.');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });
      if (updateError) throw updateError;
      window.location.href = '/login';
    } catch (e: any) {
      setError(e?.message || 'Password update failed.');
      setLoading(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-logo">
          <Image
            src="/logo.png"
            alt=""
            width={40}
            height={40}
            priority
            className="auth-logo-img"
          />
          <span className="auth-logo-text">UNVIEWABLE</span>
        </div>
        <p className="eyebrow">RESET</p>
        <h1 className="auth-title">
          Set a <em>new</em> password
        </h1>
        <p className="auth-sub">Enter a new password to regain access.</p>

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <input
            className="auth-input"
            type="password"
            placeholder="New password"
            required
            autoComplete="new-password"
            aria-label="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={loading}
          />
          <button type="submit" className="auth-primary" disabled={loading}>
            Update password
          </button>
        </form>
        <p className="auth-error" role="alert">
          {error}
        </p>
      </div>
    </div>
  );
}
