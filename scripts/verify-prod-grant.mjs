#!/usr/bin/env node
/**
 * Independent verification that migrations 018 and 021 landed correctly.
 *
 * Deliberately NOT part of backfill-profiles.mjs. That script reports on writes it
 * performed itself, using the same in-memory data it decided them from — so a bug
 * in its own reasoning would be confirmed by its own verify step. This one reads
 * production fresh and checks the invariants from scratch.
 *
 * Usage: node scripts/verify-prod-grant.mjs <env-file>
 */

import { readFileSync } from 'node:fs';

const envFile = process.argv[2];
if (!envFile) {
  console.error('usage: node scripts/verify-prod-grant.mjs <env-file>');
  process.exit(2);
}

const env = {};
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const headers = { apikey: key, Authorization: `Bearer ${key}` };

async function api(path, extra = {}) {
  const res = await fetch(`${url}${path}`, { headers: { ...headers, ...extra } });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function paged(path) {
  const rows = [];
  const step = 1000;
  for (let from = 0; ; from += step) {
    const batch = await api(path, { Range: `${from}-${from + step - 1}` });
    rows.push(...batch);
    if (batch.length < step) return rows;
  }
}

async function authUsers() {
  const users = [];
  for (let page = 1; ; page += 1) {
    const body = await api(`/auth/v1/admin/users?page=${page}&per_page=1000`);
    const batch = body.users ?? [];
    users.push(...batch);
    if (batch.length < 1000) return users;
  }
}

const [users, profiles, entitlements, freeWithExpiry] = await Promise.all([
  authUsers(),
  paged('/rest/v1/profiles?select=id,plan,plan_expires_at&order=id'),
  api('/rest/v1/entitlements?select=user_id,download_access,revoked_at'),
  api('/rest/v1/profiles?select=id&plan=eq.free&plan_expires_at=not.is.null'),
]);

const planOf = new Map(profiles.map((r) => [r.id, r]));
const active = entitlements.filter(
  (e) => e.download_access === true && e.revoked_at === null
);

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}: ${actual} (expect ${expected})`);
}

console.log(`project ${new URL(url).hostname.split('.')[0]}\n`);

console.log('invariants');
check('auth accounts without a profiles row', users.filter((u) => !planOf.has(u.id)).length, 0);
check('profiles rows', profiles.length, users.length);
check('free plans carrying an expiry', freeWithExpiry.length, 0);
check(
  'active licences NOT on student_pro',
  active.filter((e) => planOf.get(e.user_id)?.plan !== 'student_pro').length,
  0
);
check(
  'student_pro rows carrying an expiry',
  profiles.filter((r) => r.plan === 'student_pro' && r.plan_expires_at !== null).length,
  0
);
check(
  'plan values outside {free, student_pro}',
  profiles.filter((r) => r.plan !== 'free' && r.plan !== 'student_pro').length,
  0
);

const counts = profiles.reduce((a, r) => ({ ...a, [r.plan]: (a[r.plan] ?? 0) + 1 }), {});
console.log('\nplan counts', counts);
console.log(`active licences ${active.length}`);

console.log('\nthe paying accounts, one line each');
for (const e of active) {
  const r = planOf.get(e.user_id);
  const ok = r && r.plan === 'student_pro' && r.plan_expires_at === null;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? 'OK  ' : 'FAIL'} ${e.user_id.slice(0, 8)}  ` +
      (r ? `plan=${r.plan} expires=${r.plan_expires_at}` : 'NO PROFILES ROW')
  );
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
