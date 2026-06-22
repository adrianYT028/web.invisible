import crypto from 'node:crypto';

// -----------------------------------------------------------------------------
// Per-user key vault crypto core (AES-256-GCM)
// -----------------------------------------------------------------------------
//
// This module is the ONLY place in the codebase that reads KEY_VAULT_SECRET
// (the Master_Key set). It exposes encrypt/decrypt over a versioned
// AES-256-GCM envelope plus a `last_four` helper, all over Node's built-in
// `node:crypto` (no third-party crypto).
//
// Security invariants (see ai-proxy-key-vault requirements / properties):
//   P8  — plaintext key, ciphertext, nonce, and tag never appear in any thrown
//         error message or log line emitted from here.
//   P9  — encrypt-then-decrypt with the same Master_Key is a byte-for-byte
//         round trip.
//   P10 — every encryption draws a fresh 96-bit random IV.
//   P11 — decryption selects the Master_Key matching the row's stored version.
//   P12 — the Master_Key lives only in KEY_VAULT_SECRET (a Vercel env var),
//         never in the database.

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce — GCM-native size (NIST SP 800-38D).
const KEY_BYTES = 32; // AES-256 key length.

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** The stored envelope. All binary fields are base64 text. */
export interface KeyEnvelope {
  ciphertext: string; // base64 AES-256-GCM ciphertext (no tag appended)
  iv: string; // base64, 12 bytes decoded (Key_Nonce)
  authTag: string; // base64, 16 bytes decoded (Key_Auth_Tag)
  version: number; // >= 1, Master_Key_Version
}

/**
 * Sentinel error class so callers map cleanly to `key_decrypt_failed`. Its
 * message NEVER contains key material (Req 8.7, Req 10).
 */
export class KeyDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyDecryptError';
  }
}

// -----------------------------------------------------------------------------
// Master-key loading (memoized per process)
// -----------------------------------------------------------------------------
//
// KEY_VAULT_SECRET is a JSON object mapping version → base64-encoded 32-byte
// key, e.g. { "1": "<base64 32 bytes>", "2": "<base64 32 bytes>" }.
// KEY_VAULT_ACTIVE_VERSION names the version used for new encryptions.
//
// The parsed map is validated once (every value must decode to exactly 32
// bytes and the active version must be present) and memoized, like
// supabaseAdmin(), so JSON parsing happens once per cold start.

interface MasterKeys {
  keys: Map<number, Buffer>;
  activeVersion: number;
}

let cachedMasterKeys: MasterKeys | null = null;

function loadMasterKeys(): MasterKeys {
  if (cachedMasterKeys) return cachedMasterKeys;

  const raw = process.env.KEY_VAULT_SECRET;
  if (!raw || raw.trim().length === 0) {
    throw new Error('Missing env var: KEY_VAULT_SECRET');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('KEY_VAULT_SECRET is not valid JSON');
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      'KEY_VAULT_SECRET must be a JSON object mapping version → base64 32-byte key'
    );
  }

  const keys = new Map<number, Buffer>();
  for (const [versionStr, value] of Object.entries(parsed)) {
    const version = Number(versionStr);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(
        `KEY_VAULT_SECRET has an invalid version key: ${versionStr}`
      );
    }
    if (typeof value !== 'string') {
      throw new Error(
        `KEY_VAULT_SECRET version ${version} must be a base64 string`
      );
    }
    const keyBytes = Buffer.from(value, 'base64');
    if (keyBytes.length !== KEY_BYTES) {
      throw new Error(
        `KEY_VAULT_SECRET version ${version} must decode to exactly ${KEY_BYTES} bytes`
      );
    }
    keys.set(version, keyBytes);
  }

  if (keys.size === 0) {
    throw new Error('KEY_VAULT_SECRET must contain at least one master key');
  }

  const activeRaw = process.env.KEY_VAULT_ACTIVE_VERSION;
  const activeVersion = Number(
    activeRaw && activeRaw.trim().length > 0 ? activeRaw : '1'
  );
  if (!Number.isInteger(activeVersion) || activeVersion < 1) {
    throw new Error(
      'KEY_VAULT_ACTIVE_VERSION must be a positive integer (minimum 1)'
    );
  }
  if (!keys.has(activeVersion)) {
    throw new Error(
      `KEY_VAULT_ACTIVE_VERSION (${activeVersion}) has no corresponding key in KEY_VAULT_SECRET`
    );
  }

  cachedMasterKeys = { keys, activeVersion };
  return cachedMasterKeys;
}

// -----------------------------------------------------------------------------
// Encrypt / decrypt
// -----------------------------------------------------------------------------

/** AES-256-GCM encrypt with the ACTIVE master key. Fresh 96-bit IV per call. */
export function encrypt(plaintext: string): KeyEnvelope {
  const { keys, activeVersion } = loadMasterKeys();
  const key = keys.get(activeVersion)!; // guaranteed present by the loader
  const iv = crypto.randomBytes(IV_BYTES); // P10: fresh 96-bit nonce
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 16 bytes
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    version: activeVersion,
  };
}

/**
 * AES-256-GCM decrypt. Selects the master key matching env.version (P11).
 * Throws KeyDecryptError if the version is unknown or the auth tag fails
 * (Req 8.3, 8.4). The thrown error message NEVER contains key material.
 */
export function decrypt(env: KeyEnvelope): string {
  const { keys } = loadMasterKeys();
  const key = keys.get(env.version);
  if (!key) {
    throw new KeyDecryptError('unknown_master_key_version'); // Req 8.3
  }
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(env.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(env.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(env.ciphertext, 'base64')),
      decipher.final(), // throws on tag mismatch → Req 8.4
    ]).toString('utf8');
  } catch (err) {
    if (err instanceof KeyDecryptError) throw err;
    // Any failure here (bad IV/tag length, auth-tag mismatch) is reported as a
    // single fixed sentinel message that carries NO key material (Req 10).
    throw new KeyDecryptError('auth_tag_verification_failed');
  }
}

// -----------------------------------------------------------------------------
// Metadata helper
// -----------------------------------------------------------------------------

/** Returns the last 4 characters of the plaintext (Req 1.10, 7.2). */
export function lastFour(plaintext: string): string {
  return plaintext.slice(-4);
}
