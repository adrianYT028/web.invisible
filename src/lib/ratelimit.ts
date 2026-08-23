import { env } from '@/lib/env';

// -----------------------------------------------------------------------------
// Rate limiter.
//
// Two configured windows used by the platform:
//   - 10/min per source IP for /api/desktop/exchange
//   - 60/min per refresh_token_hash for /api/desktop/refresh
//
// Backed by Vercel KV (Upstash REST) when KV_REST_API_URL/KV_REST_API_TOKEN
// are present in the environment. Falls back to a per-process in-memory
// counter for local development. The fallback is NOT effective on Vercel
// (every cold start gets a fresh counter), so production deploys MUST
// configure KV.
//
// Returns:
//   { ok: true,  remaining: N, resetSec: S } — request is allowed
//   { ok: false, remaining: 0, resetSec: S } — caller exceeded the cap
// -----------------------------------------------------------------------------

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  resetSec: number;
}

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

const memoryBuckets = new Map<string, Bucket>();

async function kvFixedWindow(
  key: string,
  limit: number,
  windowSec: number
): Promise<RateLimitResult> {
  if (!env.kvRestApiUrl || !env.kvRestApiToken) {
    return memoryFixedWindow(key, limit, windowSec);
  }

  // We use the REST API directly so we don't pull a third-party SDK for two
  // commands. INCR + EXPIRE in a pipeline is atomic enough for our purposes:
  // the EXPIRE is only set if the key was just created (count === 1).
  const url = `${env.kvRestApiUrl}/pipeline`;
  const body = JSON.stringify([
    ['INCR', key],
    ['EXPIRE', key, String(windowSec), 'NX'],
    ['TTL', key],
  ]);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.kvRestApiToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });
  } catch {
    // KV unreachable — fail open (allow the request) so an outage on KV doesn't
    // take down auth. Still record in the in-memory bucket as a backstop.
    return memoryFixedWindow(key, limit, windowSec);
  }
  if (!res.ok) return memoryFixedWindow(key, limit, windowSec);
  const data = (await res.json()) as Array<{ result: number | string }>;
  const count = Number(data[0]?.result ?? 0);
  const ttl = Number(data[2]?.result ?? windowSec);
  const resetSec = ttl > 0 ? ttl : windowSec;
  if (count > limit) {
    return { ok: false, remaining: 0, resetSec };
  }
  return { ok: true, remaining: Math.max(0, limit - count), resetSec };
}

function memoryFixedWindow(
  key: string,
  limit: number,
  windowSec: number
): RateLimitResult {
  const now = Date.now();
  const bucket = memoryBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    memoryBuckets.set(key, { count: 1, resetAt: now + windowSec * 1000 });
    return { ok: true, remaining: limit - 1, resetSec: windowSec };
  }
  bucket.count += 1;
  const resetSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  if (bucket.count > limit) {
    return { ok: false, remaining: 0, resetSec };
  }
  return { ok: true, remaining: Math.max(0, limit - bucket.count), resetSec };
}

// -----------------------------------------------------------------------------
// Public limiter functions
// -----------------------------------------------------------------------------

export async function rateLimitExchangeByIp(ip: string): Promise<RateLimitResult> {
  return kvFixedWindow(`rl:exchange:ip:${ip}`, 10, 60);
}

export async function rateLimitRefreshByHash(hash: string): Promise<RateLimitResult> {
  return kvFixedWindow(`rl:refresh:hash:${hash}`, 60, 60);
}

// 10/min per user for POST /api/keys. Throttles a signed-in user from
// brute-forcing Groq key validation through our server (design §3.3 step 3).
export async function rateLimitKeySubmitByUser(
  userId: string
): Promise<RateLimitResult> {
  return kvFixedWindow(`rl:keys:user:${userId}`, 10, 60);
}

// 10/min per user for POST /api/payments/razorpay/order. Each call hits the
// Razorpay Orders API and writes a `payments` row, so an unthrottled loop would
// both burn our API quota and litter the ledger with abandoned orders.
export async function rateLimitOrderByUser(
  userId: string
): Promise<RateLimitResult> {
  return kvFixedWindow(`rl:order:user:${userId}`, 10, 60);
}

// 30/hour per user for GET /api/download/[platform].
//
// This is anti-redistribution, not anti-abuse-of-us: signed URLs expire in
// minutes, so the way to share a paid installer is to script fresh URL
// generation and re-host them. 30/hour leaves plenty of room for genuine
// retries, resumed downloads, and a second machine, while making a
// download-farm noticeably slow. Paired with `download_events`, a user who
// sustains this cap is exactly who to investigate.
export async function rateLimitDownloadByUser(
  userId: string
): Promise<RateLimitResult> {
  return kvFixedWindow(`rl:download:user:${userId}`, 30, 3600);
}

export function getRequestIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip') ?? '0.0.0.0';
}
