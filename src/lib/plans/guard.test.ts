import { beforeEach, describe, expect, it, vi } from 'vitest';

const planState = { plan: 'free' };
const licenceState = { downloadAccess: false };
const logged: Record<string, unknown>[] = [];

vi.mock('./read-plan', () => ({
  readEffectivePlan: async () => planState.plan,
}));
vi.mock('@/lib/payments/entitlements', () => ({
  hasDownloadAccess: async () => licenceState.downloadAccess,
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/http', () => ({
  logSafe: (event: string, fields: Record<string, unknown>) => {
    logged.push({ event, ...fields });
  },
}));

import { BUNDLE_PLAN, PLATFORM_SERVICES } from './services';
import { loadAccessContext, requireService, userHasService } from './guard';

beforeEach(() => {
  planState.plan = 'free';
  licenceState.downloadAccess = false;
  logged.length = 0;
});

describe('loadAccessContext', () => {
  it('reads both the plan and the legacy licence', async () => {
    planState.plan = BUNDLE_PLAN;
    licenceState.downloadAccess = true;
    await expect(loadAccessContext('u1')).resolves.toEqual({
      plan: BUNDLE_PLAN,
      downloadAccess: true,
    });
  });
});

describe('requireService', () => {
  it('lets a bundle holder through every service', async () => {
    planState.plan = BUNDLE_PLAN;
    for (const service of PLATFORM_SERVICES) {
      await expect(requireService('u1', service)).resolves.toBeNull();
    }
  });

  it('refuses a free user with 402 payment_required', async () => {
    const res = await requireService('u1', 'jobs');
    expect(res).not.toBeNull();
    expect(res?.status).toBe(402);
    const body = (await res?.json()) as {
      code: string;
      service: string;
      message: string;
    };
    // Same code /api/download/[platform] already uses for "authenticated, well
    // formed, just unpaid" — one convention rather than two.
    expect(body.code).toBe('payment_required');
    expect(body.service).toBe('jobs');
    expect(body.message).toContain('/pricing');
  });

  // The legacy ₹99 licence must keep working, and must not leak into anything
  // else it never paid for.
  it('honours the desktop licence for desktop only', async () => {
    licenceState.downloadAccess = true;
    await expect(requireService('u1', 'desktop')).resolves.toBeNull();
    for (const service of ['resume', 'jobs', 'outreach'] as const) {
      expect(await requireService('u1', service)).not.toBeNull();
    }
  });

  it('denies a lapsed plan, since readEffectivePlan already resolved it', async () => {
    // The expiry is resolved upstream, so the guard only ever sees a plan that is
    // currently in force. A lapsed subscriber arrives here as `free`.
    planState.plan = 'free';
    expect(await requireService('u1', 'outreach')).not.toBeNull();
  });

  it('logs the denial with the plan, and never a key or token', async () => {
    await requireService('u1', 'outreach');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      event: 'service_access_denied',
      user_id: 'u1',
      service: 'outreach',
      plan: 'free',
    });
    expect(Object.keys(logged[0]).sort()).toEqual([
      'event',
      'plan',
      'service',
      'user_id',
    ]);
  });

  it('logs nothing when access is granted', async () => {
    planState.plan = BUNDLE_PLAN;
    await requireService('u1', 'jobs');
    expect(logged).toEqual([]);
  });
});

describe('userHasService', () => {
  it('mirrors requireService as a boolean, for pages', async () => {
    planState.plan = BUNDLE_PLAN;
    await expect(userHasService('u1', 'jobs')).resolves.toBe(true);
    planState.plan = 'free';
    await expect(userHasService('u1', 'jobs')).resolves.toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The resume taster
// -----------------------------------------------------------------------------
//
// Migration 011 gives the free plan one upload and one scan a day on purpose, so
// the value is visible before payment. `/resume` is therefore bounded by volume
// rather than gated, and these assert that the guard would still refuse it if a
// caller ever asked — the decision not to call it lives at the route, and is
// documented there.
describe('resume is gateable but deliberately not gated', () => {
  it('reports free users as lacking the resume service', async () => {
    expect(await userHasService('u1', 'resume')).toBe(false);
  });

  it('reports bundle holders as having it', async () => {
    planState.plan = BUNDLE_PLAN;
    expect(await userHasService('u1', 'resume')).toBe(true);
  });
});
