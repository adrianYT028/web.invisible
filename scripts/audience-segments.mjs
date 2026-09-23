#!/usr/bin/env node
/**
 * Counts who there actually is to email, split into the groups that need
 * DIFFERENT messages. Prints counts only — no addresses — so the output is safe
 * to paste into a chat or an issue.
 *
 * The segments exist because one blast to everyone would be wrong for most of it:
 * a paying customer must not be sold what they already own, and someone who never
 * finished signing up cannot use a feature announcement.
 *
 * Usage: node scripts/audience-segments.mjs <env-file>
 */

import { readFileSync } from 'node:fs';

const envFile = process.argv[2];
if (!envFile) {
  console.error('usage: node scripts/audience-segments.mjs <env-file>');
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

async function authUsers() {
  const out = [];
  for (let page = 1; ; page += 1) {
    const body = await api(`/auth/v1/admin/users?page=${page}&per_page=1000`);
    const batch = body.users ?? [];
    out.push(...batch);
    if (batch.length < 1000) return out;
  }
}

const [users, signups, entitlements, keys] = await Promise.all([
  authUsers(),
  api('/rest/v1/signups?select=email,user_id,created_at'),
  api('/rest/v1/entitlements?select=user_id,download_access,revoked_at'),
  api('/rest/v1/user_api_keys?select=user_id'),
]);

const norm = (e) => (e ?? '').trim().toLowerCase();

const paying = new Set(
  entitlements
    .filter((e) => e.download_access === true && e.revoked_at === null)
    .map((e) => e.user_id)
);
const hasKey = new Set(keys.map((k) => k.user_id));

// An account is only reachable if it has an address AND confirmed it. Emailing an
// unconfirmed address is how a new domain earns a spam reputation: the address may
// be a typo or not belong to the person who typed it.
const confirmed = users.filter((u) => norm(u.email) && u.email_confirmed_at);
const unconfirmed = users.filter((u) => norm(u.email) && !u.email_confirmed_at);

const accountEmails = new Set(confirmed.map((u) => norm(u.email)));

const payingUsers = confirmed.filter((u) => paying.has(u.id));
const freeUsers = confirmed.filter((u) => !paying.has(u.id));

// Signups with no account behind them: they gave an address but never finished.
const signupOnly = new Set(
  signups.map((s) => norm(s.email)).filter((e) => e && !accountEmails.has(e))
);

console.log('=== reachable, by segment (send these DIFFERENT emails) ===\n');
console.log(`A. paying customers ...................... ${payingUsers.length}`);
console.log(`     already own all four services. Do NOT sell to them.`);
console.log(`     of those, have their own AI key ...... ${payingUsers.filter((u) => hasKey.has(u.id)).length}`);
console.log(`     of those, have NO key ............... ${payingUsers.filter((u) => !hasKey.has(u.id)).length}`);
console.log(`B. free accounts, confirmed .............. ${freeUsers.length}`);
console.log(`     the actual sales audience for ₹99.`);
console.log(`C. signed up, never made an account ..... ${signupOnly.size}`);
console.log(`     weakest consent. Send last, or not at all.\n`);

console.log('=== not reachable ===');
console.log(`unconfirmed email addresses ............. ${unconfirmed.length}`);
console.log(`  emailing these hurts your sending reputation. Skip them.\n`);

const total = payingUsers.length + freeUsers.length;
console.log(`TOTAL safe to email now (A + B) ......... ${total}`);
console.log(`TOTAL including C ....................... ${total + signupOnly.size}`);
console.log(`\nauth accounts overall ${users.length}, signups rows ${signups.length}`);
