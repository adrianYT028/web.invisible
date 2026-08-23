import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/http';
import {
  getLatestRelease,
  isPlatform,
  toPublicMetadata,
  type Platform,
} from '@/lib/releases';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -----------------------------------------------------------------------------
// GET /api/releases/latest?platform=windows — public release metadata.
//
// Intentionally unauthenticated: version numbers, file size, checksum and
// minimum OS are marketing/verification data, not secrets. The desktop client
// will also use this for update checks, where requiring a session would be
// hostile.
//
// WHAT THIS ROUTE MUST NEVER RETURN: a download URL, or the Storage object key.
// `toPublicMetadata` strips `storagePath`/`storageBucket` from the record, and
// that is the only reason it is safe to expose this at all. The actual asset is
// only reachable through the entitlement-gated /api/download/[platform].
//
// The published `sha256` lets a user verify the installer they received matches
// what we shipped — worth having now that the binary arrives via an opaque
// expiring URL rather than a recognisable GitHub release page.
// -----------------------------------------------------------------------------

const DEFAULT_PLATFORM: Platform = 'windows';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get('platform');

  let platform: Platform;
  if (requested === null) {
    platform = DEFAULT_PLATFORM;
  } else if (isPlatform(requested)) {
    platform = requested;
  } else {
    return jsonError(404, 'release_not_found', 'Unknown platform.');
  }

  const release = await getLatestRelease(platform);
  if (!release) {
    // Expected for `macos` until that client ships.
    return jsonError(404, 'release_not_found');
  }

  return NextResponse.json(toPublicMetadata(release), {
    headers: {
      // Public, non-personalised, and changes only on release. A short CDN TTL
      // keeps the database out of the path of every update check.
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
  });
}
