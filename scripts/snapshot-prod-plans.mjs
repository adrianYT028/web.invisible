#!/usr/bin/env node
/**
 * Records the exact `profiles` state before migrations 018/021 touch it, so the
 * change can be reversed row by row rather than guessed at.
 *
 * Writes a JSON file holding, for every auth account: whether a `profiles` row
 * exists at all, and if so its plan and expiry. "Row absent" is the state we are
 * about to destroy for 60 accounts, and it is not recoverable from the table
 * afterwards — the row will exist. That distinction is the whole reason this
 * snapshot is a file and not a query.
 *
 * Usage:
 *   node scripts/snapshot-prod-plans.mjs <env-file> <out.json>
 */

import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';

const [, , envFile, outPath] = process.argv;
if (!envFile || !outPath) {
  console.error('usage: node scripts/snapshot-prod-plans.mjs <env-file> <out.json>');
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
const headers = { apikey: key, Authorization: `Bearer ${key}` };

async function api(path, init = {}) {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function allAuthUsers() {
  const users = [];
  for (let page = 1; ; page += 1) {
    const body = await api(`/auth/v1/admin/users?page=${page}&per_page=1000`);
    const batch = body.users ?? [];
    users.push(...batch);
    if (batch.length < 1000) return users;
  }
}

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

const [users, profiles, entitlements] = await Promise.all([
  allAuthUsers(),
  allProfiles(),
  api('/rest/v1/entitlements?select=*'),
]);

const byId = new Map(profiles.map((p) => [p.id, p]));

const snapshot = {
  takenAt: new Date().toISOString(),
  project: new URL(url).hostname.split('.')[0],
  counts: {
    authUsers: users.length,
    profileRows: profiles.length,
    entitlements: entitlements.length,
  },
  accounts: users.map((u) => {
    const p = byId.get(u.id);
    return {
      id: u.id,
      email: u.email,
      hadProfileRow: Boolean(p),
      plan: p ? p.plan : null,
      planExpiresAt: p ? p.plan_expires_at : null,
    };
  }),
  // Kept verbatim: 021 reads these to decide who gets upgraded, so a reversal
  // needs the same input it saw.
  entitlements,
};

writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);

const byPlan = profiles.reduce((a, p) => ({ ...a, [p.plan]: (a[p.plan] ?? 0) + 1 }), {});
console.log(`snapshot -> ${outPath}`);
console.log(`project      ${snapshot.project}`);
console.log(`auth users   ${users.length}`);
console.log(`profile rows ${profiles.length} (${users.length - profiles.length} accounts have none)`);
console.log(`entitlements ${entitlements.length}`);
console.log('plan counts', byPlan);
