import { timingSafeEqual } from 'node:crypto';

import { env } from '@/lib/env';
import { extractBearer, jsonError, logSafe } from '@/lib/http';

/**
 * Shared authentication for scheduled routes.
 *
 * Extracted from `/api/jobs/sync`, which had this inline. Duplicating a
 * constant-time secret comparison per cron route is how one of them ends up
 * using `===`, so there is one copy and every scheduled route imports it.
 *
 * ---------------------------------------------------------------------------
 * FAILS CLOSED WITHOUT A SECRET
 *
 * If `CRON_SECRET` is unset the route refuses rather than running. For the job
 * sync an open endpoint would be a denial-of-service amplifier pointed at other
 * people's APIs; for the resume reaper it would be an unauthenticated endpoint
 * that DELETES user data. Neither should ever be reachable by accident.
 */
export function requireCronSecret(
  request: Request,
  logEvent: string
): Response | null {
  const secret = env.cronSecret;
  if (!secret) {
    logSafe(`${logEvent}_no_secret`);
    return jsonError(503, 'analysis_unavailable', 'This job is not configured.');
  }

  const provided = extractBearer(request);
  if (!provided || !secretsMatch(provided, secret)) {
    return jsonError(401, 'not_authenticated');
  }
  return null;
}

/**
 * Constant-time comparison.
 *
 * `===` on a secret leaks its length and prefix through timing. The length check
 * is unavoidable — `timingSafeEqual` throws on mismatched buffers — but the
 * content comparison is what matters.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
