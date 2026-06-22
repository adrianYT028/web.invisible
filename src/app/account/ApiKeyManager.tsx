'use client';

import { useState } from 'react';

/**
 * `<ApiKeyManager />` — client component on `/account` that lets a
 * Free_Plan user add, replace, and remove their own Groq_Key. It is the
 * browser surface for the per-user key vault (ai-proxy-key-vault spec).
 *
 * Security contract (Req 2.1, 2.2):
 *   This component NEVER receives or renders any character of the plaintext
 *   Groq_Key beyond the `last_four` metadata. The plaintext is typed into a
 *   `type="password"` input, POSTed once over HTTPS to `/api/keys`, and then
 *   dropped from component state. The API only ever returns `{ last_four }`
 *   on success — never ciphertext, nonce, auth tag, or the plaintext key.
 *
 * State model:
 *   The server page passes the server-fetched `{ hasKey, lastFour }` as the
 *   initial props. We mirror them into local state so the UI can refresh
 *   in place after a Save (key now present) or Remove (key now absent)
 *   without a full page reload. When no key is stored we render the
 *   no-key state (Req 2.3); when a key is stored we render the masked
 *   key-set indicator with Replace/Remove controls (Req 2.1, 2.4).
 *
 * Validates: 1.1, 2.1, 2.2, 2.3.
 */

interface ApiKeyManagerProps {
  /** Whether a Groq_Key is already stored for the authenticated user. */
  hasKey: boolean;
  /** Final four characters of the stored key, or null when no key is set. */
  lastFour: string | null;
}

/** Groq_Key text-input bounds (Req 1.1). */
const MAX_KEY_LENGTH = 512;
const MIN_KEY_LENGTH = 1;

/**
 * Maps an API error `code` to a friendly inline message. Anything that is
 * not a recognised code (including a missing code) falls back to a generic
 * message so we never surface a raw server detail to the user.
 */
function messageForCode(code: string | undefined): string {
  switch (code) {
    case 'invalid_groq_key':
      return 'That Groq key looks invalid.';
    case 'validation_unavailable':
      return 'Couldn\u2019t validate the key right now \u2014 try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

export function ApiKeyManager({ hasKey, lastFour }: ApiKeyManagerProps) {
  const [keyPresent, setKeyPresent] = useState(hasKey);
  const [maskedLastFour, setMaskedLastFour] = useState<string | null>(lastFour);
  // `editing` drives whether the input form is shown. When no key is stored
  // we start in the editing state so the user can add one immediately;
  // when a key is stored we start in the read-only masked view and only
  // open the form when the user activates "Replace".
  const [editing, setEditing] = useState(!hasKey);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const canSave =
    !busy && trimmed.length >= MIN_KEY_LENGTH && trimmed.length <= MAX_KEY_LENGTH;

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: trimmed }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; last_four?: string; code?: string }
        | null;

      if (!res.ok || !json?.ok) {
        setError(messageForCode(json?.code));
        return;
      }

      // Success: refresh local state from the returned metadata and drop
      // the plaintext from memory by clearing the input.
      setKeyPresent(true);
      setMaskedLastFour(json.last_four ?? null);
      setValue('');
      setEditing(false);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/keys', { method: 'DELETE' });
      if (!res.ok) {
        setError('Couldn\u2019t remove the key. Please try again.');
        return;
      }
      // Key removed: fall back to the no-key state.
      setKeyPresent(false);
      setMaskedLastFour(null);
      setValue('');
      setEditing(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  // Key-set, read-only view: masked indicator + Replace / Remove (Req 2.1).
  if (keyPresent && !editing) {
    return (
      <div className="account-actions" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <p className="lede" style={{ width: '100%' }}>
          A Groq key is saved:{' '}
          <strong>{`\u2022\u2022\u2022\u2022 \u2022\u2022\u2022\u2022 ${maskedLastFour ?? ''}`}</strong>
        </p>
        <button
          type="button"
          className="cta cta-secondary"
          onClick={() => {
            setEditing(true);
            setError(null);
          }}
          disabled={busy}
          data-action="replace-key"
        >
          Replace
        </button>
        <button
          type="button"
          className="cta cta-secondary"
          onClick={handleRemove}
          disabled={busy}
          data-action="remove-key"
        >
          {busy ? 'Removing\u2026' : 'Remove'}
        </button>
        {error ? (
          <p className="lede" style={{ width: '100%' }} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  // No-key / editing state: prompt + password input + Save (Req 2.3, 1.1).
  return (
    <div className="account-actions" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
      <p className="lede" style={{ width: '100%' }}>
        {keyPresent
          ? 'Enter a new Groq key to replace the one currently saved.'
          : 'Add your Groq key to enable AI features.'}
      </p>
      <input
        type="password"
        className="account-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={'gsk_\u2026'}
        autoComplete="off"
        maxLength={MAX_KEY_LENGTH}
        disabled={busy}
        aria-label="Groq API key"
        data-action="key-input"
        style={{ width: '100%' }}
      />
      <button
        type="button"
        className="cta cta-secondary"
        onClick={handleSave}
        disabled={!canSave}
        data-action="save-key"
      >
        {busy ? 'Saving\u2026' : 'Save'}
      </button>
      {keyPresent ? (
        <button
          type="button"
          className="cta cta-secondary"
          onClick={() => {
            setEditing(false);
            setValue('');
            setError(null);
          }}
          disabled={busy}
        >
          Cancel
        </button>
      ) : null}
      {error ? (
        <p className="lede" style={{ width: '100%' }} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
