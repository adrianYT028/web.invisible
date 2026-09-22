import { describe, expect, it } from 'vitest';

import {
  PLATFORM_FUNDED_PLANS,
  PREMIUM_MODEL_PLANS,
  planAllowsPremiumModels,
  planFundsInference,
} from '@/lib/ai/plans';
import { STUDENT_PRO_PLAN } from '@/lib/payments/pricing';

import {
  BUNDLE_PLAN,
  FREE_PLAN,
  PLATFORM_SERVICES,
  SERVICE_LABELS,
  accessibleServices,
  hasPlanLapsed,
  hasServiceAccess,
  isBundlePlan,
  isPlatformService,
  planUnlocks,
  resolveEffectivePlan,
  servicesForPlan,
  type PlatformService,
} from './services';

describe('servicesForPlan', () => {
  it('grants the free plan nothing', () => {
    expect(servicesForPlan('free')).toEqual([]);
  });

  it('grants the bundle every service', () => {
    expect([...servicesForPlan(BUNDLE_PLAN)]).toEqual([...PLATFORM_SERVICES]);
  });

  // profiles.plan is free text with no CHECK constraint, so an unrecognised
  // value is reachable via a manual DB edit. It must read as "not entitled":
  // failing open here would hand the product away.
  it('fails closed on an unrecognised plan', () => {
    expect(servicesForPlan('enterprise')).toEqual([]);
    expect(servicesForPlan('student_pro_monthly')).toEqual([]);
    expect(servicesForPlan('')).toEqual([]);
  });

  it('tolerates null and undefined', () => {
    expect(servicesForPlan(null)).toEqual([]);
    expect(servicesForPlan(undefined)).toEqual([]);
  });

  it('does not let a caller mutate the shared entitlement table', () => {
    const granted = servicesForPlan(BUNDLE_PLAN) as PlatformService[];
    expect(() => granted.push('resume')).toThrow();
    // The next read must be unaffected regardless of how the push failed.
    expect([...servicesForPlan(BUNDLE_PLAN)]).toEqual([...PLATFORM_SERVICES]);
  });
});

describe('planUnlocks', () => {
  it('is false for every service on the free plan', () => {
    for (const service of PLATFORM_SERVICES) {
      expect(planUnlocks('free', service)).toBe(false);
    }
  });

  it('is true for every service on the bundle', () => {
    for (const service of PLATFORM_SERVICES) {
      expect(planUnlocks(BUNDLE_PLAN, service)).toBe(true);
    }
  });
});

describe('hasServiceAccess', () => {
  it('gives a free user with no licence nothing', () => {
    for (const service of PLATFORM_SERVICES) {
      expect(hasServiceAccess({ plan: 'free' }, service)).toBe(false);
    }
  });

  // The ₹99 one-time licence predates the subscription. Gating desktop on the
  // plan alone would revoke it and turn a paid perpetual licence into a lapsed
  // subscription.
  it('honours the legacy download licence for desktop only', () => {
    const ctx = { plan: 'free', downloadAccess: true };
    expect(hasServiceAccess(ctx, 'desktop')).toBe(true);
    expect(hasServiceAccess(ctx, 'resume')).toBe(false);
    expect(hasServiceAccess(ctx, 'jobs')).toBe(false);
    expect(hasServiceAccess(ctx, 'outreach')).toBe(false);
  });

  it('gives a subscriber desktop without a separate licence', () => {
    expect(
      hasServiceAccess({ plan: BUNDLE_PLAN, downloadAccess: false }, 'desktop')
    ).toBe(true);
    expect(hasServiceAccess({ plan: BUNDLE_PLAN }, 'desktop')).toBe(true);
  });

  it('treats a missing or falsy downloadAccess as no licence', () => {
    expect(hasServiceAccess({ plan: 'free' }, 'desktop')).toBe(false);
    expect(
      hasServiceAccess({ plan: 'free', downloadAccess: false }, 'desktop')
    ).toBe(false);
  });

  // Guards against a truthy non-boolean (a DB null, a string 'false') being
  // read as a licence.
  it('requires downloadAccess to be exactly true', () => {
    const ctx = { plan: 'free', downloadAccess: 'yes' as unknown as boolean };
    expect(hasServiceAccess(ctx, 'desktop')).toBe(false);
  });
});

