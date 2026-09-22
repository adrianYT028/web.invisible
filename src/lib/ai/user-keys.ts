// -----------------------------------------------------------------------------
// The user key vault, per provider
// -----------------------------------------------------------------------------
//
// `user_api_keys` used to hold at most one row per user, so reading it was a
// `.maybeSingle()` with no provider filter. Migration 016 moved the primary key
// to `(user_id, provider)`, and that turns the old read into a latent fault:
// `.maybeSingle()` ERRORS when more than one row matches, so the first user to
// vault a second key would have broken their own AI proxy — not degraded it,
// errored it.
//
// This module is the only place the vault is read. Every query filters or groups
// by provider explicitly.
//
// Ciphertext never leaves here in readable form except as the return value of
// `readProviderKey`, and no function in this file logs a key, returns it inside an
// object that gets serialised, or writes it anywhere.

import { type SupabaseClient } from '@supabase/supabase-js';

import { decrypt, type KeyEnvelope } from '@/lib/crypto/key-vault';
import { logSafe } from '@/lib/http';

import { isProviderId, type ProviderId } from './providers';
import type { VaultedProvider } from './model-routing';

const TABLE = 'user_api_keys';

/**
 * Which providers this user has a key for, and which one they nominated as their
 * default.
 *
 * Selects only the routing columns — no ciphertext, no nonce, no auth tag. The
 * routing decision does not need key material, so it does not read it.
 *
 * Returns an empty list on a database error. That is the safe direction: the
 * caller reads it as "no keys vaulted" and returns `no_api_key`, which is a clear
 * message the user can act on, rather than us guessing at a provider and spending
 * the wrong key.
 */
export async function listVaultedProviders(
  admin: SupabaseClient,
  userId: string
): Promise<VaultedProvider[]> {
  const { data, error } = await admin
    .from(TABLE)
    .select('provider, is_preferred')
    .eq('user_id', userId);

  if (error) {
    logSafe('vault_list_failed', { user_id: userId, error: error.message });
    return [];
  }
  if (!Array.isArray(data)) return [];

  return data
    .map((row) => {
      const r = row as { provider?: unknown; is_preferred?: unknown };
      return {
        provider: r.provider,
        isPreferred: r.is_preferred === true,
      };
    })
    // A provider the registry does not know is a key we cannot send anywhere.
    // The database CHECK should prevent it; this is the belt to that braces.
    .filter((v): v is VaultedProvider => isProviderId(v.provider));
}

/**
 * Decrypt this user's key for one provider.
 *
 * Returns null when no key is vaulted for that provider. Throws only what
 * `decrypt` throws — a `KeyDecryptError`, which the caller maps to a 500 rather
 * than to `no_api_key`: a key that exists but cannot be decrypted is our
 * problem (a rotated or misconfigured master key), not the user's, and telling
 * them to add a key they already added would send them in a circle.
 */
export async function readProviderKey(
  admin: SupabaseClient,
  userId: string,
  provider: ProviderId
): Promise<string | null> {
  const { data, error } = await admin
    .from(TABLE)
    .select('key_ciphertext, key_nonce, key_auth_tag, key_version')
    .eq('user_id', userId)
    // The filter that makes this a single row again under the composite key.
    .eq('provider', provider)
    .maybeSingle();

  if (error) {
    logSafe('vault_read_failed', {
      user_id: userId,
      provider,
      error: error.message,
    });
    return null;
  }
  if (!data) return null;

  const row = data as {
    key_ciphertext: string;
    key_nonce: string;
    key_auth_tag: string;
    key_version: number;
  };

  const envelope: KeyEnvelope = {
    ciphertext: row.key_ciphertext,
    iv: row.key_nonce,
    authTag: row.key_auth_tag,
    version: row.key_version,
  };

  return decrypt(envelope);
}

/**
 * Set which key is the default, atomically.
 *
 * Two writes are required — clear the old flag, set the new one — and the partial
 * unique index `user_api_keys_one_preferred_per_user` means doing them in the
 * wrong order fails: setting the new flag first collides with the existing one.
 * So the clear always runs first.
 *
 * Not wrapped in a transaction because PostgREST has no transaction across two
 * requests. The failure mode of an interrupted pair is therefore "no preference
 * recorded", which the resolver handles by falling back to its priority order —
 * a safe, defined state rather than a broken one. Getting two preferred rows is
 * impossible regardless, because the index forbids it.
 */
export async function setPreferredProvider(
  admin: SupabaseClient,
  userId: string,
  provider: ProviderId
): Promise<boolean> {
  const { error: clearError } = await admin
    .from(TABLE)
    .update({ is_preferred: false })
    .eq('user_id', userId)
    .eq('is_preferred', true);

  if (clearError) {
    logSafe('vault_preference_clear_failed', {
      user_id: userId,
      provider,
      error: clearError.message,
    });
    return false;
  }

  const { error: setError } = await admin
    .from(TABLE)
    .update({ is_preferred: true })
    .eq('user_id', userId)
    .eq('provider', provider);

  if (setError) {
    logSafe('vault_preference_set_failed', {
      user_id: userId,
      provider,
      error: setError.message,
    });
    return false;
  }

  logSafe('vault_preference_set', { user_id: userId, provider });
  return true;
}
