'use client';

import { useEffect, useMemo, useState } from 'react';

import { createSupabaseBrowserClient } from '@/lib/supabase/browser';

export default function ResetPasswordPage() {
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
      <div className="auth-card glass-panel">
        <p className="section-tag" style={{ textAlign: 'center' }}>
          RESET
        </p>
        <h1 className="auth-title">Set a new password</h1>
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