describe('accessibleServices', () => {
  it('returns nothing for a free user', () => {
    expect(accessibleServices({ plan: 'free' })).toEqual([]);
  });

  it('returns every service for a subscriber, in declaration order', () => {
    expect([...accessibleServices({ plan: BUNDLE_PLAN })]).toEqual([
      ...PLATFORM_SERVICES,
    ]);
  });

  it('returns only desktop for a legacy licence holder', () => {
    expect([
      ...accessibleServices({ plan: 'free', downloadAccess: true }),
    ]).toEqual(['desktop']);
  });
});

describe('isBundlePlan', () => {
  it('identifies the bundle and nothing else', () => {
    expect(isBundlePlan(BUNDLE_PLAN)).toBe(true);
    expect(isBundlePlan('free')).toBe(false);
    expect(isBundlePlan(null)).toBe(false);
    expect(isBundlePlan(undefined)).toBe(false);
  });
});

describe('isPlatformService', () => {
  it('accepts every declared service', () => {
    for (const service of PLATFORM_SERVICES) {
      expect(isPlatformService(service)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(isPlatformService('coldmail')).toBe(false);
    expect(isPlatformService('')).toBe(false);
    expect(isPlatformService(null)).toBe(false);
    expect(isPlatformService(undefined)).toBe(false);
    expect(isPlatformService(1)).toBe(false);
    expect(isPlatformService({})).toBe(false);
  });
});

describe('SERVICE_LABELS', () => {
  // A service added without a label would render as blank in the paywall and
  // the dashboard.
  it('names every service with a non-empty label', () => {
    for (const service of PLATFORM_SERVICES) {
      expect(SERVICE_LABELS[service]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it('has no labels for services that do not exist', () => {
    expect(Object.keys(SERVICE_LABELS).sort()).toEqual(
      [...PLATFORM_SERVICES].sort()
    );
  });
});

// -----------------------------------------------------------------------------
// Cross-module invariants
// -----------------------------------------------------------------------------
//
// Three modules have to agree about the paid tier: this one decides what it
// unlocks, pricing decides what it costs, and plans decides who pays for its
// inference. If they drift, a user is charged for a plan that grants nothing, or
// granted a plan nobody is funding.

describe('paid tier agrees across modules', () => {
  it('is the same plan string pricing charges for', () => {
    expect(BUNDLE_PLAN).toBe(STUDENT_PRO_PLAN);
  });

  it('has its inference funded by the platform', () => {
    expect(PLATFORM_FUNDED_PLANS.has(BUNDLE_PLAN)).toBe(true);
    expect(planFundsInference(BUNDLE_PLAN)).toBe(true);
  });

  it('may use premium models', () => {
    expect(PREMIUM_MODEL_PLANS.has(BUNDLE_PLAN)).toBe(true);
    expect(planAllowsPremiumModels(BUNDLE_PLAN)).toBe(true);
  });

  it('leaves the free plan unfunded and without premium models', () => {
    expect(planFundsInference('free')).toBe(false);
    expect(planAllowsPremiumModels('free')).toBe(false);
  });
});

// The previous implementation was `plan !== 'free'`, so ANY new plan string
// silently unlocked the expensive models. These assert the allowlist.
describe('premium models are allowlisted, not default-allow', () => {
  it('refuses an unrecognised plan', () => {
    expect(planAllowsPremiumModels('enterprise')).toBe(false);
    expect(planAllowsPremiumModels('trial')).toBe(false);
    expect(planAllowsPremiumModels('student_pro_lapsed')).toBe(false);
    expect(planAllowsPremiumModels('')).toBe(false);
  });

  it('refuses null and undefined', () => {
    expect(planAllowsPremiumModels(null)).toBe(false);
    expect(planAllowsPremiumModels(undefined)).toBe(false);
  });

  it('grants premium only to plans that are also platform funded today', () => {
    // Not a law of the domain, but true now: a plan allowed to request premium
    // models that we are NOT funding would spend a user's own vaulted key on
    // the expensive tier without telling them.
    for (const plan of PREMIUM_MODEL_PLANS) {
      expect(planFundsInference(plan)).toBe(true);
    }
  });
});

describe('resolveEffectivePlan', () => {
  const now = new Date('2026-09-01T12:00:00Z');

  it('treats a missing plan as free', () => {
    expect(resolveEffectivePlan(null, null, now)).toBe(FREE_PLAN);
    expect(resolveEffectivePlan(undefined, null, now)).toBe(FREE_PLAN);
    expect(resolveEffectivePlan('', null, now)).toBe(FREE_PLAN);
  });

  // Every row that exists before the column is added has a null expiry, so null
  // must mean perpetual or adding the column downgrades everyone.
  it('treats a null expiry as perpetual', () => {
    expect(resolveEffectivePlan(BUNDLE_PLAN, null, now)).toBe(BUNDLE_PLAN);
    expect(resolveEffectivePlan(BUNDLE_PLAN, undefined, now)).toBe(BUNDLE_PLAN);
  });

  it('keeps a plan that expires in the future', () => {
    expect(
      resolveEffectivePlan(BUNDLE_PLAN, '2026-09-30T12:00:00Z', now)
    ).toBe(BUNDLE_PLAN);
  });

  it('drops a plan that has expired', () => {
    expect(
      resolveEffectivePlan(BUNDLE_PLAN, '2026-08-31T12:00:00Z', now)
    ).toBe(FREE_PLAN);
  });

  it('treats the exact expiry instant as lapsed', () => {
    expect(resolveEffectivePlan(BUNDLE_PLAN, now, now)).toBe(FREE_PLAN);
    expect(
      resolveEffectivePlan(BUNDLE_PLAN, new Date(now.getTime() + 1), now)
    ).toBe(BUNDLE_PLAN);
  });

  it('accepts a Date as well as a string', () => {
    expect(
      resolveEffectivePlan(BUNDLE_PLAN, new Date('2026-09-30T00:00:00Z'), now)
    ).toBe(BUNDLE_PLAN);
  });

  // A malformed timestamp read as "never expires" would be a free perpetual
  // upgrade, so it has to fail closed.
  it('fails closed on an unparseable expiry', () => {
    expect(resolveEffectivePlan(BUNDLE_PLAN, 'not-a-date', now)).toBe(FREE_PLAN);
    expect(resolveEffectivePlan(BUNDLE_PLAN, '', now)).toBe(FREE_PLAN);
  });

  it('leaves the free plan free whatever the expiry says', () => {
    expect(resolveEffectivePlan('free', '2026-08-01T00:00:00Z', now)).toBe(
      'free'
    );
    expect(resolveEffectivePlan('free', null, now)).toBe('free');
  });

  it('composes with the entitlement check', () => {
    const lapsed = resolveEffectivePlan(
      BUNDLE_PLAN,
      '2026-08-01T00:00:00Z',
      now
    );
    expect(hasServiceAccess({ plan: lapsed }, 'resume')).toBe(false);

    const active = resolveEffectivePlan(
      BUNDLE_PLAN,
      '2026-10-01T00:00:00Z',
      now
    );
    expect(hasServiceAccess({ plan: active }, 'resume')).toBe(true);
  });

  // A lapsed subscriber who also bought the ₹99 licence keeps the desktop app.
  it('leaves the legacy desktop licence intact after the plan lapses', () => {
    const lapsed = resolveEffectivePlan(
      BUNDLE_PLAN,
      '2026-08-01T00:00:00Z',
      now
    );
    const ctx = { plan: lapsed, downloadAccess: true };
    expect(hasServiceAccess(ctx, 'desktop')).toBe(true);
    expect(hasServiceAccess(ctx, 'resume')).toBe(false);
  });
});

describe('hasPlanLapsed', () => {
  const now = new Date('2026-09-01T12:00:00Z');

  it('is true only for a paid plan past its expiry', () => {
    expect(hasPlanLapsed(BUNDLE_PLAN, '2026-08-01T00:00:00Z', now)).toBe(true);
    expect(hasPlanLapsed(BUNDLE_PLAN, '2026-10-01T00:00:00Z', now)).toBe(false);
    expect(hasPlanLapsed(BUNDLE_PLAN, null, now)).toBe(false);
  });

  // A free user has not "lapsed" — there is nothing to renew, and telling them
  // their plan ended would be false.
  it('is false for a free or absent plan', () => {
    expect(hasPlanLapsed('free', '2026-08-01T00:00:00Z', now)).toBe(false);
    expect(hasPlanLapsed(null, '2026-08-01T00:00:00Z', now)).toBe(false);
    expect(hasPlanLapsed(undefined, null, now)).toBe(false);
    expect(hasPlanLapsed('', null, now)).toBe(false);
  });
});
