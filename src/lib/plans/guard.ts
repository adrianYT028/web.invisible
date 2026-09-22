// -----------------------------------------------------------------------------
// Service access guard
// -----------------------------------------------------------------------------
//
// `hasServiceAccess` decides entitlement from a plan and a licence flag, but it
// needs both values fetched first, from two different tables. Doing that inline
// in each route is how one of them ends up checking the plan and forgetting the
// legacy desktop licence.
//
// So: one loader, one route-level gate, used by every service surface.
//
// ---------------------------------------------------------------------------
// WHAT IS AND IS NOT GATED
//
// `jobs`, `outreach` and `desktop` require an entitlement. `resume` deliberately
// does NOT, and that is not an oversight:
//
//   Migration 011 gives the free plan one upload and one scan per day, with the
//   stated reasoning that the value should be visible before payment and the
//   limit should be volume rather than a blurred result. Putting a hard gate in
//   front of `/resume` would delete that taster and the funnel with it.
//
//   So the resume analyser is bounded by `feature_limits` (free 1/1, paid 20/40)
//   and stays reachable. The paid tier sells volume there, and access everywhere
//   else.
//
// The cost shape supports the same split. `/jobs` and `/jobs/discover` are
// deterministic reads over a shared index with no inference at all, while `/prep`
// spends roughly 1,400 provider tokens per job. The expensive surface is the one
// that most needs the gate.

import { NextResponse } from 'next/server';

import { hasDownloadAccess } from '@/lib/payments/entitlements';
import { logSafe } from '@/lib/http';
import { supabaseAdmin } from '@/lib/supabase/admin';

import { readEffectivePlan } from './read-plan';
import {
  SERVICE_LABELS,
  hasServiceAccess,
  type PlatformService,
} from './services';

/**
 * Everything needed to decide entitlement, fetched once.
 *
 * Both inputs fail closed on a database error — `readEffectivePlan` returns the
 * free plan and `hasDownloadAccess` returns false — so an outage denies access
 * rather than granting it.
 *
 * The return type narrows `plan` to a plain `string`. `AccessContext` allows
 * null/undefined because callers may hand it a raw column value, but this loader
 * always resolves to a concrete plan name, and saying so spares every caller a
 * null check they cannot actually hit.
 */
export async function loadAccessContext(
  userId: string
): Promise<{ plan: string; downloadAccess: boolean }> {
  const admin = supabaseAdmin();
  const [plan, downloadAccess] = await Promise.all([
    readEffectivePlan(admin, userId),
    hasDownloadAccess(userId),
  ]);
  return { plan, downloadAccess };
}

/** Whether this user may use a service. For pages, which render rather than 402. */
export async function userHasService(
  userId: string,
  service: PlatformService
): Promise<boolean> {
  return hasServiceAccess(await loadAccessContext(userId), service);
}

/**
 * Route-level gate. Returns null when the caller may proceed, or the response to
 * return when they may not.
 *
 * `402 payment_required` rather than 403: the caller is authenticated and their
 * request is well formed, the only thing missing is a purchase. That is the same
 * code `/api/download/[platform]` already uses for the same situation, so clients
 * need to understand one convention rather than two.
 *
 * Gating the API and not just the page is the point. A page check alone is
 * bypassed by calling the endpoint directly, which for `/api/prep` would mean
 * spending our provider budget on someone who has not paid.
 */
export async function requireService(
  userId: string,
  service: PlatformService
): Promise<NextResponse | null> {
  const ctx = await loadAccessContext(userId);
  if (hasServiceAccess(ctx, service)) return null;

  logSafe('service_access_denied', {
    user_id: userId,
    service,
    plan: ctx.plan,
  });

  return NextResponse.json(
    {
      code: 'payment_required',
      message: `${SERVICE_LABELS[service]} needs full access. See /pricing.`,
      service,
    },
    { status: 402 }
  );
}
