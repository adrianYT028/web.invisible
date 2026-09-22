#!/usr/bin/env node
/**
 * Applies migrations 018 and 021 WITHOUT a direct Postgres connection.
 *
 *   018_backfill_profiles       create the missing `profiles` rows
 *   021_grandfather_full_access put active ₹99 licence holders on the bundle plan
 *
 * We do not hold the production database password, so the SQL cannot be run as
 * written (018 reads `auth.users`, which is not in the REST schema). This script
 * reaches the same end state through service-role APIs, in the same order, with
 * the same conflict handling.
 *
 * ORDER IS LOAD-BEARING. A PostgREST PATCH against a missing row updates nothing
 * and returns 204 — success. Five of the ten licence holders have no `profiles`
 * row, so running 021 first would silently skip half of them. Phase 1 creates the
 * rows; phase 2 then upserts, so it is also correct on its own.
 *
 * Usage:
 *   node scripts/backfill-profiles.mjs <env-file>            # dry run, writes nothing
 *   node scripts/backfill-profiles.mjs <env-file> --apply    # performs the writes
 */

import { readFileSync } from 'node:fs';

const envFile = process.argv[2];
const apply = process.argv.includes('--apply');

if (!envFile) {
  console.error('usage: node scripts/backfill-profiles.mjs <env-file> [--apply]');
  process.exit(2);
}

