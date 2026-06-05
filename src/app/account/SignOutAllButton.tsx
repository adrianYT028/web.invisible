'use client';

import { useState } from 'react';

/**
 * `<SignOutAllButton />` — client component on `/account` that triggers
 * /api/account/signout-all to revoke every active desktop session for the
 * signed-in user. The user's own browser session is untouched (the button
 * uses the website's cookie session to authenticate the API call but only
 * touches `desktop_sessions` rows server-side).
 *
 * Visible feedback: shows the count of revoked sessions on success, or a
 * generic error on failure. No redirect happens — the user stays on
 * /account.
 *
 * Uses a confirm-then-act pattern so an accidental click doesn't kill
 * every device session.
 */

export function SignOutAllButton() {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function doSignOutAll() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/account/signout-all', { method: 'POST' });
      if (!res.ok) {
        setFeedback('Sign-out failed. Please try again.');
        return;
      }
      const json = (await res.json()) as { revoked_count?: number };
      const n = json.revoked_count ?? 0;
      setFeedback(
        n === 0
          ? 'No active desktop sessions to sign out.'
          : `Signed out of ${n} desktop session${n === 1 ? '' : 's'}.`
      );
    } catch {
      setFeedback('Network error. Please try again.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div className="account-actions" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <button
          type="button"
          className="cta cta-secondary"
          onClick={doSignOutAll}
          disabled={busy}
          data-action="signout-all-confirm"
        >
          {busy ? 'Signing out…' : 'Yes, sign out everywhere'}
        </button>
        <button
          type="button"
          className="cta cta-secondary"
          onClick={() => setConfirming(false)}
          disabled={busy}
        >
          Cancel
        </button>
        {feedback ? (
          <p className="lede" style={{ width: '100%' }}>
            {feedback}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="account-actions">
      <button
        type="button"
        className="cta cta-secondary"
        onClick={() => setConfirming(true)}
        data-action="signout-all"
      >
        Sign out everywhere
      </button>
      {feedback ? (
        <p className="lede" style={{ marginTop: '0.75rem' }}>
          {feedback}
        </p>
      ) : null}
    </div>
  );
}
