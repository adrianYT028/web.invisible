import { supabaseAdmin } from '@/lib/supabase/admin';
import { logSafe } from '@/lib/http';

// -----------------------------------------------------------------------------
// Releases — private binary distribution.
//
// The installer used to be a public GitHub Releases asset whose URL shipped in
// the client bundle AND in the JSON-LD in <head> on every page. That makes any
// paywall decorative: one paying customer copies one URL and the gate is gone
// for everyone.
//
// Binaries now live in a PRIVATE Supabase Storage bucket. The object key
// (`storage_path`) never leaves the server; browsers only ever receive a signed
// URL that expires in minutes. The `releases` table has RLS with no policies,
// so even a signed-in user with the anon key cannot read the key.
//
// SETUP REQUIRED (one-time, outside this codebase):
//   1. Create a Storage bucket named `releases` with "Public bucket" OFF.
//   2. Upload the installer under a `windows/` prefix.
//   3. Insert the matching `releases` row (see docs/RELEASES.md).
//
// Deliberately no example filename here: keeping real installer names out of
// the source means a security review can grep the built output for the asset
// name and trust a zero result, instead of having to triage hits that turn out
// to be comments.
// -----------------------------------------------------------------------------

export type Platform = 'windows' | 'macos';

export const PLATFORMS: readonly Platform[] = ['windows', 'macos'] as const;

/**
 * Signed-URL lifetime. Deliberately short: long enough to survive a slow
 * client and a redirect, short enough that a URL pasted into a chat is dead
 * before anyone else clicks it. The download itself is unaffected once started
 * — expiry gates the request, not the in-flight transfer.
 */
export const SIGNED_URL_TTL_SECONDS = 300;

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/** Server-side shape. Contains the private storage key — never serialize this. */
export interface ReleaseRecord {
  id: string;
  platform: Platform;
  version: string;
  storageBucket: string;
  storagePath: string;
  fileName: string;
  fileSizeBytes: number | null;
  sha256: string | null;
  minOs: string | null;
  releaseNotes: string | null;
  publishedAt: string;
}

/** Safe-to-publish subset. No storage coordinates. */
export interface PublicReleaseMetadata {
  platform: Platform;
  version: string;
  fileName: string;
  fileSizeBytes: number | null;
  sha256: string | null;
  minOs: string | null;
  releaseNotes: string | null;
  publishedAt: string;
}

/**
 * The current release for a platform, or null if none is published.
 *
 * `releases_one_latest_per_platform_uidx` guarantees at most one row matches,
 * so this cannot silently pick between two "latest" builds.
 */
export async function getLatestRelease(
  platform: Platform
): Promise<ReleaseRecord | null> {
  // NOTE: this select list must stay a SINGLE STRING LITERAL. The Supabase
  // client infers the row type by parsing the select string as a literal type;
  // splitting it across concatenated strings defeats that inference and the
  // result degrades to `GenericStringError`, so every field access fails to
  // typecheck. Keep it on one line even though it is long.
  const { data, error } = await supabaseAdmin()
    .from('releases')
    .select('id, platform, version, storage_bucket, storage_path, file_name, file_size_bytes, sha256, min_os, release_notes, published_at')
    .eq('platform', platform)
    .eq('is_latest', true)
    .maybeSingle();

  if (error) {
    logSafe('release_lookup_failed', { platform, error: error.message });
    return null;
  }
  if (!data) return null;

  return {
    id: data.id as string,
    platform: data.platform as Platform,
    version: data.version as string,
    storageBucket: data.storage_bucket as string,
    storagePath: data.storage_path as string,
    fileName: data.file_name as string,
    fileSizeBytes: (data.file_size_bytes as number | null) ?? null,
    sha256: (data.sha256 as string | null) ?? null,
    minOs: (data.min_os as string | null) ?? null,
    releaseNotes: (data.release_notes as string | null) ?? null,
    publishedAt: data.published_at as string,
  };
}

/** Strip a `ReleaseRecord` down to what is safe to send to a client. */
export function toPublicMetadata(release: ReleaseRecord): PublicReleaseMetadata {
  return {
    platform: release.platform,
    version: release.version,
    fileName: release.fileName,
    fileSizeBytes: release.fileSizeBytes,
    sha256: release.sha256,
    minOs: release.minOs,
    releaseNotes: release.releaseNotes,
    publishedAt: release.publishedAt,
  };
}

/**
 * Mint a short-lived signed download URL.
 *
 * The `download` option makes Storage serve the object with
 * `Content-Disposition: attachment; filename="<fileName>"`, so the browser
 * saves it under the release's real name instead of the opaque object key, and
 * navigating to the URL starts a download rather than replacing the page.
 *
 * Returns null on any failure — the caller must translate that into an error
 * response, never into a fallback public URL.
 */
export async function createSignedDownloadUrl(
  release: ReleaseRecord
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .storage.from(release.storageBucket)
    .createSignedUrl(release.storagePath, SIGNED_URL_TTL_SECONDS, {
      download: release.fileName,
    });

  if (error || !data?.signedUrl) {
    logSafe('signed_url_failed', {
      platform: release.platform,
      version: release.version,
      // storage_path is intentionally omitted from logs.
      error: error?.message ?? 'no signedUrl returned',
    });
    return null;
  }

  return data.signedUrl;
}

/**
 * Record that a user fetched a build.
 *
 * Best-effort: a logging failure must never block a paid download. The value is
 * abuse detection — a lifetime license creates an obvious credential-sharing
 * incentive, and "one user_id, many IPs" is the signal that justifies revoking
 * an entitlement.
 */
export async function recordDownloadEvent(input: {
  userId: string;
  release: ReleaseRecord;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin().from('download_events').insert({
    user_id: input.userId,
    release_id: input.release.id,
    platform: input.release.platform,
    version: input.release.version,
    ip: input.ip,
    user_agent: input.userAgent?.slice(0, 500) ?? null,
  });

  if (error) {
    logSafe('download_event_insert_failed', {
      user_id: input.userId,
      platform: input.release.platform,
      error: error.message,
    });
  }
}