function loadEnv(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

const env = loadEnv(envFile);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(`${envFile}: missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
  process.exit(2);
}

const headers = { apikey: key, Authorization: `Bearer ${key}` };
const project = new URL(url).hostname.split('.')[0];
const BUNDLE_PLAN = 'student_pro';

/**
 * Every fetch goes through here so a non-2xx is a crash, not a skipped step.
 *
 * The first version of this script asked for a `product` column that production
 * does not have, got a 400, and hid it behind `if (res.ok)` — so the run printed
 * a clean report with a whole check missing. A migration applier that can look
 * like it worked while doing nothing is worse than no applier.
 */
async function api(path, init = {}) {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text.length === 0 ? null : JSON.parse(text);
}

/** Paged explicitly: the admin endpoint caps a page at 1000. */
async function allAuthUsers() {
  const users = [];
  for (let page = 1; ; page += 1) {
    const body = await api(`/auth/v1/admin/users?page=${page}&per_page=1000`);
    const batch = body.users ?? [];
    users.push(...batch);
    if (batch.length < 1000) return users;
  }
}

/** Paged explicitly so we never silently stop at PostgREST's default limit. */
async function allProfiles() {
  const rows = [];
  const step = 1000;
  for (let from = 0; ; from += step) {
    const batch = await api('/rest/v1/profiles?select=id,plan,plan_expires_at&order=id', {
      headers: { Range: `${from}-${from + step - 1}` },
    });
    rows.push(...batch);
    if (batch.length < step) return rows;
  }
}

const [users, profiles, licences] = await Promise.all([
  allAuthUsers(),
  allProfiles(),
  // Matches `hasDownloadAccess`: revoked means no access, so a refunded licence
  // is not grandfathered into full platform access.
  api('/rest/v1/entitlements?select=user_id,granted_at&download_access=is.true&revoked_at=is.null'),
]);

const emailOf = new Map(users.map((u) => [u.id, u.email]));
const planOf = new Map(profiles.map((p) => [p.id, p.plan]));

console.log(`project        ${project}`);
console.log(`auth accounts  ${users.length}`);
console.log(`profiles rows  ${profiles.length}`);
console.log(`active licences ${licences.length}`);
console.log('');

// ---------------------------------------------------------------------------
// Phase 1 — migration 018
// ---------------------------------------------------------------------------
const missing = users.filter((u) => !planOf.has(u.id));
console.log(`[018] profiles rows to create: ${missing.length}`);

const licenceIds = new Set(licences.map((l) => l.user_id));
const missingAndPaid = missing.filter((u) => licenceIds.has(u.id));
console.log(`[018]   of which have paid:    ${missingAndPaid.length}`);
for (const u of missingAndPaid) console.log(`[018]     ${u.email}`);

// ---------------------------------------------------------------------------
// Phase 2 — migration 021
// ---------------------------------------------------------------------------
const toUpgrade = licences.filter((l) => planOf.get(l.user_id) !== BUNDLE_PLAN);
console.log(`[021] licence holders to put on ${BUNDLE_PLAN}: ${toUpgrade.length}`);
for (const l of toUpgrade) {
  const had = planOf.has(l.user_id) ? `plan=${planOf.get(l.user_id)}` : 'NO PROFILE ROW';
  console.log(`[021]     ${emailOf.get(l.user_id) ?? l.user_id}  (${had})`);
}

if (!apply) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------
if (missing.length > 0) {
  // `resolution=ignore-duplicates` is 018's `on conflict (id) do nothing`: if this
  // races the signup trigger, the second write is a no-op rather than a unique
  // violation that rolls back the whole batch.
  await api('/rest/v1/profiles', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(missing.map((u) => ({ id: u.id, plan: 'free' }))),
  });
  console.log(`\n[018] created ${missing.length} rows.`);
}

if (toUpgrade.length > 0) {
  // `resolution=merge-duplicates` is 021's `on conflict (id) do update`, so this is
  // correct whether or not phase 1 created the row.
  await api('/rest/v1/profiles', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(
      toUpgrade.map((l) => ({ id: l.user_id, plan: BUNDLE_PLAN, plan_expires_at: null }))
    ),
  });
  console.log(`[021] upgraded ${toUpgrade.length} accounts.`);
}

// ---------------------------------------------------------------------------
// VERIFY against the database, not against the response status
// ---------------------------------------------------------------------------
console.log('\n--- verify ---');
const after = await allProfiles();
const afterPlan = new Map(after.map((p) => [p.id, p.plan]));
let bad = 0;

const stillMissing = users.filter((u) => !afterPlan.has(u.id)).length;
console.log(`accounts with no profiles row:        ${stillMissing} (expect 0)`);
bad += stillMissing;

const notUpgraded = licences.filter((l) => afterPlan.get(l.user_id) !== BUNDLE_PLAN).length;
console.log(`active licences not on ${BUNDLE_PLAN}:  ${notUpgraded} (expect 0)`);
bad += notUpgraded;

// Nobody without an active licence may have been upgraded BY THIS RUN.
//
// Not an absolute `count == 0` check. Production already holds one hand-granted
// student_pro account with no entitlements row (the owner's own, used for
// testing), which is legitimate and none of this script's business. Asserting
// zero would have failed the run over a row it did not touch, and the natural
// reaction to a red verify on a prod migration is to start "fixing" things —
// which is how a correct run turns into an incident. So the check is a DELTA
// against the plans observed before the writes.
const preExisting = new Set(
  profiles.filter((p) => p.plan === BUNDLE_PLAN).map((p) => p.id)
);
const newlyGranted = after.filter(
  (p) => p.plan === BUNDLE_PLAN && !preExisting.has(p.id)
);
const unexpected = newlyGranted.filter((p) => !licenceIds.has(p.id));
console.log(
  `newly on ${BUNDLE_PLAN}: ${newlyGranted.length}` +
    ` (expected ${toUpgrade.length}), of which without a licence: ${unexpected.length} (expect 0)`
);
if (preExisting.size > 0) {
  console.log(
    `  (${preExisting.size} account(s) were already on ${BUNDLE_PLAN} before this run` +
      ' and were left alone)'
  );
}
bad += unexpected.length;
if (newlyGranted.length !== toUpgrade.length) {
  console.log(
    `  MISMATCH: planned ${toUpgrade.length} upgrades but ${newlyGranted.length} appeared`
  );
  bad += 1;
}

// Migration 015's `profiles_free_plan_no_expiry`.
const freeWithExpiry = after.filter((p) => p.plan === 'free' && p.plan_expires_at !== null);
console.log(`free plans carrying an expiry:        ${freeWithExpiry.length} (expect 0)`);
bad += freeWithExpiry.length;

const byPlan = after.reduce((a, p) => ({ ...a, [p.plan]: (a[p.plan] ?? 0) + 1 }), {});
console.log('plan counts', byPlan);

console.log(bad === 0 ? '\nOK' : `\nFAILED — ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
