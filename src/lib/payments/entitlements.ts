import { supabaseAdmin } from '@/lib/supabase/admin';
import { logSafe } from '@/lib/http';
import { BUNDLE_PLAN, FREE_PLAN } from '@/lib/plans/services';

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

// -----------------------------------------------------------------------------
// The platform bundle — plan-based entitlement
// -----------------------------------------------------------------------------
//
// The bundle is recorded on `profiles.plan` rather than as another boolean on
// `entitlements`, because the plan is what the rest of the system already reads:
// `feature_limits` is keyed by plan, inference funding is decided by plan
// (src/lib/ai/plans.ts), and service access is decided by plan
// (src/lib/plans/services.ts). A second boolean would have to be kept in step
// with all three.
//
// `entitlements.download_access` stays exactly as it is. It records the one-time
// ₹99 desktop licence, which predates the bundle and is still sold separately.
// `hasServiceAccess` in src/lib/plans/services.ts is what combines the two, so a
// bundle buyer gets the desktop app WITHOUT an entitlements row and a legacy
// licence holder keeps it without a plan.

/**
 * Grant the bundle: write the paid plan, with no expiry.
 *
 * NULL `plan_expires_at` is migration 015's encoding of "perpetual", which is
 * what a one-time purchase buys. If a recurring tier is ever added, that path
 * sets an expiry instead and `resolveEffectivePlan` already handles both — this
 * function does not need to know which world it is in.
 *
 * Idempotent: an UPDATE to a fixed value converges, so the verify and webhook
 * paths racing on the same payment is a no-op rather than a double grant.
 */
export async function grantBundleAccess(
  userId: string,
  paymentId: string | null
): Promise<boolean> {
  // UPSERT, not UPDATE.
  //
  // An UPDATE silently affects zero rows when the user has no `profiles` row,
  // and reports success — so the customer pays and receives nothing, with no
  // error anywhere. That is not hypothetical: 60 of 97 accounts on this database
  // predate migration 001's `on_auth_user_created` trigger, which only fires for
  // NEW auth.users and was never backfilled. Four of those accounts have already
  // paid for something.
  //
  // Migration 018 backfills them, but this stays an upsert regardless: a grant is
  // the one operation that must not depend on another table's rows existing.
  //
  // Only the plan columns are written, so `display_name` on an existing row is
  // preserved.
  const { error } = await supabaseAdmin().from('profiles').upsert(
    {
      id: userId,
      plan: BUNDLE_PLAN,
      // Explicitly null rather than omitted: a user who previously held a
      // time-limited grant must not keep its stale expiry and lapse despite
      // having just bought perpetual access.
      plan_expires_at: null,
    },
    { onConflict: 'id' }
  );

  if (error) {
    logSafe('bundle_grant_failed', {
      user_id: userId,
      payment_row_id: paymentId,
      error: error.message,
    });
    return false;
  }

  logSafe('bundle_granted', { user_id: userId, payment_row_id: paymentId });
  return true;
}

/**
 * Grant everything the single ₹99 product buys: the perpetual desktop licence AND
 * the service plan.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH WRITES, AND WHY IT IS NOT JUST THE PLAN
 *
 * `hasServiceAccess` already treats a bundle plan as unlocking `desktop`, so on
 * paper the plan alone would be enough. It is not enough in one case that
 * matters: `plan_expires_at`. The plan is expirable by design, and the desktop
 * licence is not — it is a one-time perpetual purchase. If a future recurring
 * tier ever sets an expiry, a buyer whose plan lapsed would lose the desktop app
 * they own outright. Writing `entitlements.download_access` too means the licence
 * survives independently of the plan's lifecycle, which is what was sold.
 *
 * BOTH WRITES ARE ATTEMPTED even if the first fails, and the result is the AND of
 * the two. Returning early on the first failure would leave a customer who paid
 * holding half of what they bought, with the retry deciding which half. Both
 * underlying grants are idempotent, so the webhook retrying is safe and
 * converges.
 */
export async function grantFullAccess(
  userId: string,
  paymentId: string | null
): Promise<boolean> {
  // Not Promise.all: these hit two tables through one service-role client, and
  // sequencing keeps the failure logs in a readable order. The cost is a few ms on
  // a path that already involves a payment provider round-trip.
  const licence = await grantDownloadAccess(userId, paymentId);
  const plan = await grantBundleAccess(userId, paymentId);

  if (!licence || !plan) {
    logSafe('full_access_grant_partial', {
      user_id: userId,
      payment_row_id: paymentId,
      licence_granted: licence,
      plan_granted: plan,
    });
    return false;
  }

  return true;
}

/**
 * Reverse a full-access purchase on refund: licence revoked, plan back to free.
 *
 * Both are attempted for the same reason as the grant — a half-reversal leaves a
 * refunded customer still holding part of the product.
 */
export async function revokeFullAccess(
  userId: string,
  reason: string
): Promise<boolean> {
  const licence = await revokeDownloadAccess(userId, reason);
  const plan = await revokeBundleAccess(userId, reason);

  if (!licence || !plan) {
    logSafe('full_access_revoke_partial', {
      user_id: userId,
      reason,
      licence_revoked: licence,
      plan_revoked: plan,
    });
    return false;
  }

  return true;
}

/**
 * Revoke the bundle on refund: back to `free`.
 *
 * Clearing the expiry alongside the plan is required, not tidiness — migration
 * 015 has a CHECK that a `free` plan carries no expiry, so writing one without
 * the other is rejected by the database.
 *
 * Unlike `revokeDownloadAccess` there is no audit trail left on the row itself,
 * because `profiles` has no revocation columns. The trail is the `payments` row,
 * which is marked `refunded` with `refunded_at` before this is called.
 */
export async function revokeBundleAccess(
  userId: string,
  reason: string
): Promise<boolean> {
  const { error } = await supabaseAdmin()
    .from('profiles')
    .update({ plan: FREE_PLAN, plan_expires_at: null })
    .eq('id', userId);

  if (error) {
    logSafe('bundle_revoke_failed', {
      user_id: userId,
      reason,
      error: error.message,
    });
    return false;
  }

  logSafe('bundle_revoked', { user_id: userId, reason });
  return true;
}
