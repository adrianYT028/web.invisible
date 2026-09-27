import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '@/lib/env';

// -----------------------------------------------------------------------------
// Signed one-click unsubscribe links
// -----------------------------------------------------------------------------
//
// The link carries the user id and an HMAC of it, so it works without signing
// in (a requirement for one-click unsubscribe) but cannot be forged to
// unsubscribe somebody else. It never expires: an unsubscribe link in a
// two-year-old email must still work.

export type UnsubscribeScope = 'reminders' | 'digest' | 'all';

const SCOPES: readonly UnsubscribeScope[] = ['reminders', 'digest', 'all'];

function sign(userId: string, scope: UnsubscribeScope): string {
  const secret = env.emailUnsubscribeSecret;
  if (!secret) throw new Error('EMAIL_UNSUBSCRIBE_SECRET is not set');
  return createHmac('sha256', secret).update(`unsub:${scope}:${userId}`).digest('base64url');
}

export function unsubscribeUrl(userId: string, scope: UnsubscribeScope): string {
  const params = new URLSearchParams({ u: userId, s: scope, t: sign(userId, scope) });
  return `${env.siteUrl.replace(/\/$/, '')}/api/email/unsubscribe?${params}`;
}

/** Returns the verified user id and scope, or null for a bad link. */
export function verifyUnsubscribe(
  params: URLSearchParams
): { userId: string; scope: UnsubscribeScope } | null {
  const userId = params.get('u') ?? '';
  const scope = params.get('s') as UnsubscribeScope;
  const token = params.get('t') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !SCOPES.includes(scope) || !token) return null;
  let expected: string;
  try {
    expected = sign(userId, scope);
  } catch {
    return null;
  }
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { userId, scope };
}
