// -----------------------------------------------------------------------------
// Service entitlement — what a plan unlocks
// -----------------------------------------------------------------------------
//
// The platform sells four things. Until now nothing in the codebase could answer
// "is this user allowed to use the resume analyser", because plan handling only
// answered a narrower question: who pays for Groq inference
// (`src/lib/ai/plans.ts`). That is a funding question, not an access question,
// and conflating the two is how `/resume`, `/jobs`, `/jobs/discover` and `/prep`
// ended up reachable by any logged-in account with nothing but a per-day cap in
// front of them.
//
// This module is the single place service access is decided. Route handlers ask
// it a question; they do not compare plan strings.
//
// ---------------------------------------------------------------------------
// WHY DESKTOP ACCESS HAS TWO SOURCES
//
// The other three services are unlocked by the subscription. The desktop app is
// not, because it was sold first and separately: a one-time ₹99 licence recorded
// as `entitlements.download_access` (migration 009). Those buyers own it
// perpetually.
//
// So desktop access is `bundle subscriber OR legacy licence holder`, and that
// disjunction lives in `hasServiceAccess` rather than in the plan table. Folding
// desktop into the plan alone would silently revoke every existing ₹99 purchase
// the moment gating went live — turning a paid perpetual licence into a lapsed
// subscription. That is a refund event and a chargeback, not a migration.
//
// ---------------------------------------------------------------------------
// WHY THE PLAN NAME IS STILL `student_pro`
//
// The bundle is not a new plan, it is the existing `student_pro` tier finally
// given a purchase path. Reusing the name means `feature_limits` already carries
// its per-day caps (migration 011: 20 uploads, 40 scans),
// `PLATFORM_FUNDED_PLANS` already funds its inference, and
// `FULL_ACCESS_PRICE` already prices it. Inventing a second name would mean
// seeding caps again and leaving a tier that grants inference funding but no
// services.

/**
 * The four things the platform sells.
 *
 * `outreach` covers the batch application flow at `/prep` — match, tailored
 * rewrite, cold-email draft and published-contact lookup. Cold mail is not a
 * separate service because it is not separately usable: a draft is generated
 * from a match report, so it only exists as the last step of a prepared item.
 */
// Frozen, not merely `as const`. `as const` is a compile-time annotation and
// leaves an ordinary mutable array at runtime, so a caller holding the value
// returned by `servicesForPlan` could `push` a service into the shared
// entitlement table and grant it to every user for the life of the process.
export const PLATFORM_SERVICES = Object.freeze([
  'resume',
  'jobs',
  'outreach',
  'desktop',
] as const);

export type PlatformService = (typeof PLATFORM_SERVICES)[number];

/**
 * Human labels, for paywall copy and the services dashboard. Kept next to the
 * identifiers so a new service cannot be added without naming it.
 */
export const SERVICE_LABELS: Record<PlatformService, string> = {
  resume: 'Resume analyser',
  jobs: 'Job openings',
  outreach: 'Auto-apply and cold mail',
  desktop: 'Unviewable desktop app',
};

/**
 * The subscription tier that unlocks everything. Must equal
 * `STUDENT_PRO_PLAN` in `src/lib/payments/pricing.ts` and be a member of
 * `PLATFORM_FUNDED_PLANS` in `src/lib/ai/plans.ts`; a test asserts both, because
 * a drift there bills someone for a plan that grants nothing.
 */
export const BUNDLE_PLAN = 'student_pro' as const;

/**
 * Which services each plan unlocks.
 *
 * An unknown plan string resolves to no services rather than throwing.
 * `profiles.plan` is free text with no CHECK constraint, so a typo in a manual
 * DB edit is possible, and the safe reading of an unrecognised plan is "not
 * entitled" — failing open here would hand the whole product away for free.
 */
const PLAN_SERVICES: Record<string, readonly PlatformService[]> = {
  free: [],
  [BUNDLE_PLAN]: PLATFORM_SERVICES,
};

/** The services a plan unlocks. Empty for `free` and for anything unrecognised. */
export function servicesForPlan(
  plan: string | null | undefined
): readonly PlatformService[] {
  if (typeof plan !== 'string') return [];
  return PLAN_SERVICES[plan] ?? [];
}

/**
 * Whether this plan alone unlocks a service.
 *
 * Prefer `hasServiceAccess` in route handlers: this function does not know about
 * the legacy desktop licence, so `planUnlocks('free', 'desktop')` is `false`
 * even for a user who paid ₹99 and owns the app.
 */
