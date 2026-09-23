'use client';

import { useMemo, useState } from 'react';

import {
  allProviders,
  endpointsFor,
  type ProviderId,
} from '@/lib/ai/providers';
import type { AiEndpoint } from '@/lib/ai/models';

/**
 * `<ApiKeyManager />` — the `/account` browser surface for the per-user key
 * vault (ai-proxy-key-vault spec), one row per AI provider.
 *
 * Security contract (Req 2.1, 2.2):
 *   This component NEVER receives or renders any character of a plaintext key
 *   beyond the `lastFour` metadata. The plaintext is typed into a
 *   `type="password"` input, POSTed once over HTTPS to `/api/keys`, and then
 *   dropped from component state. The API only ever returns `{ last_four }` on
 *   success — never ciphertext, nonce, auth tag, or the plaintext key.
 *
 * ---------------------------------------------------------------------------
 * WHY CAPABILITY IS SHOWN PER PROVIDER
 *
 * Providers are not interchangeable. OpenRouter brokers chat models and has no
 * audio transcription endpoint at all, so a user whose only key is OpenRouter
 * can ask questions and read screenshots but voice notes will fail. That is not
 * something to discover mid-interview, so each row states what its key can
 * actually do, taken from the same registry the proxy routes with
 * (`src/lib/ai/providers.ts`) rather than from copy that can drift.
 *
 * ---------------------------------------------------------------------------
 * THE DEFAULT SELECTOR
 *
 * Only rendered with two or more keys saved, because with one there is nothing
 * to choose — the proxy simply uses it. It matters when a request names a model
 * we cannot attribute to a specific provider; see src/lib/ai/model-routing.ts.
 *
 * Validates: 1.1, 2.1, 2.2, 2.3.
 */

/** Key-input bounds (Req 1.1). */
const MAX_KEY_LENGTH = 512;
const MIN_KEY_LENGTH = 1;

/** What each endpoint is called in the product, rather than in the API. */
const ENDPOINT_LABELS: Record<AiEndpoint, string> = {
  chat: 'Questions',
  vision: 'Screenshots',
  transcribe: 'Voice',
};

export interface SavedKey {
  provider: string;
  lastFour: string | null;
  isPreferred: boolean;
}

interface ApiKeyManagerProps {
  /** Keys already vaulted, one per provider. */
  saved: SavedKey[];
}

/**
 * Maps an API error `code` to a friendly inline message. Anything unrecognised
 * (including a missing code) falls back to a generic message so a raw server
 * detail is never surfaced.
 */
function messageForCode(code: string | undefined, message?: string): string {
  // The server sends a precise `message` for cases where the code alone is too
  // coarse — a key that is valid but saved under the wrong provider, say.
  if (typeof message === 'string' && message.length > 0) return message;
  switch (code) {
    case 'invalid_groq_key':
      return 'That key looks invalid.';
    case 'validation_unavailable':
      return 'Couldn\u2019t validate the key right now \u2014 try again.';
    case 'unknown_provider':
      return 'We cannot use keys from that provider yet.';
    case 'rate_limited':
      return 'Too many attempts. Wait a moment and try again.';
    default:
      return 'Something went wrong. Please try again.';
  }
}

