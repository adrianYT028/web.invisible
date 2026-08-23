import { supabaseAdmin } from '@/lib/supabase/admin';
import { logSafe } from '@/lib/http';

// -----------------------------------------------------------------------------
// Entitlements — the authority on "may this user download the installer".
//
// Reads and writes go through the SERVICE-ROLE client. `entitlements` has RLS
// with a select-own policy and deliberately NO insert/update policy, so the
// anon key cannot grant itself access even with a valid session cookie.
//
// The grant is idempotent by design. It is reached from two independent paths
// that can race and can both fire for the same payment:
//   - POST /api/payments/razorpay/webhook  (authoritative, may retry)
//   - POST /api/payments/razorpay/verify   (optimistic, for instant UI)
// Both call `grantDownloadAccess`, which upserts on the `user_id` primary key.
// A double delivery therefore converges on one row instead of erroring or
// double-granting.
// -----------------------------------------------------------------------------

export interface EntitlementState {
  downloadAccess: boolean;
  grantedAt: string | null;
  revokedAt: string | null;
}

/**
 * Whether the user may currently download.
 *
 * Fails CLOSED: any database error returns `false`. A transient Supabase
 * outage must not hand out the paid installer, and the caller surfaces a
 * retryable error rather than a download.
 */
export async function hasDownloadAccess(userId: string): Promise<boolean> {
  const state = await readEntitlement(userId);
  return state !== null && state.downloadAccess && state.revokedAt === null;
}

export async function readEntitlement(
  userId: string
): Promise<EntitlementState | null> {
  const { data, error } = await supabaseAdmin()
    .from('entitlements')
    .select('download_access, granted_at, revoked_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logSafe('entitlement_read_failed', { user_id: userId, error: error.message });
    return null;
  }
  if (!data) return null;

  return {
    downloadAccess: Boolean(data.download_access),
    grantedAt: (data.granted_at as string | null) ?? null,
    revokedAt: (data.revoked_at as string | null) ?? null,
  };
}

/**
 * Grant download access, idempotently.
 *
 * Clears `revoked_at` so a re-purchase after a refund restores access rather
 * than leaving the user paid-but-blocked. Returns true when the entitlement is
 * active afterwards.
 */
export async function grantDownloadAccess(
  userId: string,
  paymentId: string | null
): Promise<boolean> {
  const nowIso = new Date().toISOString();

  const { error } = await supabaseAdmin().from('entitlements').upsert(
    {
      user_id: userId,
      download_access: true,
      granted_by_payment_id: paymentId,
      granted_at: nowIso,
      revoked_at: null,
      revoked_reason: null,
    },
    { onConflict: 'user_id' }
  );

  if (error) {
    logSafe('entitlement_grant_failed', {
      user_id: userId,
      payment_row_id: paymentId,
      error: error.message,
    });
    return false;
  }

  logSafe('entitlement_granted', { user_id: userId, payment_row_id: paymentId });
  return true;
}

/**
 * Revoke download access — used on refund, and available for abuse response
 * when `download_events` shows one account distributing the installer.
 *
 * Does not delete the row: the audit trail of who was granted what, and why it
 * was taken away, is worth more than the row.
 */
export async function revokeDownloadAccess(
  userId: string,
  reason: string
): Promise<boolean> {
  const { error } = await supabaseAdmin()
    .from('entitlements')
    .update({
      download_access: false,
      revoked_at: new Date().toISOString(),
      revoked_reason: reason,
    })
    .eq('user_id', userId);

  if (error) {
    logSafe('entitlement_revoke_failed', {
      user_id: userId,
      reason,
      error: error.message,
    });
    return false;
  }

  logSafe('entitlement_revoked', { user_id: userId, reason });
  return true;
}