export function planUnlocks(
  plan: string | null | undefined,
  service: PlatformService
): boolean {
  return servicesForPlan(plan).includes(service);
}

/** Whether this plan is the paid bundle. */
export function isBundlePlan(plan: string | null | undefined): boolean {
  return plan === BUNDLE_PLAN;
}

/** What we know about a user when deciding access. */
export interface AccessContext {
  /** `profiles.plan`. Defaults to `free` semantics when null/absent. */
  plan: string | null | undefined;
  /**
   * `entitlements.download_access` — the one-time ₹99 desktop licence. Only
   * affects the `desktop` service.
   */
  downloadAccess?: boolean;
}

/**
 * The access question route handlers should ask.
 *
 * Combines the subscription with the legacy perpetual licence, so a ₹99 buyer
 * keeps the desktop app without a subscription, and a subscriber gets it without
 * a second purchase.
 */
export function hasServiceAccess(
  ctx: AccessContext,
  service: PlatformService
): boolean {
  if (planUnlocks(ctx.plan, service)) return true;
  // The only service with a second, non-subscription source of truth.
  if (service === 'desktop') return ctx.downloadAccess === true;
  return false;
}

/**
 * Every service the user can currently reach, for rendering the dashboard.
 * Order follows `PLATFORM_SERVICES` so the UI is stable between renders.
 */
export function accessibleServices(
  ctx: AccessContext
): readonly PlatformService[] {
  return PLATFORM_SERVICES.filter((service) => hasServiceAccess(ctx, service));
}

/** Narrowing helper for values arriving from a request or a DB column. */
export function isPlatformService(value: unknown): value is PlatformService {
  return (
    typeof value === 'string' &&
    (PLATFORM_SERVICES as readonly string[]).includes(value)
  );
}

// -----------------------------------------------------------------------------
// Plan lifecycle — a paid plan has to be able to lapse
// -----------------------------------------------------------------------------
//
// `profiles.plan` on its own has no notion of time, so a plan written once is
// held forever. That is correct for the one-time desktop licence and wrong for
// everything sold on a recurring basis: a subscriber who stops paying keeps
// platform-funded inference indefinitely, and there is no way to express "paid
// through the end of the month".
//
// Rather than introduce a second table (and with it a second source of truth
// about who is entitled to what, which is the exact problem this module was
// written to remove), the expiry lives beside the plan as
// `profiles.plan_expires_at`, and every reader resolves the pair through
// `resolveEffectivePlan`.
//
// NULL means "does not expire". That is deliberate: it is the correct reading of
// every row that exists today, so adding the column does not silently downgrade
// anyone, and a comped or grandfathered account is expressed by leaving it null.

/** The plan a user falls back to when their paid plan has lapsed. */
export const FREE_PLAN = 'free' as const;

/**
 * Resolve the plan actually in force, given its expiry.
 *
 * Call this before any entitlement decision. Reading `profiles.plan` directly is
 * a bug: it reports a lapsed subscriber as still paid.
 *
 * `now` is injectable so the boundary is testable without freezing the clock.
 *
 * The comparison is `expiresAt > now`, i.e. expiry is EXCLUSIVE — a plan whose
 * expiry has exactly arrived is already lapsed. With a timestamp this is a
 * one-instant distinction that no user can perceive, but picking a side means
 * the boundary is defined rather than accidental.
 */
export function resolveEffectivePlan(
  plan: string | null | undefined,
  expiresAt: string | Date | null | undefined,
  now: Date = new Date()
): string {
  if (typeof plan !== 'string' || plan.length === 0) return FREE_PLAN;

  // No expiry recorded: perpetual. Covers every pre-existing row.
  if (expiresAt === null || expiresAt === undefined) return plan;

  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);

  // An unparseable timestamp must not be read as "never expires" — that would
  // turn a malformed value into a free perpetual upgrade. Fail closed.
  if (Number.isNaN(expiry.getTime())) return FREE_PLAN;

  return expiry.getTime() > now.getTime() ? plan : FREE_PLAN;
}

/** Whether a paid plan has lapsed, for "your plan ended" copy. */
export function hasPlanLapsed(
  plan: string | null | undefined,
  expiresAt: string | Date | null | undefined,
  now: Date = new Date()
): boolean {
  if (typeof plan !== 'string' || plan === FREE_PLAN || plan.length === 0) {
    return false;
  }
  return resolveEffectivePlan(plan, expiresAt, now) === FREE_PLAN;
}
