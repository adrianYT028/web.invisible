'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';

import { createSupabaseBrowserClient } from '@/lib/supabase/browser';

type Tab = 'login' | 'signup';

function getRedirectBase() {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname;
  const isLocal = host === 'localhost' || host === '127.0.0.1';

  const configuredProd = process.env.NEXT_PUBLIC_SITE_URL;
  if (!isLocal && configuredProd && configuredProd.startsWith('http')) {
    return configuredProd.replace(/\/$/, '');
  }
  return window.location.origin;
}

export default function LoginClient() {
  const searchParams = useSearchParams();
  // Open-redirect guard: only accept same-origin relative paths. Reject
  // absolute URLs (http://, https://), protocol-relative (//evil.com), and
  // anything that doesn't begin with a single '/'. Falls back to '/'.
  const rawRedirect = searchParams.get('redirectedFrom') || '/';
  const redirectedFrom =
    rawRedirect.startsWith('/') && !rawRedirect.startsWith('//')
      ? rawRedirect
      : '/';

  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  const [tab, setTab] = useState<Tab>('login');
  const [error, setError] = useState<string>('');
  const [info, setInfo] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  const [signupName, setSignupName] = useState('');
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!cancelled && data?.session) {
        window.location.href = redirectedFrom;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [redirectedFrom, supabase]);

  async function handleGoogle() {
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          // Carry redirectedFrom through the OAuth round-trip so that, after
          // Google sign-in, /auth/callback returns the user to the original
          // page (critical for /auth/desktop?device_code=... — without this
          // the desktop link flow never completes for Google users).
          redirectTo:
            getRedirectBase() +
            `/auth/callback?next=${encodeURIComponent(redirectedFrom)}`,
        },
      });
      if (oauthError) throw oauthError;
    } catch (e: any) {
      setError(e?.message || 'Could not sign in. Try again.');
      setLoading(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const email = loginEmail.trim().toLowerCase();
      const password = loginPassword;
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) throw signInError;
      window.location.href = redirectedFrom;
    } catch (e: any) {
      setError(e?.message || 'Could not log in.');
      setLoading(false);
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const email = signupEmail.trim().toLowerCase();
      const password = signupPassword;
      const name = signupName.trim();

      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: name,
          },
          emailRedirectTo:
            getRedirectBase() +
            `/auth/callback?next=${encodeURIComponent(redirectedFrom)}`,
        },
      });
      if (signUpError) throw signUpError;

      if (data?.session) {
        window.location.href = redirectedFrom;
        return;
      }

      // Some Supabase projects return `session: null` even when email confirmation is off.
      // Try to sign in immediately so the UX stays consistent.
      const { error: autoSignInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (!autoSignInError) {
        window.location.href = redirectedFrom;
        return;
      }

      const msg = String(autoSignInError.message || '').toLowerCase();
      if (msg.includes('confirm') || msg.includes('confirmed')) {
        setInfo('Account created. Check your email to confirm, then log in.');
      } else {
        setInfo('Account created. Please log in.');
      }
      setTab('login');
      setLoginEmail(email);
      setLoading(false);
    } catch (e: any) {
      setError(e?.message || 'Could not create account.');
      setLoading(false);
    }
  }

  async function handleForgotPassword() {
    setError('');
    setInfo('');
    const email = loginEmail.trim().toLowerCase();
    if (!email) {
      setError('Enter your email to reset your password.');
      return;
    }
    setLoading(true);
    try {
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: getRedirectBase() + '/login/reset',
      });
      if (resetError) throw resetError;
      setInfo('Password reset email sent.');
      setLoading(false);
    } catch (e: any) {
      setError(e?.message || 'Password reset failed.');
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
          <p className="eyebrow">ACCESS</p>
          <h1 className="auth-title">Welcome back</h1>
          <p className="auth-sub">Log in or create an account to access Unviewable.</p>

          <div className="auth-tabs" role="tablist">
            <button
              type="button"
              className={`auth-tab ${tab === 'login' ? 'is-active' : ''}`}
              onClick={() => {
                setTab('login');
                setError('');
                setInfo('');
              }}
              disabled={loading}
            >
              Log in
            </button>
            <button
              type="button"
              className={`auth-tab ${tab === 'signup' ? 'is-active' : ''}`}
              onClick={() => {
                setTab('signup');
                setError('');
                setInfo('');
              }}
              disabled={loading}
            >
              Sign up
            </button>
          </div>

          {tab === 'login' ? (
            <form className="auth-form" onSubmit={handleLogin} noValidate>
              <input
                className="auth-input"
                type="email"
                placeholder="you@company.com"
                required
                autoComplete="email"
                aria-label="Email address"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                disabled={loading}
              />
              <input
                className="auth-input"
                type="password"
                placeholder="Password"
                required
                autoComplete="current-password"
                aria-label="Password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                disabled={loading}
              />
              <button
                type="button"
                className="auth-link"
                onClick={handleForgotPassword}
                disabled={loading}
              >
                Forgot password?
              </button>
              <button type="submit" className="auth-primary" disabled={loading}>
                Log in with email
              </button>
            </form>
          ) : (
            <form className="auth-form" onSubmit={handleSignup} noValidate>
              <input
                className="auth-input"
                type="text"
                placeholder="Full name"
                required
                aria-label="Full name"
                value={signupName}
                onChange={(e) => setSignupName(e.target.value)}
                disabled={loading}
              />
              <input
                className="auth-input"
                type="email"
                placeholder="you@company.com"
                required
                autoComplete="email"
                aria-label="Email address"
                value={signupEmail}
                onChange={(e) => setSignupEmail(e.target.value)}
                disabled={loading}
              />
              <input
                className="auth-input"
                type="password"
                placeholder="Create password"
                required
                autoComplete="new-password"
                aria-label="Password"
                value={signupPassword}
                onChange={(e) => setSignupPassword(e.target.value)}
                disabled={loading}
              />
              <button type="submit" className="auth-primary" disabled={loading}>
                Create account
              </button>
            </form>
          )}

          <div className="auth-actions">
            <button
              className="auth-primary auth-secondary"
              type="button"
              onClick={handleGoogle}
              disabled={loading}
            >
              <img
                className="google-icon"
                src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
                alt="Google logo"
              />
              <span>Continue with Google</span>
            </button>
          </div>

          <p className="auth-error" role="alert">
            {error || info}
          </p>
          <p className="auth-note">By continuing, you agree to our terms and privacy policy.</p>
        </div>
      </div>
  );
}