export function ApiKeyManager({ saved }: ApiKeyManagerProps) {
  const providers = useMemo(() => allProviders(), []);

  const [keys, setKeys] = useState<SavedKey[]>(saved);
  /** Which provider's input form is open. */
  const [editing, setEditing] = useState<ProviderId | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<ProviderId | null>(null);
  const [error, setError] = useState<{ provider: ProviderId; text: string } | null>(
    null
  );

  const savedCount = keys.length;
  const trimmed = value.trim();
  const canSave =
    busy === null &&
    trimmed.length >= MIN_KEY_LENGTH &&
    trimmed.length <= MAX_KEY_LENGTH;

  function keyFor(provider: ProviderId): SavedKey | undefined {
    return keys.find((k) => k.provider === provider);
  }

  function openForm(provider: ProviderId) {
    setEditing(provider);
    setValue('');
    setError(null);
  }

  function closeForm() {
    setEditing(null);
    setValue('');
    setError(null);
  }

  async function handleSave(provider: ProviderId) {
    if (!canSave) return;
    setBusy(provider);
    setError(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: trimmed, provider }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; last_four?: string; code?: string; message?: string }
        | null;

      if (!res.ok || !json?.ok) {
        setError({ provider, text: messageForCode(json?.code, json?.message) });
        return;
      }

      // Success: reflect the new key and drop the plaintext from memory.
      setKeys((prev) => {
        const next = prev.filter((k) => k.provider !== provider);
        next.push({
          provider,
          lastFour: json.last_four ?? null,
          // A first key needs no explicit default; the proxy just uses it.
          isPreferred: prev.find((k) => k.provider === provider)?.isPreferred ?? false,
        });
        return next;
      });
      closeForm();
    } catch {
      setError({ provider, text: 'Network error. Please try again.' });
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(provider: ProviderId) {
    setBusy(provider);
    setError(null);
    try {
      const res = await fetch(`/api/keys?provider=${provider}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError({ provider, text: 'Couldn\u2019t remove the key. Please try again.' });
        return;
      }
      setKeys((prev) => prev.filter((k) => k.provider !== provider));
      if (editing === provider) closeForm();
    } catch {
      setError({ provider, text: 'Network error. Please try again.' });
    } finally {
      setBusy(null);
    }
  }

  async function handleMakeDefault(provider: ProviderId) {
    setBusy(provider);
    setError(null);
    try {
      const res = await fetch('/api/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const json = (await res.json().catch(() => null)) as
        | { ok?: boolean; code?: string; message?: string }
        | null;
      if (!res.ok || !json?.ok) {
        setError({ provider, text: messageForCode(json?.code, json?.message) });
        return;
      }
      // At most one default, so setting one clears the rest.
      setKeys((prev) =>
        prev.map((k) => ({ ...k, isPreferred: k.provider === provider }))
      );
    } catch {
      setError({ provider, text: 'Network error. Please try again.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="account-keys">
      {providers.map((provider) => {
        const existing = keyFor(provider.id);
        const isEditing = editing === provider.id;
        const isBusy = busy === provider.id;
        const rowError = error?.provider === provider.id ? error.text : null;
        const supports = endpointsFor(provider.id);

        return (
          // Layout comes from `.account-key-row` in globals.css. It used to be
          // inline here against a `--hairline` token that does not exist in this
          // stylesheet, so the divider silently fell back to the literal rgba.
          <div
            key={provider.id}
            className="account-key-row"
            data-provider={provider.id}
          >
            <p className="lede" style={{ marginBottom: '0.25rem' }}>
              <strong>{provider.label}</strong>
              {existing ? (
                <>
                  {' \u2014 '}
                  <span data-testid={`saved-${provider.id}`}>
                    {`\u2022\u2022\u2022\u2022 ${existing.lastFour ?? ''}`}
                  </span>
                  {existing.isPreferred ? <em> (default)</em> : null}
                </>
              ) : (
                <>{' \u2014 not connected'}</>
              )}
            </p>

            {/* Capability, straight from the routing registry. */}
            <p className="lede" style={{ fontSize: '0.9em', opacity: 0.8 }}>
              {`Works for: ${supports
                .map((e) => ENDPOINT_LABELS[e])
                .join(', ')}`}
              {supports.includes('transcribe') ? null : (
                <>
                  {' \u2014 '}
                  <strong>no voice transcription</strong>
                </>
              )}
            </p>

            {isEditing ? (
              // `.account-key-row .account-actions` in globals.css now owns the
              // wrap and gap.
              <div className="account-actions">
                <input
                  type="password"
                  className="account-input"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={provider.keyHint}
                  autoComplete="off"
                  maxLength={MAX_KEY_LENGTH}
                  disabled={isBusy}
                  aria-label={`${provider.label} API key`}
                  data-action="key-input"
                  style={{ width: '100%' }}
                />
                {/* PRIMARY. Save and Cancel were both `cta-secondary`, so the
                    action that completes the task looked exactly like the one that
                    abandons it. Cancel stays secondary — that is the hierarchy, not
                    a pair of equals. */}
                <button
                  type="button"
                  className="cta cta-primary"
                  onClick={() => handleSave(provider.id)}
                  disabled={!canSave}
                  data-action="save-key"
                >
                  {isBusy ? 'Saving\u2026' : 'Save'}
                </button>
                <button
                  type="button"
                  className="cta cta-secondary"
                  onClick={closeForm}
                  disabled={isBusy}
                  data-action="cancel-key"
                >
                  Cancel
                </button>
                <a
                  className="lede"
                  href={provider.consoleUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ width: '100%', fontSize: '0.9em' }}
                >
                  {`Get a ${provider.label} key \u2192`}
                </a>
              </div>
            ) : (
              // `.account-key-row .account-actions` in globals.css now owns the
              // wrap and gap.
              <div className="account-actions">
                <button
                  type="button"
                  className="cta cta-secondary"
                  onClick={() => openForm(provider.id)}
                  disabled={isBusy}
                  data-action={existing ? 'replace-key' : 'add-key'}
                >
                  {existing ? 'Replace' : 'Add key'}
                </button>
                {existing ? (
                  <button
                    type="button"
                    className="cta cta-secondary"
                    onClick={() => handleRemove(provider.id)}
                    disabled={isBusy}
                    data-action="remove-key"
                  >
                    {isBusy ? 'Removing\u2026' : 'Remove'}
                  </button>
                ) : null}
                {/* Nothing to choose with a single key. */}
                {existing && savedCount > 1 && !existing.isPreferred ? (
                  <button
                    type="button"
                    className="cta cta-secondary"
                    onClick={() => handleMakeDefault(provider.id)}
                    disabled={isBusy}
                    data-action="make-default"
                  >
                    Make default
                  </button>
                ) : null}
              </div>
            )}

            {rowError ? (
              <p className="lede" role="alert" style={{ width: '100%' }}>
                {rowError}
              </p>
            ) : null}
          </div>
        );
      })}

      {savedCount === 0 ? (
        <p className="lede" style={{ marginTop: '1rem' }}>
          Add at least one key to enable AI features.
        </p>
      ) : null}

      {savedCount > 1 && !keys.some((k) => k.isPreferred) ? (
        <p className="lede" style={{ marginTop: '1rem' }}>
          {'You have more than one key saved. Pick a default for models we ' +
            'can\u2019t match to a provider \u2014 until you do, Groq is used.'}
        </p>
      ) : null}
    </div>
  );
}
