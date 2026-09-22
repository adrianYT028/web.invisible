// -----------------------------------------------------------------------------
// Plan capabilities — who pays for inference
// -----------------------------------------------------------------------------
//
// `profiles.plan` is free text with no CHECK constraint (migration 001), and
// migration 009 explicitly reserves it for subscription tiers. This module is the
// single place that says what a plan is allowed to do, so adding a tier does not
// mean grepping for string comparisons across route handlers.
//
// ---------------------------------------------------------------------------
// THE TWO FUNDING MODELS, AND WHY BOTH EXIST
//
// BRING YOUR OWN KEY (`free`). The user stores their own Groq key in the vault
// (migration 008) and every request is decrypted and forwarded with it. Our
// marginal cost is zero, which is the only reason a one-time ₹99 desktop licence
// is sustainable — a perpetual licence funding perpetual inference would not be.
//
// PLATFORM FUNDED (`student_pro`). We pay, using `GROQ_API_KEY`. This is not a
// preference, it is a requirement of the product: nobody is going to create a Groq
// account and paste an API key in order to have their resume checked. Asking them
// to would collapse conversion, so the resume analyser can only exist on a plan
// where we cover inference — and a recurring cost can only be funded by recurring
// revenue, which is why this tier is a subscription rather than another one-time
// payment.
//
// Per-day caps in `feature_limits` are what bound the liability of paying for
// someone else's inference. They are not there to be stingy; they are there so a
// single shared or scripted account cannot run an unbounded bill.

/**
 * Plans where the platform pays for inference and the user needs no key of their
 * own.
 *
 * Adding a tier here is the entire change required to fund its inference — the
 * proxy reads this, not a hardcoded plan name.
 */
export const PLATFORM_FUNDED_PLANS = new Set<string>(['student_pro']);

/** The default plan for a user with no profile row, matching migration 001. */
export const DEFAULT_PLAN = 'free';

/**
 * Whether this plan's inference is paid for by us rather than by the user's own
 * vaulted key.
 *
 * When true, the proxy uses the platform key and never touches `user_api_keys` —
 * so a subscriber is never told to supply a key, and never has their own key
 * silently spent on a feature they already paid for.
 */
export function planFundsInference(plan: string | null | undefined): boolean {
  if (typeof plan !== 'string') return false;
  return PLATFORM_FUNDED_PLANS.has(plan);
}

/**
 * Plans permitted to request models flagged premium.
 *
 * An ALLOWLIST, deliberately. This was previously expressed as
 * `plan !== DEFAULT_PLAN`, which reads as "anything that is not free is
 * allowed" — meaning every plan string that ever gets written to
 * `profiles.plan` grants premium access by default, including a trial tier, a
 * lapsed/downgraded marker, or a typo in a manual DB edit. `profiles.plan` is
 * free text with no CHECK constraint, so that default was one careless UPDATE
 * away from giving away the expensive models.
 *
 * Naming the permitted plans instead makes granting premium access a decision
 * someone has to write down.
 */
export const PREMIUM_MODEL_PLANS = new Set<string>(['student_pro']);

/**
 * Whether this plan may use models flagged premium.
 *
 * Kept separate from `planFundsInference` even though both are currently true for
 * the same single tier. They answer different questions — "who is billed" versus
 * "what may be requested" — and collapsing them would mean a future
 * platform-funded tier automatically unlocked every premium model, which is not
 * the same decision.
 */
export function planAllowsPremiumModels(plan: string | null | undefined): boolean {
  if (typeof plan !== 'string') return false;
  return PREMIUM_MODEL_PLANS.has(plan);
}
